import prisma from "../db.server.js";
import { normalizeSku, validateProductData } from "./validationEngine.server.js";
import { syncProductIssues, updateStoreHealthScore } from "./issueEngine.server.js";
import { notifyCriticalIfNeeded, deliverPendingNotifications } from "./alertEngine.server.js";
import { getPlanConfig } from "./planEngine.server.js";

// Products fetched per Admin API page. Kept modest because each node also pulls
// variants, media and metafields, and the GraphQL cost budget is shared.
const PRODUCTS_PAGE_SIZE = 10;
// Local products revalidated per batch during the validation pass.
const VALIDATION_BATCH_SIZE = 200;
// Max other products revalidated when a SKU stops/starts being a duplicate.
const DUPLICATE_FANOUT_LIMIT = 50;

// Per-location stock, requested only for plans that include Multi-Location
// Catalog Sync. It needs read_inventory/read_locations, so it is never asked
// for on a plan that does not use it.
const INVENTORY_LEVEL_FIELDS = `#graphql
      inventoryItem {
        id
        inventoryLevels(first: 10) {
          nodes {
            id
            location {
              id
              name
            }
            quantities(names: ["available"]) {
              name
              quantity
            }
          }
        }
      }
`;

function productFields(includeInventory) {
  return `#graphql
  id
  title
  handle
  descriptionHtml
  vendor
  productType
  status
  media(first: 20) {
    nodes {
      id
      mediaContentType
    }
  }
  variants(first: 50) {
    nodes {
      id
      title
      sku
      barcode
      price
      compareAtPrice
      inventoryQuantity
      ${includeInventory ? INVENTORY_LEVEL_FIELDS : ""}
    }
  }
  metafields(first: 25) {
    nodes {
      id
      namespace
      key
      value
      type
    }
  }
  collections(first: 20) {
    nodes {
      id
      handle
      title
    }
  }
`;
}

export function productsQuery(includeInventory) {
  return `#graphql
  query getCatalogProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          ${productFields(includeInventory)}
        }
      }
    }
  }
`;
}

export function singleProductQuery(includeInventory) {
  return `#graphql
  query getSingleProduct($id: ID!) {
    product(id: $id) {
      ${productFields(includeInventory)}
    }
  }
`;
}


/**
 * Rate-limit aware Admin API call (spec #23).
 *
 * Shopify signals throttling with a THROTTLED error extension (GraphQL) or a
 * 429/5xx status. Those are retried with the escalating delays from the spec;
 * every other error is a permanent failure and is rethrown immediately so the
 * caller does not burn its retry budget on a malformed query.
 */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function graphqlWithRetry(admin, query, options = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      console.warn(
        `[syncEngine] Shopify API throttled/unavailable, retry ${attempt} in ${delay / 1000}s`,
      );
      await sleep(delay);
    }

    let response;
    try {
      response = await admin.graphql(query, options);
    } catch (error) {
      // The client throws on non-2xx. Only throttling and transient server
      // errors are worth retrying.
      const status = error?.response?.status ?? error?.status;
      if (status === 429 || (status >= 500 && status < 600)) {
        lastError = error;
        continue;
      }
      throw error;
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`Shopify API responded ${response.status}`);
      continue;
    }

    const json = await response.json();
    const throttled = (json.errors || []).some(
      (e) => e?.extensions?.code === "THROTTLED",
    );

    if (throttled) {
      lastError = new Error("Shopify API throttled");
      continue;
    }

    if (json.errors?.length) {
      throw new Error(
        `Shopify GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }

    return json;
  }

  throw lastError ?? new Error("Shopify API request failed");
}

/**
 * Per-location stock needs read_inventory/read_locations. An app installed
 * before those scopes were requested still has a valid token, so the first
 * enterprise sync after the upgrade would fail on an access-denied error and
 * take the whole scan with it. Instead the store is remembered as
 * inventory-less and every later query for it skips those fields until the
 * merchant re-authorises.
 */
const inventoryUnavailableStores = new Map();
// The grant can arrive at any time, so the skip is a cooldown rather than a
// permanent decision: without it a long-running process would keep skipping
// inventory for the rest of its life after one denial.
const INVENTORY_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Forget a store's inventory denial so the next sync tries the fields again.
 * Called when the shop's scopes change (see webhooks/app/scopes_update).
 */
export function resetInventoryAccess(storeId) {
  inventoryUnavailableStores.delete(storeId);
}

function isInventoryAccessError(error) {
  const message = String(error?.message ?? error).toLowerCase();
  return (
    message.includes("access denied") ||
    message.includes("read_inventory") ||
    message.includes("read_locations") ||
    message.includes("required access") ||
    message.includes("not approved to access")
  );
}

/** True when this store should be queried with the inventory fields. */
function shouldSyncInventory(storeId, planConfig) {
  if (!planConfig?.multiLocation) return false;

  const deniedAt = inventoryUnavailableStores.get(storeId);
  if (deniedAt !== undefined) {
    if (Date.now() - deniedAt < INVENTORY_RETRY_AFTER_MS) return false;
    inventoryUnavailableStores.delete(storeId);
  }

  // The generated Prisma client needs the InventoryLevel model; without it the
  // sync would throw on every product.
  if (!prisma.inventoryLevel) {
    console.warn(
      "[syncEngine] InventoryLevel model missing from the Prisma client - run `prisma generate`; multi-location sync is disabled",
    );
    return false;
  }
  return true;
}

/**
 * Run an Admin API query that may include inventory fields, retrying without
 * them if the shop's token does not carry the inventory scopes.
 */
async function graphqlWithInventoryFallback(admin, storeId, buildQuery, options, wantInventory) {
  try {
    return {
      json: await graphqlWithRetry(admin, buildQuery(wantInventory), options),
      usedInventory: wantInventory,
    };
  } catch (error) {
    if (!wantInventory || !isInventoryAccessError(error)) throw error;

    inventoryUnavailableStores.set(storeId, Date.now());
    console.warn(
      `[syncEngine] store ${storeId} cannot read inventory levels (${error.message}); ` +
        "multi-location sync needs the read_inventory and read_locations scopes granted on re-install",
    );

    return {
      json: await graphqlWithRetry(admin, buildQuery(false), options),
      usedInventory: false,
    };
  }
}

export async function ensureStoreRecord(shopDomain) {
  let store = await prisma.store.findUnique({
    where: { shopDomain },
  });

  if (!store) {
    store = await prisma.store.create({
      data: {
        shopDomain,
        healthScore: 100.0,
        status: "active",
      },
    });
  } else if (store.status !== "active") {
    // Re-install: reactivate rather than orphaning the existing catalog data.
    store = await prisma.store.update({
      where: { id: store.id },
      data: { status: "active" },
    });
  }

  // Ensure default validation rules exist for this store
  const existingRulesCount = await prisma.validationRule.count({
    where: { storeId: store.id },
  });

  if (existingRulesCount === 0) {
    await prisma.validationRule.createMany({
      data: [
        {
          storeId: store.id,
          name: "Standard Catalog Audit Rule",
          description: "Default rule for SKU, Price, Description, and Images validation",
          priority: 10,
          isEnabled: true,
          scopeType: "ALL",
          minImages: 1,
          checkPrices: true,
          checkSku: true,
          checkBarcode: false,
          checkDescription: true,
        },
        {
          storeId: store.id,
          name: "High Priority Image & Price Rule",
          description: "Strict checks for product imagery and active non-zero pricing",
          priority: 5,
          isEnabled: true,
          scopeType: "ALL",
          minImages: 1,
          checkPrices: true,
          checkSku: true,
          checkBarcode: false,
          checkDescription: true,
        },
      ],
    });
  }

  return store;
}

/**
 * Full catalog sync + scan, processed in batches with resumable progress.
 *
 * Pass 1 pages through the Admin API and upserts products/variants/metafields,
 * saving the cursor after every batch so a crashed run resumes where it left
 * off (spec #4). Pass 2 revalidates the local catalog in batches, so neither
 * pass ever holds the whole catalog in memory.
 */
export async function syncAndScanCatalog(admin, storeId, scanType = "FULL", options = {}) {
  const { resumeScanId = null } = options;

  let scan;
  if (resumeScanId) {
    scan = await prisma.catalogScan.findFirst({
      where: { id: resumeScanId, storeId },
    });
  }

  if (scan) {
    scan = await prisma.catalogScan.update({
      where: { id: scan.id },
      data: { status: "IN_PROGRESS" },
    });
  } else {
    scan = await prisma.catalogScan.create({
      data: {
        storeId,
        scanType,
        status: "IN_PROGRESS",
        startedAt: new Date(),
      },
    });
  }

  try {
    let hasNextPage = true;
    // Resume from the last saved cursor so a restarted worker continues from
    // its last position instead of rescanning the whole catalog.
    let endCursor = scan.lastCursor || null;
    let processedProducts = scan.processedProducts || 0;
    let failedProducts = scan.failedProducts || 0;
    // Set when the catalog is bigger than the plan allows, so the UI can say
    // why the audit covers only part of the catalog instead of implying the
    // rest is healthy.
    let planLimited = scan.planLimited || false;

    const store = await prisma.store.findUnique({ where: { id: storeId } });
    const planConfig = getPlanConfig(store?.plan);
    const maxProducts = planConfig.maxProducts;
    const syncInventory = shouldSyncInventory(storeId, planConfig);

    const rules = await prisma.validationRule.findMany({
      where: { storeId, isEnabled: true },
    });

    // ---- Pass 1: sync catalog data from Shopify, batch by batch ----
    while (hasNextPage && processedProducts < maxProducts) {
      const remainingLimit = maxProducts - processedProducts;
      const fetchCount = Math.min(PRODUCTS_PAGE_SIZE, remainingLimit);

      const { json, usedInventory } = await graphqlWithInventoryFallback(
        admin,
        storeId,
        productsQuery,
        {
          variables: {
            first: fetchCount,
            after: endCursor,
          },
        },
        syncInventory,
      );

      const productsData = json.data?.products;
      if (!productsData) break;

      for (const edge of productsData.edges || []) {
        if (processedProducts >= maxProducts) {
          planLimited = true;
          hasNextPage = false;
          break;
        }
        const p = edge.node;
        try {
          await upsertProductRecord(storeId, p, { syncInventory: usedInventory });
          processedProducts++;
        } catch (err) {
          console.error("Error upserting product:", err);
          failedProducts++;
        }
      }

      hasNextPage = productsData.pageInfo.hasNextPage;
      endCursor = productsData.pageInfo.endCursor;

      // Progress is saved after every successful batch so the scan is resumable
      // and the UI can show live counts.
      await prisma.catalogScan.update({
        where: { id: scan.id },
        data: {
          processedProducts,
          failedProducts,
          totalProducts: processedProducts,
          planLimited,
          lastCursor: endCursor,
        },
      });
    }

    // Stopping on the page boundary is the same truncation as stopping inside a
    // page: there is more catalog than the plan audits.
    if (hasNextPage && processedProducts >= maxProducts) planLimited = true;

    // ---- Pass 2: revalidate the local catalog in batches ----
    let cursorId = null;
    for (;;) {
      const batch = await prisma.product.findMany({
        where: { storeId },
        include: { variants: true, metafields: true, collections: true },
        orderBy: { id: "asc" },
        take: VALIDATION_BATCH_SIZE,
        ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
      });

      if (batch.length === 0) break;

      const skuCountMap = await getSkuCountsForProducts(storeId, batch);
      const inventoryLevels = await getInventoryLevelsForProducts(
        storeId,
        batch,
        planConfig,
      );

      for (const prod of batch) {
        const detectedIssues = validateProductData({
          product: prod,
          variants: prod.variants,
          metafields: prod.metafields,
          collections: prod.collections,
          inventoryLevels,
          rules,
          skuCountMap,
          storePlan: store?.plan || "free",
        });

        // The store score is recomputed once after the loop instead of once per
        // product.
        await syncProductIssues(storeId, prod.id, detectedIssues, {
          updateStoreScore: false,
        });
      }

      cursorId = batch[batch.length - 1].id;
      if (batch.length < VALIDATION_BATCH_SIZE) break;
    }

    await updateStoreHealthScore(storeId);

    // Aggregated, cooldown-limited: a scan that finds 500 criticals produces
    // one alert, not 500.
    await notifyCriticalIfNeeded(storeId);
    await deliverPendingNotifications();

    await prisma.catalogScan.update({
      where: { id: scan.id },
      data: {
        status: "COMPLETED",
        totalProducts: processedProducts,
        processedProducts,
        failedProducts,
        planLimited,
        completedAt: new Date(),
      },
    });

    return { success: true, processedProducts, failedProducts, planLimited, scanId: scan.id };
  } catch (error) {
    console.error("Scan engine error:", error);
    await prisma.catalogScan.update({
      where: { id: scan.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

/**
 * Incremental scan of a single product (the webhook path).
 *
 * Also revalidates the other products that share an affected SKU, so that
 * fixing a duplicate on one product resolves the DUPLICATE_SKU issue on its
 * counterpart instead of leaving it open until the next full scan (spec #11).
 */
export async function syncAndScanSingleProduct(admin, storeId, shopifyProductId) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  const planConfig = getPlanConfig(store?.plan);
  const rules = await prisma.validationRule.findMany({
    where: { storeId, isEnabled: true },
  });

  const { json, usedInventory } = await graphqlWithInventoryFallback(
    admin,
    storeId,
    singleProductQuery,
    { variables: { id: shopifyProductId } },
    shouldSyncInventory(storeId, planConfig),
  );

  const p = json.data?.product;

  if (!p) {
    // Product is gone from Shopify (deleted or unavailable): drop the local
    // copy so its issues stop counting against the store score.
    await deleteLocalProduct(storeId, shopifyProductId);
    return null;
  }

  // SKUs this product held *before* the sync, so counterparts of a SKU that was
  // just changed away from are revalidated too.
  const previousSkus = await prisma.variant.findMany({
    where: { storeId, product: { shopifyProductId } },
    select: { normalizedSku: true },
  });

  const dbProduct = await upsertProductRecord(storeId, p, {
    syncInventory: usedInventory,
  });

  const fullProd = await prisma.product.findUnique({
    where: { id: dbProduct.id },
    include: { variants: true, metafields: true, collections: true },
  });

  const skuCountMap = await getSkuCountsForProducts(storeId, [fullProd]);
  const inventoryLevels = await getInventoryLevelsForProducts(
    storeId,
    [fullProd],
    planConfig,
  );

  const detectedIssues = validateProductData({
    product: fullProd,
    variants: fullProd.variants,
    metafields: fullProd.metafields,
    collections: fullProd.collections,
    inventoryLevels,
    rules,
    skuCountMap,
    storePlan: store?.plan || "free",
  });

  await syncProductIssues(storeId, fullProd.id, detectedIssues, {
    updateStoreScore: false,
  });

  const affectedSkus = new Set(
    [
      ...previousSkus.map((v) => v.normalizedSku),
      ...fullProd.variants.map((v) => v.normalizedSku),
    ].filter(Boolean),
  );

  await revalidateSkuCounterparts(storeId, affectedSkus, fullProd.id, rules);

  await updateStoreHealthScore(storeId);
  await notifyCriticalIfNeeded(storeId);
  await deliverPendingNotifications();

  return fullProd;
}

/**
 * Revalidate the other products sharing any of `affectedSkus` so their
 * DUPLICATE_SKU issues open and resolve in step with this product's changes.
 */
async function revalidateSkuCounterparts(storeId, affectedSkus, excludeProductId, rules) {
  if (affectedSkus.size === 0) return;

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { plan: true },
  });
  const planConfig = getPlanConfig(store?.plan);

  const counterparts = await prisma.variant.findMany({
    where: {
      storeId,
      normalizedSku: { in: [...affectedSkus] },
      productId: { not: excludeProductId },
    },
    select: { productId: true },
    distinct: ["productId"],
    take: DUPLICATE_FANOUT_LIMIT,
  });

  if (counterparts.length === 0) return;

  const products = await prisma.product.findMany({
    where: { id: { in: counterparts.map((c) => c.productId) } },
    include: { variants: true, metafields: true, collections: true },
  });

  const skuCountMap = await getSkuCountsForProducts(storeId, products);
  const inventoryLevels = await getInventoryLevelsForProducts(
    storeId,
    products,
    planConfig,
  );

  for (const prod of products) {
    const detected = validateProductData({
      product: prod,
      variants: prod.variants,
      metafields: prod.metafields,
      collections: prod.collections,
      inventoryLevels,
      rules,
      skuCountMap,
      // Without this the counterpart was revalidated as a free-plan store and
      // its plan-gated issues were resolved away behind the merchant's back.
      storePlan: store?.plan || "free",
    });

    await syncProductIssues(storeId, prod.id, detected, { updateStoreScore: false });
  }
}

export async function deleteLocalProduct(storeId, shopifyProductId) {
  const product = await prisma.product.findUnique({
    where: {
      storeId_shopifyProductId: { storeId, shopifyProductId },
    },
    include: { variants: { select: { normalizedSku: true } } },
  });

  if (!product) return null;

  const affectedSkus = new Set(
    product.variants.map((v) => v.normalizedSku).filter(Boolean),
  );

  // Cascades remove the variants, metafields, SKU index rows and issues.
  await prisma.product.delete({ where: { id: product.id } });

  const rules = await prisma.validationRule.findMany({
    where: { storeId, isEnabled: true },
  });

  // Removing a product can un-duplicate a SKU elsewhere in the catalog.
  await revalidateSkuCounterparts(storeId, affectedSkus, product.id, rules);

  await updateStoreHealthScore(storeId);
  return product.id;
}

async function upsertProductRecord(storeId, p, { syncInventory = false } = {}) {
  // Count image media only: a product whose sole media item is a video or a 3D
  // model has no product image and must still raise MISSING_IMAGE.
  const imagesCount = (p.media?.nodes || []).filter(
    (m) => m?.mediaContentType === "IMAGE",
  ).length;

  const product = await prisma.product.upsert({
    where: {
      storeId_shopifyProductId: {
        storeId,
        shopifyProductId: p.id,
      },
    },
    update: {
      title: p.title,
      handle: p.handle,
      bodyHtml: p.descriptionHtml || "",
      vendor: p.vendor || "",
      productType: p.productType || "",
      status: p.status || "ACTIVE",
      imagesCount,
      syncedAt: new Date(),
    },
    create: {
      storeId,
      shopifyProductId: p.id,
      title: p.title,
      handle: p.handle,
      bodyHtml: p.descriptionHtml || "",
      vendor: p.vendor || "",
      productType: p.productType || "",
      status: p.status || "ACTIVE",
      imagesCount,
      syncedAt: new Date(),
    },
  });

  await prisma.skuIndex.deleteMany({ where: { productId: product.id } });

  const variants = p.variants?.nodes || [];
  const liveVariantIds = [];

  for (const v of variants) {
    const rawSku = v.sku || "";
    const normSku = normalizeSku(rawSku);

    const variantRecord = await prisma.variant.upsert({
      where: {
        storeId_shopifyVariantId: {
          storeId,
          shopifyVariantId: v.id,
        },
      },
      update: {
        // productId is included so a variant moved between products follows it.
        productId: product.id,
        title: v.title,
        sku: rawSku,
        normalizedSku: normSku,
        barcode: v.barcode || null,
        price: parseFloat(v.price || 0),
        compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice) : null,
        inventoryQuantity: v.inventoryQuantity ?? 0,
      },
      create: {
        storeId,
        productId: product.id,
        shopifyVariantId: v.id,
        title: v.title,
        sku: rawSku,
        normalizedSku: normSku,
        barcode: v.barcode || null,
        price: parseFloat(v.price || 0),
        compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice) : null,
        inventoryQuantity: v.inventoryQuantity ?? 0,
      },
    });

    liveVariantIds.push(variantRecord.id);

    await syncVariantInventoryLevels(storeId, variantRecord.id, v, syncInventory);

    if (normSku) {
      await prisma.skuIndex.create({
        data: {
          storeId,
          normalizedSku: normSku,
          productId: product.id,
          variantId: variantRecord.id,
          shopifyVariantId: v.id,
        },
      });
    }
  }

  // Drop variants that no longer exist in Shopify. Without this they linger
  // forever, keep raising issues nobody can fix, and inflate duplicate-SKU
  // counts.
  const orphanVariants = await prisma.variant.findMany({
    where: {
      productId: product.id,
      ...(liveVariantIds.length ? { id: { notIn: liveVariantIds } } : {}),
    },
    select: { id: true },
  });

  if (orphanVariants.length) {
    const orphanIds = orphanVariants.map((v) => v.id);

    // Delete the variant's issues explicitly. Issue.variantId is ON DELETE SET
    // NULL, so leaving this to the database would turn a variant-scoped issue
    // into a null-variant row that no longer matches anything the validator
    // emits: it could never be resolved, would sit OPEN forever dragging the
    // health score down, and two such rows of the same issue type would collide
    // on the issue identity key.
    await prisma.issue.deleteMany({ where: { variantId: { in: orphanIds } } });
    await prisma.variant.deleteMany({ where: { id: { in: orphanIds } } });
  }

  const metafields = p.metafields?.nodes || [];
  const liveMetafieldKeys = [];

  for (const mf of metafields) {
    if (!mf || !mf.namespace || !mf.key) continue;
    liveMetafieldKeys.push(`${mf.namespace} ${mf.key}`);
    await prisma.metafield.upsert({
      where: {
        productId_namespace_key: {
          productId: product.id,
          namespace: mf.namespace,
          key: mf.key,
        },
      },
      update: {
        value: mf.value || "",
        valueType: mf.type || "",
      },
      create: {
        productId: product.id,
        namespace: mf.namespace,
        key: mf.key,
        value: mf.value || "",
        valueType: mf.type || "",
      },
    });
  }

  // Remove metafields deleted in Shopify, otherwise a required metafield stays
  // "present" locally after the merchant clears it.
  const staleMetafields = await prisma.metafield.findMany({
    where: { productId: product.id },
    select: { id: true, namespace: true, key: true },
  });
  const liveKeySet = new Set(liveMetafieldKeys);
  const staleIds = staleMetafields
    .filter((m) => !liveKeySet.has(`${m.namespace} ${m.key}`))
    .map((m) => m.id);

  if (staleIds.length) {
    await prisma.metafield.deleteMany({ where: { id: { in: staleIds } } });
  }

  // Mirror collection membership so COLLECTION-scoped rules can be evaluated
  // from the database instead of an Admin API call per product.
  const collections = (p.collections?.nodes || []).filter((c) => c?.id);
  for (const c of collections) {
    await prisma.productCollection.upsert({
      where: {
        productId_shopifyCollectionId: {
          productId: product.id,
          shopifyCollectionId: c.id,
        },
      },
      update: { handle: c.handle || "", title: c.title || "" },
      create: {
        productId: product.id,
        shopifyCollectionId: c.id,
        handle: c.handle || "",
        title: c.title || "",
      },
    });
  }

  // A product removed from a collection must stop matching that rule.
  await prisma.productCollection.deleteMany({
    where: {
      productId: product.id,
      ...(collections.length
        ? { shopifyCollectionId: { notIn: collections.map((c) => c.id) } }
        : {}),
    },
  });

  return product;
}

/**
 * Mirror one variant's per-location stock (Multi-Location Catalog Sync).
 *
 * When the feature is not active for the store the local rows are removed, so a
 * downgrade stops the inventory checks from reading stock that is no longer
 * being refreshed.
 */
async function syncVariantInventoryLevels(storeId, variantId, variantNode, syncInventory) {
  if (!prisma.inventoryLevel) return;

  if (!syncInventory) {
    await prisma.inventoryLevel.deleteMany({ where: { variantId } });
    return;
  }

  const levels = variantNode.inventoryItem?.inventoryLevels?.nodes || [];
  const liveLocationIds = [];

  for (const level of levels) {
    const locationId = level?.location?.id;
    if (!locationId) continue;

    const available =
      (level.quantities || []).find((q) => q?.name === "available")?.quantity ?? 0;

    liveLocationIds.push(locationId);

    await prisma.inventoryLevel.upsert({
      where: {
        variantId_shopifyLocationId: { variantId, shopifyLocationId: locationId },
      },
      update: {
        storeId,
        locationName: level.location?.name || "",
        available,
        syncedAt: new Date(),
      },
      create: {
        storeId,
        variantId,
        shopifyLocationId: locationId,
        locationName: level.location?.name || "",
        available,
      },
    });
  }

  // A variant unstocked at a location must stop counting as stocked there.
  await prisma.inventoryLevel.deleteMany({
    where: {
      variantId,
      ...(liveLocationIds.length
        ? { shopifyLocationId: { notIn: liveLocationIds } }
        : {}),
    },
  });
}

/** Per-location stock for `products`, or [] when the plan has no such sync. */
async function getInventoryLevelsForProducts(storeId, products, planConfig) {
  if (!planConfig?.multiLocation || !prisma.inventoryLevel) return [];

  const variantIds = products.flatMap((prod) => (prod.variants || []).map((v) => v.id));
  if (variantIds.length === 0) return [];

  return prisma.inventoryLevel.findMany({
    where: { storeId, variantId: { in: variantIds } },
  });
}

/**
 * Duplicate-SKU counts for just the SKUs used by `products`.
 *
 * Reading the whole store's SKU index on every webhook does not scale, so the
 * local SKU index is queried for the handful of SKUs actually in play
 * (spec #11).
 */
async function getSkuCountsForProducts(storeId, products) {
  const skus = new Set();
  for (const prod of products) {
    for (const v of prod.variants || []) {
      const norm = v.normalizedSku || normalizeSku(v.sku);
      if (norm) skus.add(norm);
    }
  }

  const countMap = new Map();
  if (skus.size === 0) return countMap;

  const grouped = await prisma.skuIndex.groupBy({
    by: ["normalizedSku"],
    where: { storeId, normalizedSku: { in: [...skus] } },
    _count: { _all: true },
  });

  for (const row of grouped) {
    countMap.set(row.normalizedSku, row._count._all);
  }

  return countMap;
}
