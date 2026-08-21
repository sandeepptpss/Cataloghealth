import { useLoaderData, useSubmit, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  DataTable,
  Button,
  BlockStack,
  InlineStack,
  ProgressBar,
  Box,
  Divider,
} from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord, syncAndScanSingleProduct } from "../services/syncEngine.server.js";
import { calculateAndSaveHealthScores } from "../services/issueEngine.server.js";

export const loader = async ({ params, request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const productId = params.id;

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      variants: true,
      metafields: true,
      issues: {
        include: { histories: { orderBy: { createdAt: "desc" } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!product || product.storeId !== store.id) {
    throw new Response("Product Not Found", { status: 404 });
  }

  return { store, product };
};

export const action = async ({ params, request }) => {
  const { admin, session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const productId = params.id;

  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "RESCAN_PRODUCT") {
    // Scoped by storeId: never rescan a product belonging to another shop.
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId: store.id },
    });
    if (!product) {
      return { success: false, error: "Product not found." };
    }
    // A single product is cheap enough to scan inline, which keeps the merchant's
    // "Rescan" click immediately reflected in the page they are looking at.
    await syncAndScanSingleProduct(admin, store.id, product.shopifyProductId);
    return { success: true };
  }

  if (actionType === "IGNORE_ISSUE") {
    const issueId = formData.get("issueId");
    if (issueId) {
      const issue = await prisma.issue.findFirst({
        where: { id: issueId, storeId: store.id, productId },
      });
      if (issue) {
        await prisma.issue.update({
          where: { id: issue.id },
          data: { status: "IGNORED", ignoredAt: new Date() },
        });
        await prisma.issueHistory.create({
          data: {
            storeId: store.id,
            issueId: issue.id,
            previousStatus: issue.status,
            newStatus: "IGNORED",
            changeReason: "Ignored manually on product page",
          },
        });
        await calculateAndSaveHealthScores(store.id, productId);
      }
    }
    return { success: true };
  }

  if (actionType === "UNIGNORE_ISSUE") {
    const issueId = formData.get("issueId");
    if (issueId) {
      const issue = await prisma.issue.findFirst({
        where: { id: issueId, storeId: store.id, productId },
      });
      if (issue) {
        await prisma.issue.update({
          where: { id: issue.id },
          // resolvedAt is cleared too: an unignored issue is open, not resolved.
          data: { status: "OPEN", ignoredAt: null, resolvedAt: null },
        });
        await prisma.issueHistory.create({
          data: {
            storeId: store.id,
            issueId: issue.id,
            previousStatus: issue.status,
            newStatus: "OPEN",
            changeReason: "Unignored manually on product page",
          },
        });
        await calculateAndSaveHealthScores(store.id, productId);
      }
    }
    return { success: true };
  }

  return { success: false };
};

export default function ProductHealthDetail() {
  const { product } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const handleRescan = () => {
    submit({ actionType: "RESCAN_PRODUCT" }, { method: "post" });
  };

  const handleIgnore = (issueId) => {
    submit({ actionType: "IGNORE_ISSUE", issueId }, { method: "post" });
  };

  const handleUnignore = (issueId) => {
    submit({ actionType: "UNIGNORE_ISSUE", issueId }, { method: "post" });
  };

  const issueRows = product.issues.map((issue) => [
    <Badge
      key={`sev-${issue.id}`}
      tone={
        issue.severity === "CRITICAL"
          ? "critical"
          : issue.severity === "WARNING"
          ? "warning"
          : "info"
      }
    >
      {issue.severity}
    </Badge>,
    <BlockStack key={`title-${issue.id}`} gap="100">
      <Text variant="bodyMd" fontWeight="bold">
        {issue.title}
      </Text>
      <Text variant="bodySm" tone="subdued">
        {issue.description}
      </Text>
    </BlockStack>,
    <Badge
      key={`stat-${issue.id}`}
      tone={
        issue.status === "OPEN"
          ? "attention"
          : issue.status === "RESOLVED"
          ? "success"
          : undefined
      }
    >
      {issue.status}
    </Badge>,
    <InlineStack key={`act-${issue.id}`} gap="200">
      {issue.status === "OPEN" && (
        <Button size="micro" tone="critical" onClick={() => handleIgnore(issue.id)}>
          Ignore
        </Button>
      )}
      {issue.status === "IGNORED" && (
        <Button size="micro" onClick={() => handleUnignore(issue.id)}>
          Unignore
        </Button>
      )}
    </InlineStack>,
  ]);

  const variantRows = product.variants.map((v) => [
    v.title || "Default",
    v.sku ? <Badge key={`sku-${v.id}`} tone="success">{v.sku}</Badge> : <Badge key={`sku-${v.id}`} tone="warning">Missing SKU</Badge>,
    v.barcode || "—",
    `$${Number(v.price).toFixed(2)}`,
    v.compareAtPrice ? `$${Number(v.compareAtPrice).toFixed(2)}` : "—",
  ]);

  const shopDomainPrefix = store.shopDomain.replace(".myshopify.com", "");
  const rawShopifyId = product.shopifyProductId?.split("/").pop();
  const shopifyAdminUrl = rawShopifyId ? `https://admin.shopify.com/store/${shopDomainPrefix}/products/${rawShopifyId}` : null;

  return (
    <Page
      fullWidth
      title={product.title}
      subtitle={`Vendor: ${product.vendor || 'N/A'} • Type: ${product.productType || 'N/A'} • Status: ${product.status}`}
      backAction={{ content: "Dashboard", url: "/app" }}
      primaryAction={{
        content: "Rescan Product",
        icon: RefreshIcon,
        loading: isLoading,
        onClick: handleRescan,
      }}
      secondaryActions={
        shopifyAdminUrl
          ? [
              {
                content: "Edit in Shopify Admin",
                url: shopifyAdminUrl,
                external: true,
              },
            ]
          : []
      }
    >
      <Layout>
        <Layout.Section variant="oneThird">
          <Card padding="500">
            <BlockStack gap="400" align="center">
              <Text variant="headingMd" as="h3" alignment="center">
                Product Health Score
              </Text>
              <div style={{ fontSize: "42px", fontWeight: "900", color: product.healthScore >= 80 ? "#108548" : "#d72c0d" }}>
                {product.healthScore.toFixed(0)}%
              </div>
              <ProgressBar
                progress={product.healthScore}
                tone={product.healthScore >= 80 ? "success" : "critical"}
              />
              <Text variant="bodySm" tone="subdued">
                Images: {product.imagesCount} • Variants: {product.variants.length}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="twoThirds">
          <Card padding="0">
            <Box padding="400">
              <Text variant="headingMd" as="h3">
                Detected Quality Issues ({product.issues.length})
              </Text>
            </Box>
            <Divider />
            {product.issues.length === 0 ? (
              <Box padding="500">
                <Text variant="bodyMd" tone="subdued">
                  No issues detected for this product. Catalog standards are fully satisfied.
                </Text>
              </Box>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["Severity", "Issue & Description", "Status", "Actions"]}
                rows={issueRows}
              />
            )}
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Box padding="400">
              <Text variant="headingMd" as="h3">
                Product Variants Quality Audit
              </Text>
            </Box>
            <Divider />
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text"]}
              headings={["Variant Title", "SKU", "Barcode", "Price", "Compare At Price"]}
              rows={variantRows}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
