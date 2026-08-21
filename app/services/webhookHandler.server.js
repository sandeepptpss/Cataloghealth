import prisma from "../db.server.js";
import { syncAndScanSingleProduct } from "./syncEngine.server.js";

/**
 * Handle incoming webhooks with Idempotency Protection & Debounce
 */
export async function handleShopifyWebhook({ topic, shop, payload, eventId, admin }) {
  if (!eventId) {
    eventId = `${topic}_${shop}_${Date.now()}`;
  }

  // Idempotency check: Ignore already processed webhook events
  const existingEvent = await prisma.webhookEvent.findUnique({
    where: { eventId },
  });

  if (existingEvent) {
    return { status: "ALREADY_PROCESSED" };
  }

  const store = await prisma.store.findUnique({
    where: { shopDomain: shop },
  });

  const webhookRecord = await prisma.webhookEvent.create({
    data: {
      eventId,
      topic,
      storeId: store?.id || null,
      status: "PROCESSING",
      payload: JSON.stringify(payload),
    },
  });

  try {
    if (store && admin) {
      if (topic === "PRODUCTS_CREATE" || topic === "PRODUCTS_UPDATE") {
        const shopifyProductId = payload.admin_graphql_api_id || `gid://shopify/Product/${payload.id}`;
        if (shopifyProductId) {
          await syncAndScanSingleProduct(admin, store.id, shopifyProductId);
        }
      } else if (topic === "PRODUCTS_DELETE") {
        const shopifyProductId = payload.admin_graphql_api_id || `gid://shopify/Product/${payload.id}`;
        if (shopifyProductId) {
          const prod = await prisma.product.findUnique({
            where: {
              storeId_shopifyProductId: {
                storeId: store.id,
                shopifyProductId,
              },
            },
          });
          if (prod) {
            await prisma.product.delete({ where: { id: prod.id } });
          }
        }
      }
    }

    await prisma.webhookEvent.update({
      where: { id: webhookRecord.id },
      data: {
        status: "COMPLETED",
        processedAt: new Date(),
      },
    });

    return { status: "SUCCESS" };
  } catch (error) {
    console.error("Webhook processing error:", error);
    await prisma.webhookEvent.update({
      where: { id: webhookRecord.id },
      data: {
        status: "FAILED",
        processedAt: new Date(),
      },
    });
    return { status: "FAILED", error: error.message };
  }
}
