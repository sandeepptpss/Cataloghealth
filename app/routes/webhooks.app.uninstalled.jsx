import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Mark the store inactive and cancel queued work rather than deleting the
  // catalog: a reinstall keeps its issue history, and the worker must not keep
  // calling the Admin API with a revoked token.
  const store = await db.store.findUnique({ where: { shopDomain: shop } });
  if (store) {
    await db.store.update({
      where: { id: store.id },
      data: { status: "uninstalled" },
    });
    await db.scanJob.updateMany({
      where: { storeId: store.id, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "FAILED", lastError: "App uninstalled", lockToken: null },
    });
  }

  return new Response();
};
