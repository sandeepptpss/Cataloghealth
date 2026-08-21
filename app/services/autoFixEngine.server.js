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

const VARIANT_UPDATE_MUTATION = `#graphql
  mutation updateVariant($input: ProductVariantInput!) {
    productVariantUpdate(input: $input) {
      productVariant {
        id
        sku
        price
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

  const { product, variant } = issue;
  let fixed = false;
  let fixMessage = "";

  if (issue.issueType === "MISSING_SKU" && variant) {
    const cleanHandle = (product.handle || "PROD").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const cleanVar = (variant.title || "VAR").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const generatedSku = `${cleanHandle}-${cleanVar}-${Math.floor(1000 + Math.random() * 9000)}`;

    const res = await graphqlWithRetry(admin, VARIANT_UPDATE_MUTATION, {
      variables: {
        input: {
          id: variant.shopifyVariantId,
          sku: generatedSku,
        },
      },
    });

    const userErrors = res.data?.productVariantUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(`Shopify API error: ${userErrors.map((e) => e.message).join("; ")}`);
    }

    fixed = true;
    fixMessage = `Auto-assigned SKU: "${generatedSku}" to variant "${variant.title}".`;
  } else if (issue.issueType === "MISSING_DESCRIPTION" && product) {
    const defaultDesc = `<p>Premium ${product.title} provided by ${product.vendor || "our store"}. High quality product built to specifications.</p>`;

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
    fixMessage = `Auto-generated description for product "${product.title}".`;
  } else if (issue.issueType === "INVALID_PRICE" && variant) {
    const newPrice = "9.99";

    const res = await graphqlWithRetry(admin, VARIANT_UPDATE_MUTATION, {
      variables: {
        input: {
          id: variant.shopifyVariantId,
          price: newPrice,
        },
      },
    });

    const userErrors = res.data?.productVariantUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(`Shopify API error: ${userErrors.map((e) => e.message).join("; ")}`);
    }

    fixed = true;
    fixMessage = `Auto-updated variant price to $${newPrice}.`;
  } else if (issue.issueType === "INVALID_COMPARE_AT_PRICE" && variant) {
    const res = await graphqlWithRetry(admin, VARIANT_UPDATE_MUTATION, {
      variables: {
        input: {
          id: variant.shopifyVariantId,
          compareAtPrice: null,
        },
      },
    });

    const userErrors = res.data?.productVariantUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(`Shopify API error: ${userErrors.map((e) => e.message).join("; ")}`);
    }

    fixed = true;
    fixMessage = `Cleared invalid compare-at price for variant "${variant.title}".`;
  } else {
    throw new Error(`Auto-fix is not supported for issue type "${issue.issueType}". Manual intervention required.`);
  }

  if (fixed) {
    // Re-scan product to update DB & local state
    await syncAndScanSingleProduct(admin, storeId, product.shopifyProductId);
  }

  return { success: true, message: fixMessage };
}
