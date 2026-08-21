import prisma from "../db.server.js";
import { getPlanConfig } from "./planEngine.server.js";

/**
 * Merchant alerting (spec #26).
 *
 * The rule that shapes this module: never one message per issue. A store with
 * 5,000 new issues must receive one digest saying "15 critical, 120 warnings",
 * not 5,000 emails. So every alert is an aggregate over a time window, and the
 * window advances only when a digest is actually recorded.
 *
 * Alerting is a paid feature: digests need a plan with `emailAlerts` (Growth and
 * up) and the immediate critical alert needs `instantCriticalAlerts` (Pro and
 * up). Both gates live here rather than in the callers, so no scan path can
 * hand a free store a paid alert by forgetting to check.
 *
 * Delivery: rows are created PENDING and `deliverPendingNotifications` sends
 * them. Transport comes from the environment - ALERT_WEBHOOK_URL (any JSON
 * endpoint: Slack, Zapier, an internal mailer) or RESEND_API_KEY +
 * ALERT_FROM_EMAIL. With neither configured the row is logged and marked SENT,
 * which is the previous behaviour.
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
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { plan: true, adminEmail: true, healthScore: true },
  });

  if (!store) return null;

  // Email alert notifications start at the Growth plan.
  if (!getPlanConfig(store.plan).emailAlerts) return null;

  const windowStart = await getWindowStart(storeId, "DAILY_DIGEST", now);
  const counts = await countBySeverity(storeId, windowStart, now);
  const total = counts.CRITICAL + counts.WARNING + counts.INFO;

  if (total === 0) return null;

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
      recipient: resolveRecipient(store),
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
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { plan: true, adminEmail: true },
  });

  if (!store) return null;

  // Instant critical alerts start at the Pro Advanced plan.
  if (!getPlanConfig(store.plan).instantCriticalAlerts) return null;

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
      recipient: resolveRecipient(store),
      windowEnd: now,
      status: "PENDING",
    },
  });
}

/** Where a store's alerts go: its own contact address, else the app owner. */
function resolveRecipient(store) {
  return store?.adminEmail || process.env.ADMIN_EMAIL || null;
}

/**
 * Hand a notification to a delivery provider.
 *
 * Failures throw so the row is marked FAILED rather than silently dropped.
 */
async function deliverNotification(notification) {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || process.env.ALERT_FROM_EMAIL;
  const to = notification.recipient || process.env.ADMIN_EMAIL;

  if (webhookUrl) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: notification.type,
        storeId: notification.storeId,
        recipient: to,
        title: notification.title,
        body: notification.body,
        criticalCount: notification.criticalCount,
        warningCount: notification.warningCount,
        infoCount: notification.infoCount,
      }),
    });

    if (!response.ok) {
      throw new Error(`alert webhook responded ${response.status}`);
    }
    return;
  }

  if (resendKey && fromEmail) {
    if (!to) {
      throw new Error("no recipient address for this store");
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject: notification.title,
        text: notification.body,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`email provider responded ${response.status} ${detail}`.trim());
    }
    return;
  }

  // No transport configured: keep the audit trail instead of failing the scan.
  console.log(
    `[alertEngine] ${notification.type} for store ${notification.storeId} -> ${to || "no recipient"}: ${notification.title} (no delivery provider configured)`,
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
