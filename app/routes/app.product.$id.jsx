import { useLoaderData, useSubmit, useNavigation } from "react-router";
import {
  Page,
  Card,
  Text,
  Badge,
  DataTable,
  Button,
  BlockStack,
  InlineStack,
  Box,
  Divider,
  Tabs,
} from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord, syncAndScanSingleProduct } from "../services/syncEngine.server.js";
import { calculateAndSaveHealthScores } from "../services/issueEngine.server.js";
import {
  featureUpgradeMessage,
  getPlanConfig,
  serializablePlanConfig,
} from "../services/planEngine.server.js";
import { autoFixIssue } from "../services/autoFixEngine.server.js";

export const loader = async ({ params, request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const planConfig = getPlanConfig(store.plan);
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

  const inventoryLevels =
    planConfig.multiLocation && prisma.inventoryLevel
      ? await prisma.inventoryLevel.findMany({
          where: { storeId: store.id, variantId: { in: product.variants.map((v) => v.id) } },
          orderBy: [{ locationName: "asc" }],
        })
      : [];

  return {
    store,
    product,
    planConfig: serializablePlanConfig(store.plan),
    inventoryLevels,
    autoFixUpgradeMessage: planConfig.autoFix ? null : featureUpgradeMessage("autoFix"),
  };
};

export const action = async ({ params, request }) => {
  const { admin, session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const productId = params.id;

  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "AUTO_FIX_ISSUE") {
    const issueId = formData.get("issueId");
    if (!issueId) return { success: false, error: "Issue ID is required." };
    try {
      const res = await autoFixIssue(admin, store.id, issueId);
      return { success: true, message: res.message };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (actionType === "RESCAN_PRODUCT") {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId: store.id },
    });
    if (!product) {
      return { success: false, error: "Product not found." };
    }
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
  const { store, product, planConfig, inventoryLevels, autoFixUpgradeMessage } =
    useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const [issueFilterTab, setIssueFilterTab] = useState(0);

  const handleRescan = () => {
    submit({ actionType: "RESCAN_PRODUCT" }, { method: "post" });
  };

  const handleIgnore = (issueId) => {
    submit({ actionType: "IGNORE_ISSUE", issueId }, { method: "post" });
  };

  const handleUnignore = (issueId) => {
    submit({ actionType: "UNIGNORE_ISSUE", issueId }, { method: "post" });
  };

  const handleAutoFix = (issueId) => {
    submit({ actionType: "AUTO_FIX_ISSUE", issueId }, { method: "post" });
  };

  const getScoreTheme = (score) => {
    if (score >= 75) {
      return {
        bg: "linear-gradient(135deg, #ECFDF5 0%, #D1FAE5 100%)",
        border: "1px solid #6EE7B7",
        color: "#047857",
        textTone: "success",
        label: "Optimal Quality",
        barBg: "linear-gradient(90deg, #10B981 0%, #059669 100%)",
      };
    } else if (score >= 50) {
      return {
        bg: "linear-gradient(135deg, #F0FDF4 0%, #DCFCE7 100%)",
        border: "1px solid #A7F3D0",
        color: "#065F46",
        textTone: "success",
        label: "Good Quality",
        barBg: "linear-gradient(90deg, #34D399 0%, #059669 100%)",
      };
    } else {
      return {
        bg: "linear-gradient(135deg, #FEF2F2 0%, #FEE2E2 100%)",
        border: "1px solid #FCA5A5",
        color: "#B91C1C",
        textTone: "critical",
        label: "Action Needed",
        barBg: "linear-gradient(90deg, #F87171 0%, #DC2626 100%)",
      };
    }
  };

  const scoreTheme = getScoreTheme(product.healthScore);

  const openIssuesCount = product.issues.filter((i) => i.status === "OPEN").length;
  const resolvedIssuesCount = product.issues.filter((i) => i.status === "RESOLVED").length;

  const issueTabs = [
    { id: "all", content: `All (${product.issues.length})` },
    { id: "open", content: `Open (${openIssuesCount})` },
    { id: "resolved", content: `Resolved (${resolvedIssuesCount})` },
  ];

  const filteredIssues = product.issues.filter((issue) => {
    if (issueFilterTab === 1) return issue.status === "OPEN";
    if (issueFilterTab === 2) return issue.status === "RESOLVED";
    return true;
  });

  const issueRows = filteredIssues.map((issue) => [
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
    (() => {
      const rawTitle = issue.title || "";
      const cleanTitle = rawTitle.includes('"')
        ? rawTitle.replace(/"[^"]+"/g, "").replace(/\s+/g, " ").trim()
        : rawTitle;

      const fieldParts = issue.fieldName && issue.fieldName.includes(".")
        ? issue.fieldName.split(".")
        : null;

      return (
        <div key={`title-${issue.id}`} style={{ wordBreak: "break-word", whiteSpace: "normal" }}>
          <BlockStack gap="100">
            <Text variant="bodyMd" fontWeight="bold" as="span">
              {cleanTitle || rawTitle}
            </Text>
            {fieldParts ? (
              <InlineStack gap="100" blockAlign="center">
                <Badge tone="subdued" size="small">
                  {`Metafield: ${fieldParts[0]} › ${fieldParts.slice(1).join(".")}`}
                </Badge>
              </InlineStack>
            ) : issue.fieldName ? (
              <InlineStack gap="100" blockAlign="center">
                <Badge tone="subdued" size="small">
                  {`Field: ${issue.fieldName}`}
                </Badge>
              </InlineStack>
            ) : null}
            {issue.description && (
              <Text variant="bodySm" tone="subdued">
                {issue.description}
              </Text>
            )}
          </BlockStack>
        </div>
      );
    })(),
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
        <>
          {planConfig.autoFix && (
            <Button
              size="micro"
              variant="primary"
              tone="success"
              onClick={() => handleAutoFix(issue.id)}
            >
              Auto-Fix ⚡
            </Button>
          )}
          <Button size="micro" tone="critical" onClick={() => handleIgnore(issue.id)}>
            Ignore
          </Button>
        </>
      )}
      {issue.status === "IGNORED" && (
        <Button size="micro" onClick={() => handleUnignore(issue.id)}>
          Unignore
        </Button>
      )}
    </InlineStack>,
  ]);

  const levelsByVariant = inventoryLevels.reduce((acc, level) => {
    (acc[level.variantId] ||= []).push(level);
    return acc;
  }, {});

  const variantRows = product.variants.map((v) => {
    const levels = levelsByVariant[v.id] || [];
    const row = [
      <Text key={`title-${v.id}`} variant="bodyMd" fontWeight="bold">
        {v.title || "Default"}
      </Text>,
      v.sku ? (
        <code
          key={`sku-${v.id}`}
          style={{
            background: "#F3F4F6",
            padding: "3px 8px",
            borderRadius: "6px",
            fontSize: "12px",
            fontFamily: "monospace",
            color: "#1F2937",
          }}
        >
          {v.sku}
        </code>
      ) : (
        <Badge key={`sku-${v.id}`} tone="warning">Missing SKU</Badge>
      ),
      v.barcode ? (
        <code
          key={`bar-${v.id}`}
          style={{
            background: "#F3F4F6",
            padding: "3px 8px",
            borderRadius: "6px",
            fontSize: "12px",
            fontFamily: "monospace",
            color: "#1F2937",
          }}
        >
          {v.barcode}
        </code>
      ) : (
        <Badge key={`bar-${v.id}`} tone="warning">Missing Barcode</Badge>
      ),
      <Text key={`price-${v.id}`} variant="bodyMd" fontWeight="semibold">
        {`$${Number(v.price).toFixed(2)}`}
      </Text>,
      v.compareAtPrice ? `$${Number(v.compareAtPrice).toFixed(2)}` : "—",
    ];

    if (planConfig.multiLocation) {
      const total = levels.reduce((sum, l) => sum + l.available, 0);
      row.push(
        levels.length === 0 ? (
          <Badge key={`stock-${v.id}`} tone="warning">No stocked location</Badge>
        ) : (
          <Text key={`stock-${v.id}`} variant="bodySm">
            {`${total} available across ${levels.length} location(s): `}
            {levels.map((l) => `${l.locationName || l.shopifyLocationId} (${l.available})`).join(", ")}
          </Text>
        ),
      );
    }

    return row;
  });

  const variantColumns = planConfig.multiLocation
    ? ["text", "text", "text", "text", "text", "text"]
    : ["text", "text", "text", "text", "text"];

  const variantHeadings = [
    "Variant Title",
    "SKU",
    "Barcode / GTIN",
    "Price",
    "Compare At Price",
    ...(planConfig.multiLocation ? ["Multi-Location Stock"] : []),
  ];

  const shopDomainPrefix = store.shopDomain.replace(".myshopify.com", "");
  const rawShopifyId = product.shopifyProductId?.split("/").pop();
  const shopifyAdminUrl = rawShopifyId ? `https://admin.shopify.com/store/${shopDomainPrefix}/products/${rawShopifyId}` : null;

  return (
    <Page fullWidth backAction={{ content: "Dashboard", url: "/app" }}>
      <Box paddingBlockEnd="1000">
        <BlockStack gap="500">
          {/* Header Card */}
          <Card padding="500">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <Text variant="headingLg" as="h1" fontWeight="bold">
                    {product.title}
                  </Text>
                  <Badge tone={product.status === "ACTIVE" ? "success" : "subdued"}>
                    {product.status}
                  </Badge>
                </InlineStack>
                <Text variant="bodySm" tone="subdued">
                  {`Vendor: ${product.vendor || 'N/A'} • Type: ${product.productType || 'N/A'}`}
                </Text>
              </BlockStack>
              <InlineStack gap="200">
                {shopifyAdminUrl && (
                  <Button url={shopifyAdminUrl} external size="large">
                    Edit in Shopify Admin
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="large"
                  icon={RefreshIcon}
                  loading={isLoading}
                  onClick={handleRescan}
                >
                  Rescan Product
                </Button>
              </InlineStack>
            </InlineStack>
          </Card>

          {/* Top Row: 3 Equal Executive Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
            <Card padding="500">
              <BlockStack gap="300" align="center">
                <Text variant="headingMd" as="h3" fontWeight="bold" alignment="center">
                  Product Health Score
                </Text>
                <div
                  style={{
                    textAlign: "center",
                    padding: "16px 20px",
                    borderRadius: "14px",
                    background: scoreTheme.bg,
                    border: scoreTheme.border,
                    boxShadow: "0 2px 10px rgba(0,0,0,0.03)",
                    width: "100%",
                  }}
                >
                  <div
                    style={{
                      fontSize: "44px",
                      fontWeight: "900",
                      letterSpacing: "-1.5px",
                      color: scoreTheme.color,
                      lineHeight: "1.05",
                    }}
                  >
                    {product.healthScore.toFixed(0)}%
                  </div>
                  <div style={{ marginTop: "4px" }}>
                    <Text variant="bodyMd" fontWeight="bold" tone={scoreTheme.textTone}>
                      {scoreTheme.label}
                    </Text>
                  </div>
                </div>

                <div
                  style={{
                    width: "100%",
                    height: "8px",
                    borderRadius: "4px",
                    background: "#E5E7EB",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, Math.max(0, product.healthScore))}%`,
                      height: "100%",
                      background: scoreTheme.barBg,
                      borderRadius: "4px",
                      transition: "width 0.5s ease-in-out",
                    }}
                  />
                </div>

                <InlineStack gap="150" align="center" wrap>
                  <Badge tone="subdued">📷 {product.imagesCount} Image(s)</Badge>
                  <Badge tone="subdued">📦 {product.variants.length} Variant(s)</Badge>
                  <Badge tone={openIssuesCount > 0 ? "critical" : "success"}>
                    ⚠️ {openIssuesCount} Open
                  </Badge>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card padding="500">
              <BlockStack gap="300">
                <Text variant="headingMd" as="h3" fontWeight="bold">
                  Product Details
                </Text>
                <Divider />
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">Vendor</Text>
                    <Text variant="bodySm" fontWeight="bold">{product.vendor || "N/A"}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">Product Type</Text>
                    <Text variant="bodySm" fontWeight="bold">{product.productType || "N/A"}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">Status</Text>
                    <Badge tone={product.status === "ACTIVE" ? "success" : "subdued"}>{product.status}</Badge>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">Total Variants</Text>
                    <Text variant="bodySm" fontWeight="bold">{product.variants.length}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">Product Images</Text>
                    <Text variant="bodySm" fontWeight="bold">{product.imagesCount}</Text>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card padding="500">
              <BlockStack gap="300">
                <Text variant="headingMd" as="h3" fontWeight="bold">
                  Audit Summary
                </Text>
                <Divider />
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="bodySm">Barcode / GTIN</Text>
                    <Badge tone={product.issues.filter(i => i.issueType === "MISSING_BARCODE" && i.status === "OPEN").length > 0 ? "warning" : "success"}>
                      {product.issues.filter(i => i.issueType === "MISSING_BARCODE" && i.status === "OPEN").length} Open
                    </Badge>
                  </InlineStack>
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="bodySm">SKU Assignment</Text>
                    <Badge tone={product.issues.filter(i => i.issueType === "MISSING_SKU" && i.status === "OPEN").length > 0 ? "warning" : "success"}>
                      {product.issues.filter(i => i.issueType === "MISSING_SKU" && i.status === "OPEN").length} Open
                    </Badge>
                  </InlineStack>
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="bodySm">Metafield Rules</Text>
                    <Badge tone={product.issues.filter(i => i.issueType === "MISSING_METAFIELD" && i.status === "OPEN").length > 0 ? "warning" : "success"}>
                      {product.issues.filter(i => i.issueType === "MISSING_METAFIELD" && i.status === "OPEN").length} Open
                    </Badge>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>
          </div>

          {/* Full Width Detected Issues Card */}
          <Card padding="0">
            <Box padding="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h3" fontWeight="bold">
                  Detected Quality Issues ({product.issues.length})
                </Text>
              </InlineStack>
            </Box>
            <Tabs
              tabs={issueTabs}
              selected={issueFilterTab}
              onSelect={setIssueFilterTab}
            >
              <Box padding="0">
                {autoFixUpgradeMessage && product.issues.length > 0 && (
                  <Box padding="300">
                    <Text variant="bodySm" tone="subdued">
                      {autoFixUpgradeMessage}
                    </Text>
                  </Box>
                )}
                <Divider />
                {filteredIssues.length === 0 ? (
                  <Box padding="500">
                    <Text variant="bodyMd" tone="subdued">
                      No matching issues for this tab view.
                    </Text>
                  </Box>
                ) : (
                  <Box overflowX="auto">
                    <DataTable
                      columnContentTypes={["text", "text", "text", "text"]}
                      headings={["Severity", "Issue & Description", "Status", "Actions"]}
                      rows={issueRows}
                    />
                  </Box>
                )}
              </Box>
            </Tabs>
          </Card>

          {/* Full Width Variants Audit Card */}
          <Card padding="0">
            <Box padding="400">
              <Text variant="headingMd" as="h3" fontWeight="bold">
                Product Variants Quality Audit
              </Text>
            </Box>
            <Divider />
            <Box overflowX="auto">
              <DataTable
                columnContentTypes={variantColumns}
                headings={variantHeadings}
                rows={variantRows}
              />
            </Box>
          </Card>
        </BlockStack>
      </Box>
    </Page>
  );
}
