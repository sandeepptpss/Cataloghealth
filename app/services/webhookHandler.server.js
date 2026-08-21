import prisma from "../db.server.js";
import {
  enqueueProductScan,
  enqueueProductDelete,
  ensureWorkerStarted,
  JOB_PRIORITY,
} from "./scanQueue.server.js";

/**
 * Webhook intake (spec #18, #19, #20).
 *
 * This does no catalog work: it verifies idempotency, enqueues a debounced scan
 * job and returns, so Shopify always gets a fast 200. The queue worker fetches
 * the latest product version and runs the validation.
 */
export async function handleShopifyWebhook({ topic, shop, payload, eventId }) {
  // Shopify's X-Shopify-Webhook-Id is the stable per-delivery identity. Falling
  // back to a timestamp would defeat idempotency, so derive a deterministic key
  // from the payload instead.
  const resolvedEventId =
    eventId || `${topic}:${shop}:${payload?.id ?? "unknown"}:${payload?.updated_at ?? ""}`;

  const store = await prisma.store.findUnique({
    where: { shopDomain: shop },
  });

  // Claim the event: the unique index on eventId makes this the idempotency
  // gate even when Shopify delivers the same event to two instances at once.
  let webhookRecord;
  try {
    webhookRecord = await prisma.webhookEvent.create({
      data: {
        eventId: resolvedEventId,
        topic,
        storeId: store?.id || null,
        status: "PROCESSING",
        payload: JSON.stringify(payload),
      },
    });
  } catch (error) {
    if (error?.code === "P2002") {
      return { status: "ALREADY_PROCESSED" };
    }
    throw error;
  }

  try {
    if (store) {
      const shopifyProductId =
        payload?.admin_graphql_api_id ||
        (payload?.id ? `gid://shopify/Product/${payload.id}` : null);

      if (shopifyProductId) {
        if (topic === "PRODUCTS_CREATE" || topic === "PRODUCTS_UPDATE") {
          await enqueueProductScan({
            storeId: store.id,
            shopifyProductId,
            priority: JOB_PRIORITY.WEBHOOK_PRODUCT_SCAN,
            scanType: "WEBHOOK",
          });
        } else if (topic === "PRODUCTS_DELETE") {
          await enqueueProductDelete({
            storeId: store.id,
            shopifyProductId,
          });
        }
      }

      ensureWorkerStarted();
    }

    await prisma.webhookEvent.update({
      where: { id: webhookRecord.id },
      data: {
        status: "QUEUED",
        processedAt: new Date(),
      },
    });

    return { status: "QUEUED" };
  } catch (error) {
    console.error("Webhook intake error:", error);
    await prisma.webhookEvent.update({
      where: { id: webhookRecord.id },
      data: {
        status: "FAILED",
        processedAt: new Date(),
      },
    });
    // Swallow the error: the caller must still return 200 so Shopify does not
    // retry-storm us, and the failure is recorded on the webhookEvent row.
    return { status: "FAILED", error: error.message };
  }
}
