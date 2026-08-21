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
 */

export function normalizeSku(sku) {
  if (!sku) return "";
  return sku.trim().toUpperCase();
}

export function validateProductData({
  product,
  variants = [],
  metafields = [],
  rules = [],
  skuCountMap = new Map(), // map of normalizedSku -> count
}) {
  const issues = [];

  // Filter applicable rules by priority (lower number = higher priority)
  const sortedRules = [...rules].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  // Determine applicable rule settings
  let minImages = 1;
  let checkPrices = true;
  let checkSku = true;
  let checkBarcode = false;
  let checkDescription = true;
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
    }

    if (matches) {
      if (rule.minImages !== undefined) minImages = rule.minImages;
      if (rule.checkPrices !== undefined) checkPrices = rule.checkPrices;
      if (rule.checkSku !== undefined) checkSku = rule.checkSku;
      if (rule.checkBarcode !== undefined) checkBarcode = rule.checkBarcode;
      if (rule.checkDescription !== undefined) checkDescription = rule.checkDescription;

      if (rule.requiredMetafields) {
        rule.requiredMetafields.split(",").forEach((mf) => {
          const trimmed = mf.trim();
          if (trimmed) requiredMetafields.add(trimmed);
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
      } else {
        // Duplicate SKU Check
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
        if (compareAtPrice > 0 && compareAtPrice <= price) {
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

    // Barcode Check
    if (checkBarcode) {
      if (!variant.barcode || !variant.barcode.trim()) {
        issues.push({
          issueType: "MISSING_BARCODE",
          fieldName: "barcode",
          variantId: variant.id,
          severity: "INFO",
          title: `Missing Barcode for Variant "${variant.title || 'Default'}"`,
          description: `Variant does not have a barcode specified.`,
        });
      }
    }
  }

  // 4. Metafield Validation
  if (requiredMetafields.size > 0) {
    const existingMetafields = new Set(
      metafields.map((m) => `${m.namespace}.${m.key}`.toLowerCase())
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
