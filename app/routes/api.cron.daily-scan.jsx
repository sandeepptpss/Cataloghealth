import prisma from "../db.server.js";
import {
  enqueueFullScan,
  ensureWorkerStarted,
  JOB_PRIORITY,
} from "../services/scanQueue.server.js";
import {
  buildDailyDigest,
  deliverPendingNotifications,
  pruneCompletedScanJobs,
  pruneWebhookEvents,
} from "../services/alertEngine.server.js";
import { getPlanConfig } from "../services/planEngine.server.js";

/**
 * Scheduled catalog re-audit (spec #21).
 *
 * Webhooks can be missed, external syncs bypass them, and the Admin API has bad
 * days, so every active store is re-scanned on a schedule as a safety net. Point
 * a cron/scheduler at:
 *
 *   POST /api/cron/daily-scan   with header  Authorization: Bearer $CRON_SECRET
 *
 * The endpoint only enqueues jobs (lowest priority, so merchant-triggered work
 * always goes first) and returns immediately.
 *
 * It also runs the daily housekeeping that has nowhere else to live: build one
 * aggregated alert digest per store (spec #26) and prune the retention-bound
 * bookkeeping tables.
 */
function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // eslint-disable-next-line no-undef
  const secret = process.env.CRON_SECRET;

  // Fail closed: without a configured secret the endpoint stays shut rather
  // than letting anyone on the internet trigger scans for every store.
  if (!secret) {
    console.error("[cron] CRON_SECRET is not set; daily scan endpoint disabled");
    return unauthorized();
  }

  const header = request.headers.get("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : header;

  if (provided !== secret) {
    return unauthorized();
  }

  const stores = await prisma.store.findMany({
    where: { status: "active" },
    select: { id: true, shopDomain: true, plan: true },
  });

  const eligibleStores = stores.filter((s) => getPlanConfig(s.plan).dailyScan);

  const queued = [];
  const digests = [];
  for (const store of eligibleStores) {
    const job = await enqueueFullScan({
      storeId: store.id,
      scanType: "SCHEDULED",
      priority: JOB_PRIORITY.SCHEDULED_SCAN,
    });
    queued.push({ shop: store.shopDomain, jobId: job.id });

    // Digest covers the issues found since the previous digest, i.e. what the
    // last 24h of webhooks and scans turned up. One message per store, never
    // one per issue.
    const digest = await buildDailyDigest(store.id);
    if (digest) {
      digests.push({
        shop: store.shopDomain,
        critical: digest.criticalCount,
        warning: digest.warningCount,
        info: digest.infoCount,
      });
    }
  }

  const delivery = await deliverPendingNotifications();

  // Retention: neither table is needed indefinitely and both grow per event.
  const prunedEvents = await pruneWebhookEvents();
  const prunedJobs = await pruneCompletedScanJobs();

  ensureWorkerStarted();

  return Response.json({
    stores: stores.length,
    queued,
    digests,
    delivery,
    pruned: { webhookEvents: prunedEvents, scanJobs: prunedJobs },
  });
};

// A GET is answered with 405 rather than running anything.
export const loader = async () => new Response("Method Not Allowed", { status: 405 });
