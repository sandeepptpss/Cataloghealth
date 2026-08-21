import db from "../db.server.js";

async function getPrisma() {
  if (db && db.store) {
    return db;
  }
  const freshDbModule = await import("../db.server.js?t=" + Date.now());
  return freshDbModule.default;
}

const SEVERITY_WEIGHTS = {
  CRITICAL: 20,
  WARNING: 10,
  INFO: 3,
};

export async function syncProductIssues(storeId, productId, detectedIssues) {
  const prisma = await getPrisma();
  const existingIssues = await prisma.issue.findMany({
    where: {
      storeId,
      productId,
    },
  });

  const existingIssueMap = new Map();
  existingIssues.forEach((issue) => {
    const key = `${issue.issueType}:${issue.fieldName || ""}:${issue.variantId || ""}`;
    existingIssueMap.set(key, issue);
  });

  const processedKeys = new Set();

  for (const detected of detectedIssues) {
    const key = `${detected.issueType}:${detected.fieldName || ""}:${detected.variantId || ""}`;
    processedKeys.add(key);

    const existing = existingIssueMap.get(key);

    if (existing) {
      if (existing.status === "OPEN") {
        await prisma.issue.update({
          where: { id: existing.id },
          data: { lastSeenAt: new Date() },
        });
      } else if (existing.status === "RESOLVED") {
        await prisma.issue.update({
          where: { id: existing.id },
          data: {
            status: "OPEN",
            lastSeenAt: new Date(),
            resolvedAt: null,
          },
        });
        await prisma.issueHistory.create({
          data: {
            storeId,
            issueId: existing.id,
            previousStatus: "RESOLVED",
            newStatus: "OPEN",
            changeReason: "Issue re-detected during scan",
          },
        });
      }
    } else {
      const newIssue = await prisma.issue.create({
        data: {
          storeId,
          productId,
          variantId: detected.variantId || null,
          issueType: detected.issueType,
          fieldName: detected.fieldName || null,
          severity: detected.severity,
          title: detected.title,
          description: detected.description,
          status: "OPEN",
          lastSeenAt: new Date(),
        },
      });

      await prisma.issueHistory.create({
        data: {
          storeId,
          issueId: newIssue.id,
          previousStatus: "OPEN",
          newStatus: "OPEN",
          changeReason: "Issue initially detected",
        },
      });
    }
  }

  for (const [key, existing] of existingIssueMap.entries()) {
    if (!processedKeys.has(key) && existing.status === "OPEN") {
      await prisma.issue.update({
        where: { id: existing.id },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
        },
      });

      await prisma.issueHistory.create({
        data: {
          storeId,
          issueId: existing.id,
          previousStatus: "OPEN",
          newStatus: "RESOLVED",
          changeReason: "Validation passed on scan",
        },
      });
    }
  }

  return await calculateAndSaveHealthScores(storeId, productId);
}

export async function calculateAndSaveHealthScores(storeId, productId) {
  const prisma = await getPrisma();
  const activeIssues = await prisma.issue.findMany({
    where: {
      productId,
      status: "OPEN",
    },
  });

  let scoreDeduction = 0;
  for (const issue of activeIssues) {
    scoreDeduction += SEVERITY_WEIGHTS[issue.severity] ?? 10;
  }

  const productScore = Math.max(0, 100 - scoreDeduction);
  const hasIssues = activeIssues.length > 0;

  await prisma.product.update({
    where: { id: productId },
    data: {
      healthScore: productScore,
      hasIssues,
    },
  });

  await updateStoreHealthScore(storeId);

  return { productScore, activeIssuesCount: activeIssues.length };
}

export async function updateStoreHealthScore(storeId) {
  const prisma = await getPrisma();
  const products = await prisma.product.findMany({
    where: { storeId },
    select: { healthScore: true },
  });

  if (products.length === 0) {
    await prisma.store.update({
      where: { id: storeId },
      data: { healthScore: 100.0 },
    });
    return 100.0;
  }

  const totalScoreSum = products.reduce((acc, p) => acc + p.healthScore, 0);
  const avgProductScore = totalScoreSum / products.length;

  const criticalIssuesCount = await prisma.issue.count({
    where: {
      storeId,
      status: "OPEN",
      severity: "CRITICAL",
    },
  });

  const criticalPenalty = Math.min(30, criticalIssuesCount * 0.5);
  const finalStoreScore = Math.max(0, Math.round((avgProductScore - criticalPenalty) * 10) / 10);

  await prisma.store.update({
    where: { id: storeId },
    data: { healthScore: finalStoreScore },
  });

  return finalStoreScore;
}
