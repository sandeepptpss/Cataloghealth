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
  } else {
    throw new Error(`Auto-fix is not supported for issue type "${issue.issueType}". Manual intervention required.`);
  }

  if (fixed) {
    // Re-scan product to update DB & local state
    await syncAndScanSingleProduct(admin, storeId, product.shopifyProductId);
  }

  return { success: true, message: fixMessage };
}
