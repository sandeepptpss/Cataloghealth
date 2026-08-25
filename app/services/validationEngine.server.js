/**
 * Validation Engine for Shopify Catalog Health Monitor
 * 
 * Rules supported:
 * 1. MISSING_IMAGE (CRITICAL) - product has 0 images
 * 2. MISSING_DESCRIPTION (WARNING) - product description is empty
 * 3. MISSING_SKU (WARNING) - variant SKU is empty
 * 4. DUPLICATE_SKU (CRITICAL) - variant SKU occurs more than once in catalog index
 * 5. INVALID_PRICE (CRITICAL) - variant price <= 0
 * 6. INVALID_COMPARE_AT_PRICE (WARNING) - compare_at_price <= price
 * 7. MISSING_BARCODE (INFO) - barcode missing when rule enabled
 * 8. MISSING_METAFIELD (WARNING) - required custom metafield is missing or empty
 * 9. NO_STOCKED_LOCATION (WARNING) - variant is not stocked at any location
 * 10. OUT_OF_STOCK_ALL_LOCATIONS (INFO) - stocked, but zero available everywhere
 *
 * Rules are scoped by ALL, VENDOR, PRODUCT_TYPE or COLLECTION, and merged
 * highest-priority-last so a specific rule overrides a general one (spec #15).
 */

import { getPlanConfig } from "./planEngine.server.js";

export function normalizeSku(sku) {
  if (!sku) return "";
  return sku.trim().toUpperCase();
}

export function validateProductData({
  product,
  variants = [],
  metafields = [],
  collections = [],
  inventoryLevels = [],
  rules = [],
  skuCountMap = new Map(), // map of normalizedSku -> count
  storePlan = "free",
}) {
  const issues = [];
  const planConfig = getPlanConfig(storePlan);

  // Priority 1 = highest, priority 100 = lowest (spec #15). Each matching rule
  // overwrites the accumulated settings, so we apply them from LOWEST to
  // HIGHEST priority: the highest-priority rule is applied last and therefore
  // wins any conflict.
  const sortedRules = [...rules].sort((a, b) => (b.priority ?? 100) - (a.priority ?? 100));

  // Determine applicable rule settings
  let minImages = 1;
  let checkPrices = true;
  let checkSku = true;
  let checkBarcode = false;
  let checkDescription = true;
  let checkInventory = false;
  const requiredMetafields = new Set();

  for (const rule of sortedRules) {
    if (!rule.isEnabled) continue;

    // Check scope match
    let matches = false;
    if (rule.scopeType === "ALL") {
      matches = true;
    } else if (rule.scopeType === "VENDOR" && rule.scopeValue) {
      matches = product.vendor?.toLowerCase() === rule.scopeValue.toLowerCase();
    } else if (rule.scopeType === "PRODUCT_TYPE" && rule.scopeValue) {
      matches = product.productType?.toLowerCase() === rule.scopeValue.toLowerCase();
    } else if (rule.scopeType === "COLLECTION" && rule.scopeValue) {
      // Merchants think in collection names but URLs use handles, so accept
      // either. "Electronics", "electronics" and "electronics-1" all resolve.
      const target = rule.scopeValue.trim().toLowerCase();
      matches = collections.some(
        (c) =>
          c.handle?.toLowerCase() === target || c.title?.toLowerCase() === target,
      );
    }

    if (matches) {
      if (rule.minImages !== undefined) minImages = rule.minImages;
      if (rule.checkPrices !== undefined) checkPrices = rule.checkPrices;
      if (rule.checkSku !== undefined) checkSku = rule.checkSku;
      if (rule.checkBarcode !== undefined && planConfig.barcodeAudit) checkBarcode = rule.checkBarcode;
      if (rule.checkDescription !== undefined) checkDescription = rule.checkDescription;
      // Multi-location stock is only mirrored for plans that include the sync,
      // so the check would read an empty table on any other plan.
      if (rule.checkInventory !== undefined && planConfig.multiLocation) {
        checkInventory = rule.checkInventory;
      }

      if (rule.requiredMetafields && planConfig.requiredMetafields) {
        rule.requiredMetafields.split(",").forEach((mf) => {
          const trimmed = mf.trim();
          if (trimmed) {
            const [fieldKey] = trimmed.split("=");
            const cleanKey = fieldKey.trim();
            if (cleanKey) requiredMetafields.add(cleanKey);
          }
        });
      }
    }
  }

  // 1. Missing Image Check
  if (minImages > 0 && (product.imagesCount ?? 0) < minImages) {
    issues.push({
      issueType: "MISSING_IMAGE",
      fieldName: "images",
      variantId: "",
      severity: "CRITICAL",
      title: "Missing Product Image",
      description: `Product requires at least ${minImages} image(s), but has ${product.imagesCount ?? 0}.`,
    });
  }

  // 2. Missing Description Check
  if (checkDescription) {
    const cleanDesc = product.bodyHtml ? product.bodyHtml.replace(/<[^>]*>?/gm, "").trim() : "";
    if (!cleanDesc) {
      issues.push({
        issueType: "MISSING_DESCRIPTION",
        fieldName: "bodyHtml",
        variantId: "",
        severity: "WARNING",
        title: "Missing Product Description",
        description: "Product description is empty or missing.",
      });
    }
  }

  // Per-variant stock, keyed for the loop below.
  const levelsByVariant = new Map();
  for (const level of inventoryLevels) {
    if (!level?.variantId) continue;
    const list = levelsByVariant.get(level.variantId) || [];
    list.push(level);
    levelsByVariant.set(level.variantId, list);
  }

  // 3. Variant Validations
  for (const variant of variants) {
    const rawSku = variant.sku || "";
    const normSku = normalizeSku(rawSku);

    // Missing SKU
    if (checkSku) {
      if (!normSku) {
        issues.push({
          issueType: "MISSING_SKU",
          fieldName: "sku",
          variantId: variant.id,
          severity: "WARNING",
          title: `Missing SKU for Variant "${variant.title || 'Default'}"`,
          description: `Variant "${variant.title || 'Default'}" does not have a SKU assigned.`,
        });
      } else if (planConfig.duplicateSku) {
        // Duplicate SKU Check (Growth plan and above)
        const occurrences = skuCountMap.get(normSku) || 0;
        if (occurrences > 1) {
          issues.push({
            issueType: "DUPLICATE_SKU",
            fieldName: "sku",
            variantId: variant.id,
            severity: "CRITICAL",
            title: `Duplicate SKU "${normSku}"`,
            description: `SKU "${normSku}" is assigned to ${occurrences} variants across the catalog.`,
          });
        }
      }
    }

    // Price Validations
    if (checkPrices) {
      const price = Number(variant.price ?? 0);
      if (price <= 0) {
        issues.push({
          issueType: "INVALID_PRICE",
          fieldName: "price",
          variantId: variant.id,
          severity: "CRITICAL",
          title: `Invalid Price ($${price}) on Variant "${variant.title || 'Default'}"`,
          description: `Variant price must be greater than 0.`,
        });
      }

      if (variant.compareAtPrice !== null && variant.compareAtPrice !== undefined) {
        const compareAtPrice = Number(variant.compareAtPrice);
        if (compareAtPrice > 0 && compareAtPrice <= price && price > 0) {
          issues.push({
            issueType: "INVALID_COMPARE_AT_PRICE",
            fieldName: "compareAtPrice",
            variantId: variant.id,
            severity: "WARNING",
            title: `Invalid Compare-At Price ($${compareAtPrice})`,
            description: `Compare-at price ($${compareAtPrice}) should be strictly greater than standard price ($${price}).`,
          });
        }
      }
    }

    // Barcode & Google Shopping GTIN Check
    if (checkBarcode) {
      if (!variant.barcode || !variant.barcode.trim()) {
        issues.push({
          issueType: "MISSING_BARCODE",
          fieldName: "barcode",
          variantId: variant.id,
          severity: "WARNING",
          title: `Missing Barcode / GTIN for Variant "${variant.title || 'Default'}"`,
          description: `Variant does not have a GTIN/barcode specified. Risks product disapproval on Google Shopping & Meta Ad feeds.`,
        });
      }
    }

    // Multi-location stock checks
    if (checkInventory) {
      const levels = levelsByVariant.get(variant.id) || [];

      if (levels.length === 0) {
        issues.push({
          issueType: "NO_STOCKED_LOCATION",
          fieldName: "inventory",
          variantId: variant.id,
          severity: "WARNING",
          title: `No stocked location for Variant "${variant.title || 'Default'}"`,
          description:
            "Variant is not stocked at any location, so it cannot be fulfilled from inventory.",
        });
      } else {
        const totalAvailable = levels.reduce((sum, l) => sum + (l.available ?? 0), 0);
        if (totalAvailable <= 0) {
          issues.push({
            issueType: "OUT_OF_STOCK_ALL_LOCATIONS",
            fieldName: "inventory",
            variantId: variant.id,
            severity: "INFO",
            title: `Out of stock at all ${levels.length} location(s)`,
            description: `Variant "${variant.title || 'Default'}" has 0 available across every stocked location (${levels
              .map((l) => l.locationName || l.shopifyLocationId)
              .join(", ")}).`,
          });
        }
      }
    }
  }

  // 4. Metafield Validation
  if (requiredMetafields.size > 0) {
    // A metafield that exists but holds an empty value is still "missing" for
    // catalog-quality purposes, so only non-empty values count as present.
    const existingMetafields = new Set(
      metafields
        .filter((m) => (m.value ?? "").toString().trim() !== "")
        .map((m) => `${m.namespace}.${m.key}`.toLowerCase())
    );

    for (const reqField of requiredMetafields) {
      if (!existingMetafields.has(reqField.toLowerCase())) {
        issues.push({
          issueType: "MISSING_METAFIELD",
          fieldName: reqField,
          variantId: "",
          severity: "WARNING",
          title: `Missing Required Metafield "${reqField}"`,
          description: `Product is missing required metafield "${reqField}".`,
        });
      }
    }
  }

  return issues;
}
