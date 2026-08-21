import { authenticate } from "../shopify.server";
import db from "../db.server";
import { resetInventoryAccess } from "../services/syncEngine.server.js";

export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload.current;

  if (session) {
    await db.session.update({
      where: {
        id: session.id,
      },
      data: {
        scope: current.toString(),
      },
    });
  }

  // A shop that just granted read_inventory/read_locations must not stay on the
  // "cannot read inventory" cooldown from an earlier denial.
  const store = await db.store.findUnique({ where: { shopDomain: shop }, select: { id: true } });
  if (store) resetInventoryAccess(store.id);

  return new Response();
};
