import { useState } from "react";
import { useLoaderData, useSubmit, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  InlineStack,
  BlockStack,
  Badge,
  ProgressBar,
  Banner,
  DataTable,
  Tabs,
  TextField,
  Icon,
  Box,
  Divider,
} from "@shopify/polaris";
import {
  CheckCircleIcon,
  RefreshIcon,
  SearchIcon,
  ViewIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord, syncAndScanCatalog } from "../services/syncEngine.server.js";
import { calculateAndSaveHealthScores } from "../services/issueEngine.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);

  const totalProducts = await prisma.product.count({ where: { storeId: store.id } });
  const productsWithIssues = await prisma.product.count({
    where: { storeId: store.id, hasIssues: true },
  });

  const openIssuesCount = await prisma.issue.count({
    where: { storeId: store.id, status: "OPEN" },
  });

  const criticalIssuesCount = await prisma.issue.count({
    where: { storeId: store.id, status: "OPEN", severity: "CRITICAL" },
  });

  const warningIssuesCount = await prisma.issue.count({
    where: { storeId: store.id, status: "OPEN", severity: "WARNING" },
  });

  const infoIssuesCount = await prisma.issue.count({
    where: { storeId: store.id, status: "OPEN", severity: "INFO" },
  });

  const resolvedIssuesCount = await prisma.issue.count({
    where: { storeId: store.id, status: "RESOLVED" },
  });

  const ignoredIssuesCount = await prisma.issue.count({
    where: { storeId: store.id, status: "IGNORED" },
  });

  const lastScan = await prisma.catalogScan.findFirst({
    where: { storeId: store.id },
    orderBy: { startedAt: "desc" },
  });

  const issues = await prisma.issue.findMany({
    where: { storeId: store.id },
    include: {
      product: {
        select: { title: true, shopifyProductId: true },
      },
      variant: {
        select: { title: true, sku: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return {
    store,
    totalProducts,
    productsWithIssues,
    openIssuesCount,
    criticalIssuesCount,
    warningIssuesCount,
    infoIssuesCount,
    resolvedIssuesCount,
    ignoredIssuesCount,
    lastScan,
    issues,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "RUN_SCAN") {
    await syncAndScanCatalog(admin, store.id, "MANUAL");
    return { success: true, message: "Full catalog scan completed successfully!" };
  }

  if (actionType === "IGNORE_ISSUE") {
    const issueId = formData.get("issueId");
    if (issueId) {
      const issue = await prisma.issue.findUnique({ where: { id: issueId } });
      if (issue) {
        await prisma.issue.update({
          where: { id: issueId },
          data: { status: "IGNORED", ignoredAt: new Date() },
        });
        await prisma.issueHistory.create({
          data: {
            storeId: store.id,
            issueId,
            previousStatus: issue.status,
            newStatus: "IGNORED",
            changeReason: "Ignored manually by merchant",
          },
        });
        await calculateAndSaveHealthScores(store.id, issue.productId);
      }
    }
    return { success: true };
  }

  if (actionType === "UNIGNORE_ISSUE" || actionType === "REOPEN_ISSUE") {
    const issueId = formData.get("issueId");
    if (issueId) {
      const issue = await prisma.issue.findUnique({ where: { id: issueId } });
      if (issue) {
        await prisma.issue.update({
          where: { id: issueId },
          data: { status: "OPEN", ignoredAt: null, resolvedAt: null },
        });
        await prisma.issueHistory.create({
          data: {
            storeId: store.id,
            issueId,
            previousStatus: issue.status,
            newStatus: "OPEN",
            changeReason: "Reopened manually by merchant",
          },
        });
        await calculateAndSaveHealthScores(store.id, issue.productId);
      }
    }
    return { success: true };
  }

  return { success: false };
};

export default function Dashboard() {
  const {
    store,
    totalProducts,
    productsWithIssues,
    openIssuesCount,
    criticalIssuesCount,
    warningIssuesCount,
    infoIssuesCount,
    resolvedIssuesCount,
    ignoredIssuesCount,
    lastScan,
    issues,
  } = useLoaderData();

  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const [selectedTab, setSelectedTab] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

  const handleRunScan = () => {
    submit({ actionType: "RUN_SCAN" }, { method: "post" });
  };

  const handleIgnoreIssue = (issueId) => {
    submit({ actionType: "IGNORE_ISSUE", issueId }, { method: "post" });
  };

  const handleUnignoreIssue = (issueId) => {
    submit({ actionType: "UNIGNORE_ISSUE", issueId }, { method: "post" });
  };

  const tabs = [
    { id: "all", content: `Open (${openIssuesCount})` },
    { id: "critical", content: `Critical (${criticalIssuesCount})` },
    { id: "warning", content: `Warnings (${warningIssuesCount})` },
    { id: "info", content: `Info (${infoIssuesCount})` },
    { id: "resolved", content: `Resolved (${resolvedIssuesCount})` },
    { id: "ignored", content: `Ignored (${ignoredIssuesCount})` },
  ];

  const filteredIssues = issues.filter((issue) => {
    const activeTabId = tabs[selectedTab].id;
    if (activeTabId === "all" && issue.status !== "OPEN") return false;
    if (activeTabId === "critical" && (issue.status !== "OPEN" || issue.severity !== "CRITICAL")) return false;
    if (activeTabId === "warning" && (issue.status !== "OPEN" || issue.severity !== "WARNING")) return false;
    if (activeTabId === "info" && (issue.status !== "OPEN" || issue.severity !== "INFO")) return false;
    if (activeTabId === "resolved" && issue.status !== "RESOLVED") return false;
    if (activeTabId === "ignored" && issue.status !== "IGNORED") return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const titleMatch = issue.title.toLowerCase().includes(q);
      const prodMatch = issue.product?.title?.toLowerCase().includes(q);
      const skuMatch = issue.variant?.sku?.toLowerCase().includes(q);
      return titleMatch || prodMatch || skuMatch;
    }

    return true;
  });

  const getScoreColor = (score) => {
    if (score >= 85) return "#108548";
    if (score >= 60) return "#b86200";
    return "#d72c0d";
  };

  const scoreColor = getScoreColor(store.healthScore);

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
    <Text key={`title-${issue.id}`} variant="bodyMd" fontWeight="bold">
      {issue.title}
    </Text>,
    <Text key={`prod-${issue.id}`} variant="bodyMd">
      {issue.product?.title || "N/A"}
    </Text>,
    <Badge
      key={`stat-${issue.id}`}
      tone={
        issue.status === "OPEN"
          ? "attention"
          : issue.status === "RESOLVED"
          ? "success"
          : "subdued"
      }
    >
      {issue.status}
    </Badge>,
    <InlineStack key={`act-${issue.id}`} gap="2">
      {issue.status === "OPEN" && (
        <Button size="micro" tone="critical" onClick={() => handleIgnoreIssue(issue.id)}>
          Ignore
        </Button>
      )}
      {issue.status === "IGNORED" && (
        <Button size="micro" onClick={() => handleUnignoreIssue(issue.id)}>
          Unignore
        </Button>
      )}
      <Button
        size="micro"
        url={`/app/product/${issue.productId}`}
        icon={ViewIcon}
      >
        View
      </Button>
    </InlineStack>,
  ]);

  return (
    <Page
      title="Catalog Health Monitor"
      subtitle="Automated product catalog audits, quality metrics & issue tracking"
      primaryAction={{
        content: isLoading ? "Scanning Catalog..." : "Run Full Catalog Scan",
        icon: RefreshIcon,
        loading: isLoading,
        onClick: handleRunScan,
      }}
    >
      <BlockStack gap="5">
        {criticalIssuesCount > 0 && (
          <Banner
            title={`${criticalIssuesCount} Critical Catalog Issues Detected!`}
            tone="critical"
          >
            <p>
              Your store catalog has critical errors (missing images, zero/negative pricing, or duplicate SKUs) that impact customer purchases. Please review the critical issues below.
            </p>
          </Banner>
        )}

        <Layout>
          <Layout.Section variant="oneThird">
            <Card padding="500">
              <BlockStack gap="4" align="center">
                <Text variant="headingMd" as="h3" alignment="center">
                  Store Health Score
                </Text>
                <div style={{ textAlign: "center", position: "relative" }}>
                  <div
                    style={{
                      fontSize: "48px",
                      fontWeight: "900",
                      color: scoreColor,
                      lineHeight: "1",
                    }}
                  >
                    {store.healthScore.toFixed(1)}%
                  </div>
                  <Text variant="bodySm" tone="subdued" alignment="center">
                    {store.healthScore >= 85
                      ? "Excellent Catalog Health"
                      : store.healthScore >= 60
                      ? "Needs Attention"
                      : "Critical Fixes Required"}
                  </Text>
                </div>
                <ProgressBar
                  progress={store.healthScore}
                  tone={
                    store.healthScore >= 85
                      ? "success"
                      : store.healthScore >= 60
                      ? "highlight"
                      : "critical"
                  }
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="twoThirds">
            <Card padding="500">
              <BlockStack gap="4">
                <Text variant="headingMd" as="h3">
                  Catalog Overview Metrics
                </Text>
                <InlineStack gap="6" align="space-between">
                  <Box>
                    <Text variant="headingLg" as="p" fontWeight="bold">
                      {totalProducts}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Total Products
                    </Text>
                  </Box>

                  <Box>
                    <Text
                      variant="headingLg"
                      as="p"
                      fontWeight="bold"
                      tone={productsWithIssues > 0 ? "critical" : "success"}
                    >
                      {productsWithIssues}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Products with Issues
                    </Text>
                  </Box>

                  <Box>
                    <Text variant="headingLg" as="p" fontWeight="bold" tone="critical">
                      {criticalIssuesCount}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Critical Issues
                    </Text>
                  </Box>

                  <Box>
                    <Text variant="headingLg" as="p" fontWeight="bold" tone="caution">
                      {warningIssuesCount}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Warnings
                    </Text>
                  </Box>

                  <Box>
                    <Text variant="headingLg" as="p" fontWeight="bold" tone="success">
                      {resolvedIssuesCount}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Resolved
                    </Text>
                  </Box>
                </InlineStack>

                <Divider />

                <Text variant="bodySm" tone="subdued">
                  Last Full Audit:{" "}
                  {lastScan ? new Date(lastScan.startedAt).toLocaleString() : "Never"} •{" "}
                  Status: {lastScan ? lastScan.status : "Idle"}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Card padding="0">
          <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
            <Box padding="400">
              <BlockStack gap="4">
                <TextField
                  label=""
                  placeholder="Search issues by title, product name or SKU..."
                  value={searchQuery}
                  onChange={setSearchQuery}
                  prefix={<Icon source={SearchIcon} />}
                  clearButton
                  onClearButtonClick={() => setSearchQuery("")}
                  autoComplete="off"
                />

                {filteredIssues.length === 0 ? (
                  <Box padding="800" align="center">
                    <BlockStack align="center" inlineAlign="center" gap="2">
                      <Icon source={CheckCircleIcon} tone="success" />
                      <Text variant="headingSm">No issues found!</Text>
                      <Text variant="bodySm" tone="subdued">
                        Your store catalog meets all active quality rules for this selection.
                      </Text>
                    </BlockStack>
                  </Box>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text"]}
                    headings={["Severity", "Issue Title", "Product", "Status", "Actions"]}
                    rows={issueRows}
                  />
                )}
              </BlockStack>
            </Box>
          </Tabs>
        </Card>
      </BlockStack>
    </Page>
  );
}
