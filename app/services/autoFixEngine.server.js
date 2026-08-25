import prisma from "../db.server.js";
import { getPlanConfig } from "./planEngine.server.js";
import { syncAndScanSingleProduct, graphqlWithRetry } from "./syncEngine.server.js";

const PRODUCT_UPDATE_MUTATION = `#graphql
  mutation updateProduct($input: ProductInput!) {
    productUpdate(input: $input) {
      product {
        id
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_VARIANTS_BULK_UPDATE_MUTATION = `#graphql
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        sku
        price
        compareAtPrice
        barcode
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Generates a unique, non-static HTML product description based on product title,
 * vendor, product type, and variant attributes.
 */
export function generateDynamicProductDescription(product) {
  const title = (product?.title || "Product").trim();
  const vendor = (product?.vendor || "").trim();
  const productType = (product?.productType || "").trim().toLowerCase();
  const variants = product?.variants || [];

  // Deterministic seed based on product ID / title to choose varied sentence templates per product
  const seedStr = String(product?.shopifyProductId || product?.id || title);
  const seed = seedStr.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);

  // Extract non-default variant titles (e.g. "Small / Red")
  const variantTitles = variants
    .map((v) => v.title)
    .filter((t) => t && t !== "Default Title" && t !== "Default");
  const variantListText = variantTitles.length > 0 ? variantTitles.slice(0, 5).join(", ") : null;

  // Varied Openings
  const openings = [
    `Introducing the <strong>${title}</strong>${vendor ? ` by <strong>${vendor}</strong>` : ""}. Designed for exceptional everyday reliability, this ${productType || "item"} combines practical utility with clean modern aesthetics.`,
    `Upgrade your collection with the <strong>${title}</strong>${vendor ? ` from <strong>${vendor}</strong>` : ""}. Engineered to deliver consistent quality, it offers an ideal blend of performance and modern styling.`,
    `Discover the <strong>${title}</strong>${vendor ? ` by <strong>${vendor}</strong>` : ""}. Built to meet high operational standards, this ${productType || "essential item"} is crafted for maximum convenience and long-lasting durability.`,
    `Elevate your experience with the <strong>${title}</strong>${vendor ? ` brought to you by <strong>${vendor}</strong>` : ""}. Thoughtfully constructed for versatility and comfort, it stands out as a dependable choice.`
  ];

  // Varied Feature Sets
  const featurePools = [
    [
      `<strong>Premium Craftsmanship:</strong> Expertly constructed using durable materials to ensure long-term resilience.`,
      `<strong>Optimized Ergonomics:</strong> Designed with user comfort and effortless handling in mind.`,
      `<strong>Quality Tested:</strong> Every detail of ${title} is inspected for performance and standard compliance.`
    ],
    [
      `<strong>Superior Materials:</strong> Formulated for strength, dependability, and everyday usage.`,
      `<strong>Modern Design:</strong> Blends seamlessly with your current setup or lifestyle needs.`,
      `<strong>Authentic ${vendor || "Brand"} Quality:</strong> Produced following strict benchmarks to ensure total satisfaction.`
    ],
    [
      `<strong>Built to Last:</strong> Robust design resists wear and tear under regular usage.`,
      `<strong>Versatile Performance:</strong> Suitable for a wide range of applications and store settings.`,
      `<strong>Guaranteed Utility:</strong> Carefully crafted to deliver smooth and consistent everyday results.`
    ]
  ];

  // Varied Outros
  const outros = [
    `Order your <strong>${title}</strong> today and enjoy prompt processing and fast delivery.`,
    `Add the <strong>${title}</strong> to your order now for guaranteed quality and dedicated support.`,
    `Don't miss out on the <strong>${title}</strong>—available now with reliable store dispatch.`,
    `Experience the difference with <strong>${title}</strong>. Order today for dependable service.`
  ];

  const opening = openings[seed % openings.length];
  const features = featurePools[seed % featurePools.length];
  const outro = outros[seed % outros.length];

  const variantItem = variantListText
    ? `\n  <li><strong>Available Variants:</strong> Includes options such as ${variantListText}.</li>`
    : "";

  return `
<p>${opening}</p>

<h3>Product Highlights & Specifications</h3>
<ul>
  ${features.map((f) => `<li>${f}</li>`).join("\n  ")}${variantItem}
</ul>

<p><em>${outro}</em></p>
`.trim();
}

const METAFIELDS_SET_MUTATION = `#graphql
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Enterprise Auto-Fix Resolution Engine
 * 
 * Automatically resolves common catalog health compliance issues on Shopify.
 */
export async function autoFixIssue(admin, storeId, issueId) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new Error("Store not found");
  }

  const planConfig = getPlanConfig(store.plan);
  if (!planConfig.autoFix) {
    throw new Error("Auto-Fix Resolution Engine requires Plus Enterprise plan subscription.");
  }

  const issue = await prisma.issue.findFirst({
    where: { id: issueId, storeId },
    include: {
      product: { include: { variants: true } },
      variant: true,
    },
  });

  if (!issue) {
    throw new Error("Issue not found or unauthorized");
  }

  const { product } = issue;
  const variant = issue.variant || product?.variants?.find((v) => v.id === issue.variantId);
  let fixed = false;
  let fixMessage = "";

  if (issue.issueType === "MISSING_SKU" && variant) {
    const cleanHandle = (product.handle || "PROD").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const cleanVar = (variant.title || "VAR").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const generatedSku = `${cleanHandle}-${cleanVar}-${Math.floor(1000 + Math.random() * 9000)}`;

    const res = await graphqlWithRetry(admin, PRODUCT_VARIANTS_BULK_UPDATE_MUTATION, {
      variables: {
        productId: product.shopifyProductId,
        variants: [
          {
            id: variant.shopifyVariantId,
            inventoryItem: {
              sku: generatedSku,
            },
          },
        ],
      },
    });

    const userErrors = res.data?.productVariantsBulkUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(`Shopify API error: ${userErrors.map((e) => e.message).join("; ")}`);
    }

    fixed = true;
    fixMessage = `Auto-assigned SKU: "${generatedSku}" to variant "${variant.title}".`;
  } else if (issue.issueType === "MISSING_DESCRIPTION" && product) {
    const defaultDesc = generateDynamicProductDescription(product);

    const res = await graphqlWithRetry(admin, PRODUCT_UPDATE_MUTATION, {
      variables: {
        input: {
          id: product.shopifyProductId,
          descriptionHtml: defaultDesc,
        },
      },
    });

    const userErrors = res.data?.productUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(`Shopify API error: ${userErrors.map((e) => e.message).join("; ")}`);
    }

    fixed = true;
    fixMessage = `Auto-generated dynamic unique description for "${product.title}".`;
  } else if (issue.issueType === "INVALID_PRICE" && variant) {
    const newPrice = "9.99";

    const res = await graphqlWithRetry(admin, PRODUCT_VARIANTS_BULK_UPDATE_MUTATION, {
      variables: {
        productId: product.shopifyProductId,
        variants: [
          {
            id: variant.shopifyVariantId,
            price: newPrice,
          },
        ],
      },
    });

    const userErrors = res.data?.productVariantsBulkUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(`Shopify API error: ${userErrors.map((e) => e.message).join("; ")}`);
    }

    fixed = true;
    fixMessage = `Auto-updated variant price to $${newPrice}.`;
  } else if (issue.issueType === "INVALID_COMPARE_AT_PRICE" && variant) {
    const res = await graphqlWithRetry(admin, PRODUCT_VARIANTS_BULK_UPDATE_MUTATION, {
      variables: {
        productId: product.shopifyProductId,
        variants: [
          {
            id: variant.shopifyVariantId,
            compareAtPrice: null,
          },
        ],
      },
    });

    const userErrors = res.data?.productVariantsBulkUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(`Shopify API error: ${userErrors.map((e) => e.message).join("; ")}`);
    }

    fixed = true;
    fixMessage = `Cleared invalid compare-at price for variant "${variant.title}".`;
  } else if (issue.issueType === "MISSING_BARCODE" && variant) {
    const cleanHandle = (product.handle || "PROD").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const generatedBarcode = `${cleanHandle}-${Math.floor(10000000 + Math.random() * 90000000)}`;

    const res = await graphqlWithRetry(admin, PRODUCT_VARIANTS_BULK_UPDATE_MUTATION, {
      variables: {
        productId: product.shopifyProductId,
        variants: [
          {
            id: variant.shopifyVariantId,
            barcode: generatedBarcode,
          },
        ],
      },
    });

    const userErrors = res.data?.productVariantsBulkUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(`Shopify API error: ${userErrors.map((e) => e.message).join("; ")}`);
    }

    fixed = true;
    fixMessage = `Auto-assigned barcode: "${generatedBarcode}" to variant "${variant.title}".`;
  } else if (issue.issueType === "MISSING_METAFIELD" && product) {
    const rawField = (issue.fieldName || "").trim();
    const parts = rawField.split(".");
    const namespace = parts.length > 1 ? parts[0] : "custom";
    const key = parts.length > 1 ? parts.slice(1).join("_") : parts[0] || "audit_status";

    // Check if any active validation rule has a configured default value (e.g. namespace.key=CustomValue)
    let configuredDefault = null;
    try {
      const activeRules = await prisma.validationRule.findMany({
        where: { storeId, isEnabled: true, requiredMetafields: { contains: rawField } },
      });

      for (const rule of activeRules) {
        if (rule.requiredMetafields) {
          const items = rule.requiredMetafields.split(",");
          for (const item of items) {
            const [fKey, ...valParts] = item.trim().split("=");
            if (fKey && fKey.trim().toLowerCase() === rawField.toLowerCase() && valParts.length > 0) {
              configuredDefault = valParts.join("=").trim();
              break;
            }
          }
        }
        if (configuredDefault) break;
      }
    } catch {
      // Fallback to smart default if DB query fails
    }

    const defaultValue = getSmartMetafieldValue(rawField, key, namespace, product, configuredDefault);

    const res = await graphqlWithRetry(admin, METAFIELDS_SET_MUTATION, {
      variables: {
        metafields: [
          {
            ownerId: product.shopifyProductId,
            namespace,
            key,
            type: "single_line_text_field",
            value: defaultValue,
          },
        ],
      },
    });

    const userErrors = res.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(`Shopify API error: ${userErrors.map((e) => e.message).join("; ")}`);
    }

    fixed = true;
    fixMessage = `Auto-populated default value "${defaultValue}" for metafield "${namespace}.${key}".`;
  } else {
    throw new Error(`Auto-fix is not supported for issue type "${issue.issueType}". Manual intervention required.`);
  }

  if (fixed) {
    // Re-scan product to update DB & local state
    await syncAndScanSingleProduct(admin, storeId, product.shopifyProductId);
  }

  return { success: true, message: fixMessage };
}

/**
 * Smart default value generator for Shopify Metafields based on key name, namespace, and product context.
 */
export function getSmartMetafieldValue(fieldName, key, namespace, product, customDefault = null) {
  if (customDefault && customDefault.trim()) {
    return customDefault.trim();
  }

  const k = (key || "").toLowerCase();
  const ns = (namespace || "").toLowerCase();

  // 1. Audit / Compliance / Testing / Validation
  if (
    k.includes("testing") ||
    k.includes("validation") ||
    k.includes("audit") ||
    k.includes("compliance") ||
    k.includes("verified") ||
    k.includes("certif") ||
    k.includes("approval") ||
    k.includes("qc")
  ) {
    return "Verified & Audited";
  }

  // 2. Dates / Timestamps
  if (
    k.includes("date") ||
    k.includes("time") ||
    k.includes("created") ||
    k.includes("updated") ||
    k.includes("expiry")
  ) {
    return new Date().toISOString().split("T")[0];
  }

  // 3. Material / Composition / Fabric
  if (
    k.includes("material") ||
    k.includes("fabric") ||
    k.includes("composition") ||
    k.includes("ingredient")
  ) {
    return "Standard Grade Material";
  }

  // 4. Care / Instructions
  if (
    k.includes("care") ||
    k.includes("instruction") ||
    k.includes("wash") ||
    k.includes("cleaning")
  ) {
    return "Follow standard manufacturer care guidelines.";
  }

  // 5. Colors / Shades
  if (k.includes("color") || k.includes("colour") || k.includes("shade")) {
    return "Standard";
  }

  // 6. Origin / Location / Country
  if (k.includes("origin") || k.includes("country") || k.includes("made_in")) {
    return "Global Standards Compliant";
  }

  // 7. Boolean / Flags
  if (
    k.startsWith("is_") ||
    k.startsWith("has_") ||
    k.includes("boolean") ||
    k.includes("flag") ||
    k.includes("active")
  ) {
    return "true";
  }

  // 8. Warranty / Guarantee
  if (k.includes("warranty") || k.includes("guarantee")) {
    return "1 Year Standard Warranty";
  }

  // 9. Standard Identifiers (gtin, mpn, upc, isbn, model)
  if (
    k.includes("gtin") ||
    k.includes("mpn") ||
    k.includes("upc") ||
    k.includes("isbn") ||
    k.includes("model")
  ) {
    const handleClean = (product?.handle || "PROD").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return `${handleClean}-${Math.floor(100000 + Math.random() * 900000)}`;
  }

  // Default fallback
  return "Verified & Audited";
}

