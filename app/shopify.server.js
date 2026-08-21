import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server.js";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY || "dummy_api_key",
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "dummy_api_secret",
  apiVersion: ApiVersion.July26,
  scopes:
    process.env.SCOPES?.split(",") || [
      "read_products",
      "write_products",
      // Multi-location stock for the enterprise catalog sync.
      "read_inventory",
      "read_locations",
    ],
  appUrl: process.env.SHOPIFY_APP_URL || process.env.HOST || "http://localhost:3000",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    // Spec #3: on install, create the store record and queue the initial sync
    // as a background job. No catalog work happens inside the OAuth request.
    afterAuth: async ({ session }) => {
      await shopify.registerWebhooks({ session });

      // Imported lazily: the queue module imports this one for its offline
      // Admin client, so a static import here would be circular.
      const { ensureStoreRecord } = await import("./services/syncEngine.server.js");
      const { enqueueFullScan, ensureWorkerStarted, JOB_PRIORITY } = await import(
        "./services/scanQueue.server.js"
      );

      const store = await ensureStoreRecord(session.shop);

      const alreadyScanned = await prisma.catalogScan.findFirst({
        where: { storeId: store.id, status: "COMPLETED" },
      });

      if (!alreadyScanned) {
        await enqueueFullScan({
          storeId: store.id,
          scanType: "INITIAL",
          priority: JOB_PRIORITY.MANUAL_FULL_SCAN,
        });
      }

      ensureWorkerStarted();
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
