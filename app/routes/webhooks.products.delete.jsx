import { authenticate } from "../shopify.server";
import { handleShopifyWebhook } from "../services/webhookHandler.server.js";

export const action = async ({ request }) => {
  const { topic, shop, payload, webhookId } = await authenticate.webhook(request);

  // Enqueue only, never scan inline: Shopify expects a fast 200 (spec #18).
  const result = await handleShopifyWebhook({
    topic,
    shop,
    payload,
    eventId: webhookId,
  });

  console.log(`Received ${topic} webhook for ${shop}: ${result.status}`);

  return new Response();
};
