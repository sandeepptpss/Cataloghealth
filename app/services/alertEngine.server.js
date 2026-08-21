import prisma from "../db.server.js";

/**
 * Merchant alerting (spec #26).
 *
 * The rule that shapes this module: never one message per issue. A store with
 * 5,000 new issues must receive one digest saying "15 critical, 120 warnings",
 * not 5,000 emails. So every alert is an aggregate over a time window, and the
 * window advances only when a digest is actually recorded.
 *
 * Delivery is deliberately left as a seam: `Notification` rows are created
 * PENDING and `deliverPendingNotifications` marks them SENT. Wire an email or
 * Slack provider into `deliverNotification` and nothing else has to change.
 */

// A critical alert is not sent more often than this, however many issues land.
const CRITICAL_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
// Issues older than this are never pulled into a first-ever digest, so enabling
// alerts on an established store does not announce its entire backlog.
const MAX_DIGEST_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Start of the window a new digest of `type` should cover: where the previous
 * digest ended, clamped to the lookback limit.
 */
async function getWindowStart(storeId, type, now) {
  const previous = await prisma.notification.findFirst({
    where: { storeId, type },
    orderBy: { windowEnd: "desc" },
    select: { windowEnd: true },
  });

  const floor = new Date(now.getTime() - MAX_DIGEST_LOOKBACK_MS);

  if (!previous) return floor;
  return previous.windowEnd < floor ? floor : previous.windowEnd;
}

async function countBySeverity(storeId, windowStart, windowEnd) {
  const grouped = await prisma.issue.groupBy({
    by: ["severity"],
    where: {
      storeId,
      status: "OPEN",
      createdAt: { gt: windowStart, lte: windowEnd },
    },
    _count: { _all: true },
  });

  const counts = { CRITICAL: 0, WARNING: 0, INFO: 0 };
  for (const row of grouped) counts[row.severity] = row._count._all;
  return counts;
}

/**
 * Build one daily digest for a store.
 *
 * Returns null when the window produced nothing: a quiet catalog should not
 * generate a "0 issues" message every day.
 */
export async function buildDailyDigest(storeId, { now = new Date() } = {}) {
  const windowStart = await getWindowStart(storeId, "DAILY_DIGEST", now);
  const counts = await countBySeverity(storeId, windowStart, now);
  const total = counts.CRITICAL + counts.WARNING + counts.INFO;

  if (total === 0) return null;

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { healthScore: true },
  });

  const parts = [];
  if (counts.CRITICAL) parts.push(`${counts.CRITICAL} critical issue(s)`);
  if (counts.WARNING) parts.push(`${counts.WARNING} warning(s)`);
  if (counts.INFO) parts.push(`${counts.INFO} info notice(s)`);

  return prisma.notification.create({
    data: {
      storeId,
      type: "DAILY_DIGEST",
      title: `Daily catalog alert: ${total} new issue(s)`,
      body: [
        `${parts.join(", ")} were detected in your catalog.`,
        `Current store health score: ${store?.healthScore ?? 100}.`,
        "Open the Catalog Health dashboard to review and resolve them.",
      ].join("\n"),
      criticalCount: counts.CRITICAL,
      warningCount: counts.WARNING,
      infoCount: counts.INFO,
      // Recording the window end is what stops the next digest from counting
      // these same issues again.
      windowEnd: now,
      status: "PENDING",
    },
  });
}

/**
 * Optional immediate alert for critical issues (spec #26).
 *
 * Still aggregated: it reports how many critical issues appeared since the last
 * critical alert, and stays silent during the cooldown so a bulk import cannot
 * turn into a notification storm.
 */
export async function notifyCriticalIfNeeded(storeId, { now = new Date() } = {}) {
  const recent = await prisma.notification.findFirst({
    where: {
      storeId,
      type: "CRITICAL_ALERT",
      createdAt: { gt: new Date(now.getTime() - CRITICAL_ALERT_COOLDOWN_MS) },
    },
  });

  if (recent) return null;

  const windowStart = await getWindowStart(storeId, "CRITICAL_ALERT", now);

  const criticalCount = await prisma.issue.count({
    where: {
      storeId,
      status: "OPEN",
      severity: "CRITICAL",
      createdAt: { gt: windowStart, lte: now },
    },
  });

  if (criticalCount === 0) return null;

  return prisma.notification.create({
    data: {
      storeId,
      type: "CRITICAL_ALERT",
      title: `${criticalCount} new critical catalog issue(s)`,
      body:
        `${criticalCount} critical issue(s) were detected in your catalog ` +
        "(missing images, invalid pricing, or duplicate SKUs). These can block " +
        "customers from buying, so review them now.",
      criticalCount,
      windowEnd: now,
      status: "PENDING",
    },
  });
}

/**
 * Hand a notification to a delivery provider.
 *
 * No email/Slack transport is configured in this app, so this logs and reports
 * success. Replace the body with a real provider call; failures should throw so
 * the row is marked FAILED rather than silently dropped.
 */
async function deliverNotification(notification) {
  console.log(
    `[alertEngine] ${notification.type} for store ${notification.storeId}: ${notification.title}`,
  );
}

/** Deliver queued notifications, marking each SENT or FAILED. */
export async function deliverPendingNotifications({ limit = 100 } = {}) {
  const pending = await prisma.notification.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let sent = 0;
  let failed = 0;

  for (const notification of pending) {
    try {
      await deliverNotification(notification);
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: "SENT", sentAt: new Date() },
      });
      sent++;
    } catch (error) {
      console.error(`[alertEngine] delivery failed for ${notification.id}:`, error);
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: "FAILED" },
      });
      failed++;
    }
  }

  return { sent, failed };
}

/**
 * Retention for the webhook idempotency log.
 *
 * WebhookEvent rows exist to reject replayed deliveries; once Shopify can no
 * longer retry an event the row is dead weight, and the table would otherwise
 * grow without bound.
 */
export async function pruneWebhookEvents({ retentionDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.webhookEvent.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return count;
}

/** Retention for finished queue rows. Pending/failed jobs are always kept. */
export async function pruneCompletedScanJobs({ retentionDays = 7 } = {}) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.scanJob.deleteMany({
    where: { status: "COMPLETED", completedAt: { lt: cutoff } },
  });
  return count;
}
