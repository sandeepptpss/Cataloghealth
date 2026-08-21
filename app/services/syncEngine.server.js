import prisma from "../db.server.js";
import { normalizeSku, validateProductData } from "./validationEngine.server.js";
import { syncProductIssues, updateStoreHealthScore } from "./issueEngine.server.js";

const PRODUCTS_QUERY = `#graphql
  query getCatalogProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          descriptionHtml
          vendor
          productType
          status
          media(first: 10) {
            nodes {
              id
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
            }
          }
          metafields(first: 20) {
            nodes {
              id
              namespace
              key
              value
              type
            }
          }
        }
      }
    }
  }
`;

const SINGLE_PRODUCT_QUERY = `#graphql
  query getSingleProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      descriptionHtml
      vendor
      productType
      status
      media(first: 10) {
        nodes {
          id
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
        }
      }
      metafields(first: 20) {
        nodes {
          id
          namespace
          key
          value
          type
        }
      }
    }
  }
`;

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

    // Create default validation rule
    await prisma.validationRule.create({
      data: {
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
    });
  }

  return store;
}

export async function syncAndScanCatalog(admin, storeId, scanType = "FULL") {
  const scan = await prisma.catalogScan.create({
    data: {
      storeId,
      scanType,
      status: "IN_PROGRESS",
      startedAt: new Date(),
    },
  });

  try {
    let hasNextPage = true;
    let endCursor = null;
    let processedProducts = 0;
    let failedProducts = 0;

    const rules = await prisma.validationRule.findMany({
      where: { storeId, isEnabled: true },
    });

    // First pass: pull products in batches and index SKUs
    while (hasNextPage) {
      const response = await admin.graphql(PRODUCTS_QUERY, {
        variables: {
          first: 50,
          after: endCursor,
        },
      });

      const json = await response.json();
      const productsData = json.data?.products;

      if (!productsData) break;

      const edges = productsData.edges || [];

      for (const edge of edges) {
        const p = edge.node;
        try {
          await upsertProductRecord(storeId, p);
          processedProducts++;
        } catch (err) {
          console.error("Error upserting product:", err);
          failedProducts++;
        }
      }

      hasNextPage = productsData.pageInfo.hasNextPage;
      endCursor = productsData.pageInfo.endCursor;

      // Update cursor progress
      await prisma.catalogScan.update({
        where: { id: scan.id },
        data: {
          processedProducts,
          failedProducts,
          lastCursor: endCursor,
        },
      });
    }

    // Build SKU index map across catalog for duplicate detection
    const skuIndexMap = await buildCatalogSkuIndexMap(storeId);

    // Second pass: Run validation engine & issue sync for all products
    const dbProducts = await prisma.product.findMany({
      where: { storeId },
      include: {
        variants: true,
        metafields: true,
      },
    });

    for (const prod of dbProducts) {
      const detectedIssues = validateProductData({
        product: prod,
        variants: prod.variants,
        metafields: prod.metafields,
        rules,
        skuCountMap: skuIndexMap,
      });

      await syncProductIssues(storeId, prod.id, detectedIssues);
    }

    await updateStoreHealthScore(storeId);

    // Mark scan complete
    await prisma.catalogScan.update({
      where: { id: scan.id },
      data: {
        status: "COMPLETED",
        totalProducts: processedProducts,
        completedAt: new Date(),
      },
    });

    return { success: true, processedProducts, failedProducts };
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

export async function syncAndScanSingleProduct(admin, storeId, shopifyProductId) {
  const rules = await prisma.validationRule.findMany({
    where: { storeId, isEnabled: true },
  });

  const response = await admin.graphql(SINGLE_PRODUCT_QUERY, {
    variables: { id: shopifyProductId },
  });

  const json = await response.json();
  const p = json.data?.product;

  if (!p) return null;

  const dbProduct = await upsertProductRecord(storeId, p);
  const skuIndexMap = await buildCatalogSkuIndexMap(storeId);

  const fullProd = await prisma.product.findUnique({
    where: { id: dbProduct.id },
    include: { variants: true, metafields: true },
  });

  const detectedIssues = validateProductData({
    product: fullProd,
    variants: fullProd.variants,
    metafields: fullProd.metafields,
    rules,
    skuCountMap: skuIndexMap,
  });

  await syncProductIssues(storeId, fullProd.id, detectedIssues);
  return fullProd;
}

async function upsertProductRecord(storeId, p) {
  const imagesCount = p.media?.nodes?.length || 0;

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

  // Clear existing SKU indexes for this product
  await prisma.skuIndex.deleteMany({ where: { productId: product.id } });

  // Sync Variants
  const variants = p.variants?.nodes || [];
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

  // Sync Metafields
  const metafields = p.metafields?.nodes || [];
  for (const mf of metafields) {
    if (!mf || !mf.namespace || !mf.key) continue;
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

  return product;
}

async function buildCatalogSkuIndexMap(storeId) {
  const indexes = await prisma.skuIndex.findMany({
    where: { storeId },
    select: { normalizedSku: true },
  });

  const countMap = new Map();
  for (const idx of indexes) {
    const sku = idx.normalizedSku;
    if (sku) {
      countMap.set(sku, (countMap.get(sku) || 0) + 1);
    }
  }

  return countMap;
}
