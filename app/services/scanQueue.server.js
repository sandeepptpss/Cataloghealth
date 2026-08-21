import prisma from "../db.server.js";
import { unauthenticated } from "../shopify.server.js";
import { syncAndScanCatalog, syncAndScanSingleProduct, deleteLocalProduct } from "./syncEngine.server.js";
import { getPlanConfig } from "./planEngine.server.js";

/**
 * Durable scan queue + in-process worker (spec #18, #20, #22, #23).
 *
 * Webhooks and UI actions only enqueue rows in ScanJob and return immediately;
 * this worker drains them in priority order. Jobs are claimed with an atomic
 * UPDATE so several app instances can share one database without running the
 * same job twice.
 */

// Spec #22 - lower number is drained first.
export const JOB_PRIORITY = {
  WEBHOOK_PRODUCT_SCAN: 1,
  MANUAL_PRODUCT_SCAN: 2,
  MANUAL_FULL_SCAN: 3,
  SCHEDULED_SCAN: 4,
};

export const JOB_TYPE = {
  PRODUCT_SCAN: "PRODUCT_SCAN",
  PRODUCT_DELETE: "PRODUCT_DELETE",
  FULL_SCAN: "FULL_SCAN",
};

// Spec #20 - collapse a burst of updates on the same product into one scan.
const DEBOUNCE_MS = 10_000;
// Spec #23 - escalating delay between retries.
const RETRY_BACKOFF_MS = [10_000, 30_000, 60_000];
const IDLE_POLL_MS = 2_000;
// A job stuck in PROCESSING longer than this is assumed to have died with its
// worker and is returned to the queue.
const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * Enqueue a product scan, debouncing repeated updates.
 *
 * If a scan for this product is already pending its timer is pushed forward
 * rather than queueing a second scan, so ten updates in ten seconds still cost
 * one scan of the latest product version.
 */
export async function enqueueProductScan({
  storeId,
  shopifyProductId,
  priority = JOB_PRIORITY.WEBHOOK_PRODUCT_SCAN,
  scanType = "WEBHOOK",
  debounceMs = DEBOUNCE_MS,
}) {
  const runAt = new Date(Date.now() + debounceMs);

  const pending = await prisma.scanJob.findFirst({
    where: {
      storeId,
      jobType: JOB_TYPE.PRODUCT_SCAN,
      shopifyProductId,
      status: "PENDING",
    },
  });

  if (pending) {
    return prisma.scanJob.update({
      where: { id: pending.id },
      data: {
        runAt,
        // Keep the most urgent priority seen for this product.
        priority: Math.min(pending.priority, priority),
        scanType,
      },
    });
  }

  return prisma.scanJob.create({
    data: {
      storeId,
      jobType: JOB_TYPE.PRODUCT_SCAN,
      shopifyProductId,
      priority,
      scanType,
      runAt,
    },
  });
}

export async function enqueueProductDelete({ storeId, shopifyProductId }) {
  return prisma.scanJob.create({
    data: {
      storeId,
      jobType: JOB_TYPE.PRODUCT_DELETE,
      shopifyProductId,
      priority: JOB_PRIORITY.WEBHOOK_PRODUCT_SCAN,
      scanType: "WEBHOOK",
      runAt: new Date(),
    },
  });
}

/**
 * Enqueue a full catalog scan. A pending or running full scan for the store is
 * reused so double-clicking "Run scan" cannot start two catalog crawls.
 */
export async function enqueueFullScan({
  storeId,
  priority = JOB_PRIORITY.MANUAL_FULL_SCAN,
  scanType = "FULL",
}) {
  const existing = await prisma.scanJob.findFirst({
    where: {
      storeId,
      jobType: JOB_TYPE.FULL_SCAN,
      status: { in: ["PENDING", "PROCESSING"] },
    },
  });

  if (existing) return existing;

  return prisma.scanJob.create({
    data: {
      storeId,
      jobType: JOB_TYPE.FULL_SCAN,
      priority,
      scanType,
      runAt: new Date(),
    },
  });
}

// Window the plan's on-demand scan allowance is measured over.
const MANUAL_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Plan allowance for merchant-triggered full scans ("Weekly manual catalog
 * scan" on Starter, unlimited on Plus Enterprise).
 *
 * Scheduled and webhook scans are separate features and are never counted here,
 * so a store keeps its automated coverage after using up its manual scans.
 */
export async function checkManualScanAllowance(storeId, plan) {
  const planConfig = getPlanConfig(plan);
  const limit = planConfig.manualScansPerWeek;

  if (!Number.isFinite(limit)) {
    return { allowed: true, limit: null, used: 0, remaining: null };
  }

  const since = new Date(Date.now() - MANUAL_SCAN_WINDOW_MS);
  const used = await prisma.scanJob.count({
    where: {
      storeId,
      jobType: JOB_TYPE.FULL_SCAN,
      scanType: "MANUAL",
      createdAt: { gte: since },
    },
  });

  const remaining = Math.max(0, limit - used);

  return {
    allowed: remaining > 0,
    limit,
    used,
    remaining,
    message:
      remaining > 0
        ? null
        : `Your ${planConfig.name} plan includes ${limit} on-demand catalog scan(s) per 7 days and you have used ${used}. ` +
          "Automated scans continue to run; upgrade your plan for more on-demand scans.",
  };
}

function randomToken() {
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Atomically claim the highest-priority due job.
 *
 * The UPDATE ... ORDER BY ... LIMIT 1 stamps a unique token on exactly one row,
 * so two workers racing here cannot claim the same job.
 */
async function claimNextJob() {
  const token = randomToken();

  // UTC_TIMESTAMP, not NOW: Prisma stores DateTime columns in UTC, while NOW()
  // returns the MySQL server's local time. On a non-UTC server that comparison
  // makes jobs claimable hours early and defeats the debounce window.
  const claimed = await prisma.$executeRaw`
    UPDATE ScanJob
       SET status = 'PROCESSING',
           lockToken = ${token},
           lockedAt = UTC_TIMESTAMP(3),
           attempts = attempts + 1
     WHERE status = 'PENDING'
       AND runAt <= UTC_TIMESTAMP(3)
     ORDER BY priority ASC, runAt ASC
     LIMIT 1
  `;

  if (claimed === 0) return null;

  return prisma.scanJob.findFirst({ where: { lockToken: token } });
}

/** Return jobs whose worker died mid-flight to the queue. */
async function requeueStaleJobs() {
  const cutoff = new Date(Date.now() - STALE_LOCK_MS);
  await prisma.scanJob.updateMany({
    where: { status: "PROCESSING", lockedAt: { lt: cutoff } },
    data: { status: "PENDING", lockToken: null, lockedAt: null },
  });
}

async function runJob(job) {
  const store = await prisma.store.findUnique({ where: { id: job.storeId } });
  if (!store) throw new Error(`Store ${job.storeId} no longer exists`);

  if (job.jobType === JOB_TYPE.PRODUCT_DELETE) {
    // No Admin API call needed to forget a deleted product.
    await deleteLocalProduct(job.storeId, job.shopifyProductId);
    return;
  }

  // Offline access token: the request that enqueued the job is long gone.
  const { admin } = await unauthenticated.admin(store.shopDomain);

  if (job.jobType === JOB_TYPE.PRODUCT_SCAN) {
    await syncAndScanSingleProduct(admin, job.storeId, job.shopifyProductId);
    return;
  }

  if (job.jobType === JOB_TYPE.FULL_SCAN) {
    // Resume an interrupted catalog scan instead of restarting it (spec #4).
    const resumable = await prisma.catalogScan.findFirst({
      where: { storeId: job.storeId, status: { in: ["IN_PROGRESS", "FAILED"] } },
      orderBy: { startedAt: "desc" },
    });

    await syncAndScanCatalog(admin, job.storeId, job.scanType, {
      resumeScanId: resumable?.id ?? null,
    });
    return;
  }

  throw new Error(`Unknown job type ${job.jobType}`);
}

async function completeJob(job) {
  await prisma.scanJob.update({
    where: { id: job.id },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      lockToken: null,
      lastError: null,
    },
  });
}

async function failJob(job, error) {
  const message = String(error?.message ?? error).slice(0, 2000);

  if (job.attempts >= job.maxAttempts) {
    console.error(`[scanQueue] job ${job.id} permanently failed: ${message}`);
    await prisma.scanJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        lockToken: null,
        lastError: message,
      },
    });
    return;
  }

  const backoff = RETRY_BACKOFF_MS[Math.min(job.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
  console.warn(
    `[scanQueue] job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}), retrying in ${backoff / 1000}s: ${message}`,
  );

  await prisma.scanJob.update({
    where: { id: job.id },
    data: {
      status: "PENDING",
      runAt: new Date(Date.now() + backoff),
      lockToken: null,
      lockedAt: null,
      lastError: message,
    },
  });
}

/** Drain every due job. Returns how many ran. Safe to call concurrently. */
export async function drainQueue({ maxJobs = Infinity } = {}) {
  await requeueStaleJobs();

  let ran = 0;
  while (ran < maxJobs) {
    const job = await claimNextJob();
    if (!job) break;

    try {
      await runJob(job);
      await completeJob(job);
    } catch (error) {
      await failJob(job, error);
    }
    ran++;
  }

  return ran;
}

// The worker lives on the global object so Vite's dev-server module reloads
// cannot start a second copy.
const workerState = (global.__catalogHealthWorker ??= {
  started: false,
  running: false,
  timer: null,
});

async function tick() {
  if (workerState.running) return;
  workerState.running = true;
  try {
    await drainQueue();
  } catch (error) {
    console.error("[scanQueue] worker tick failed:", error);
  } finally {
    workerState.running = false;
    workerState.timer = setTimeout(tick, IDLE_POLL_MS);
    // Do not hold the event loop open on an otherwise idle process.
    workerState.timer?.unref?.();
  }
}

/**
 * Start the background worker once per process.
 *
 * Called from webhook handlers and app loaders, which is enough to keep it
 * alive on a long-running Node server. A serverless deployment should call
 * `drainQueue()` from a cron/task instead.
 */
export function ensureWorkerStarted() {
  if (!workerState.started) {
    workerState.started = true;
  }
  if (!workerState.running) {
    clearTimeout(workerState.timer);
    const timer = setTimeout(tick, 0);
    timer?.unref?.();
  }
}

export async function getQueueSnapshot(storeId) {
  const grouped = await prisma.scanJob.groupBy({
    by: ["status"],
    where: { storeId },
    _count: { _all: true },
  });

  const counts = { PENDING: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}
