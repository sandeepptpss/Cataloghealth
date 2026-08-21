import { useLoaderData, useSubmit, useNavigation, useSearchParams, useNavigate } from "react-router";
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
  Pagination,
  Select,
  Spinner,
} from "@shopify/polaris";
import {
  CheckCircleIcon,
  RefreshIcon,
  SearchIcon,
  ViewIcon,
} from "@shopify/polaris-icons";
import { useCallback, useEffect, useState } from "react";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord } from "../services/syncEngine.server.js";
import { calculateAndSaveHealthScores } from "../services/issueEngine.server.js";
import {
  enqueueFullScan,
  ensureWorkerStarted,
  getQueueSnapshot,
  JOB_PRIORITY,
} from "../services/scanQueue.server.js";

const PAGE_SIZE = 10;

const TABS = [
  { id: "all", label: "Open", where: { status: "OPEN" } },
  { id: "critical", label: "Critical", where: { status: "OPEN", severity: "CRITICAL" } },
  { id: "warning", label: "Warnings", where: { status: "OPEN", severity: "WARNING" } },
  { id: "info", label: "Info", where: { status: "OPEN", severity: "INFO" } },
  { id: "resolved", label: "Resolved", where: { status: "RESOLVED" } },
  { id: "ignored", label: "Ignored", where: { status: "IGNORED" } },
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);

  // Keep the queue worker alive on a long-running server.
  ensureWorkerStarted();

  const url = new URL(request.url);
  const tabId = TABS.some((t) => t.id === url.searchParams.get("tab"))
    ? url.searchParams.get("tab")
    : "all";
  const query = (url.searchParams.get("q") || "").trim();
  const limitParsed = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = [10, 20, 50, 100].includes(limitParsed) ? limitParsed : 20;
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);

  const activeTab = TABS.find((t) => t.id === tabId);

  const upperQuery = query.toUpperCase();
  const severityMatches = ["CRITICAL", "WARNING", "INFO"].filter((s) => s.includes(upperQuery));

  const searchFilter = query
    ? {
        OR: [
          { title: { contains: query } },
          { description: { contains: query } },
          { fieldName: { contains: query } },
          { issueType: { contains: query } },
          ...(severityMatches.length > 0 ? [{ severity: { in: severityMatches } }] : []),
          { product: { title: { contains: query } } },
          { variant: { sku: { contains: query } } },
          { variant: { title: { contains: query } } },
        ],
      }
    : {};

  const issueWhere = { storeId: store.id, ...activeTab.where, ...searchFilter };

  const [
    totalProducts,
    productsWithIssues,
    openIssuesCount,
    criticalIssuesCount,
    warningIssuesCount,
    infoIssuesCount,
    resolvedIssuesCount,
    ignoredIssuesCount,
    alerts,
    lastScan,
    // The list and its count come from the same filter, so the tab badge and
    // the table can no longer disagree.
    filteredCount,
    issues,
    queue,
  ] = await Promise.all([
    prisma.product.count({ where: { storeId: store.id } }),
    prisma.product.count({ where: { storeId: store.id, hasIssues: true } }),
    prisma.issue.count({ where: { storeId: store.id, status: "OPEN" } }),
    prisma.issue.count({ where: { storeId: store.id, status: "OPEN", severity: "CRITICAL" } }),
    prisma.issue.count({ where: { storeId: store.id, status: "OPEN", severity: "WARNING" } }),
    prisma.issue.count({ where: { storeId: store.id, status: "OPEN", severity: "INFO" } }),
    prisma.issue.count({ where: { storeId: store.id, status: "RESOLVED" } }),
    prisma.issue.count({ where: { storeId: store.id, status: "IGNORED" } }),
    prisma.notification.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.catalogScan.findFirst({
      where: { storeId: store.id },
      orderBy: { startedAt: "desc" },
    }),
    prisma.issue.count({ where: issueWhere }),
    prisma.issue.findMany({
      where: issueWhere,
      include: {
        product: { select: { title: true, shopifyProductId: true } },
        variant: { select: { title: true, sku: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    getQueueSnapshot(store.id),
  ]);

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
    alerts,
    lastScan,
    issues,
    filteredCount,
    queue,
    tabId,
    query,
    page,
    pageSize: limit,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "RUN_SCAN") {
    // Queue it: a full catalog crawl cannot run inside an HTTP request without
    // timing out on a large store (spec #3, #18).
    await enqueueFullScan({
      storeId: store.id,
      scanType: "MANUAL",
      priority: JOB_PRIORITY.MANUAL_FULL_SCAN,
    });
    ensureWorkerStarted();
    return { success: true, message: "Full catalog scan queued. Progress appears in Scan Logs." };
  }

  if (actionType === "IGNORE_ISSUE") {
    const issueId = formData.get("issueId");
    if (issueId) {
      // Scoped by storeId so one shop can never mutate another shop's issue.
      const issue = await prisma.issue.findFirst({
        where: { id: issueId, storeId: store.id },
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
      const issue = await prisma.issue.findFirst({
        where: { id: issueId, storeId: store.id },
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
    alerts,
    lastScan,
    issues,
    filteredCount,
    queue,
    tabId,
    query,
    page,
    pageSize,
  } = useLoaderData();
  const navigate = useNavigate();
  const activeTab = TABS.find((t) => t.id === tabId) || TABS[0];

  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isLoading = navigation.state !== "idle";

  const [searchInput, setSearchInput] = useState(query);

  // Keep the box in step when the URL changes from elsewhere (back button).
  useEffect(() => {
    setSearchInput(query);
  }, [query]);

  // Search runs on the server now, so debounce the round trip.
  useEffect(() => {
    if (searchInput === query) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (searchInput.trim()) next.set("q", searchInput.trim());
      else next.delete("q");
      next.delete("page");
      setSearchParams(next, { replace: true, preventScrollReset: true });
    }, 350);
    return () => clearTimeout(timer);
  }, [searchInput, query, searchParams, setSearchParams]);

  const updateParams = useCallback(
    (changes) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) next.delete(key);
        else next.set(key, String(value));
      }
      setSearchParams(next, { preventScrollReset: true });
    },
    [searchParams, setSearchParams],
  );

  const handleRunScan = () => {
    submit({ actionType: "RUN_SCAN" }, { method: "post" });
  };

  const handleIgnoreIssue = (issueId) => {
    submit({ actionType: "IGNORE_ISSUE", issueId }, { method: "post" });
  };

  const handleUnignoreIssue = (issueId) => {
    submit({ actionType: "UNIGNORE_ISSUE", issueId }, { method: "post" });
  };

  const tabCounts = {
    all: openIssuesCount,
    critical: criticalIssuesCount,
    warning: warningIssuesCount,
    info: infoIssuesCount,
    resolved: resolvedIssuesCount,
    ignored: ignoredIssuesCount,
  };

  const tabs = TABS.map((t) => ({
    id: t.id,
    content: `${t.label} (${tabCounts[t.id]})`,
  }));

  const selectedTab = Math.max(0, TABS.findIndex((t) => t.id === tabId));

  const getScoreColor = (score) => {
    if (score >= 85) return "#108548";
    if (score >= 60) return "#b86200";
    return "#d72c0d";
  };

  const scoreColor = getScoreColor(store.healthScore);
  const scanRunning = queue.PENDING > 0 || queue.PROCESSING > 0;

  const issueRows = issues.map((issue) => [
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
          : undefined
      }
    >
      {issue.status}
    </Badge>,
    <InlineStack key={`act-${issue.id}`} gap="200">
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
        icon={ViewIcon}
        onClick={() => navigate(`/app/product/${issue.productId}`)}
      >
        View Details
      </Button>
    </InlineStack>,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredCount / pageSize));

  return (
    <Page
      fullWidth
      title="Catalog Health Monitor"
      subtitle="Automated product catalog audits, quality metrics & issue tracking"
      primaryAction={{
        content: scanRunning ? "Scan in progress..." : "Run Full Catalog Scan",
        icon: RefreshIcon,
        loading: isLoading,
        disabled: scanRunning,
        onClick: handleRunScan,
      }}
    >
      <BlockStack gap="500">
        {scanRunning && (
          <Banner tone="info" title="Catalog scan running in the background">
            <p>
              {queue.PROCESSING > 0
                ? "Products are being synced and validated right now."
                : `${queue.PENDING} scan job(s) queued.`}{" "}
              Reload this page to see updated results.
            </p>
          </Banner>
        )}

        {criticalIssuesCount > 0 && (
          <Banner
            title={`${criticalIssuesCount} Critical Catalog Issues Detected!`}
            tone="critical"
            action={{
              content: "View Critical Issues ↗",
              onClick: () => updateParams({ tab: "critical", page: 1 }),
            }}
          >
            <p>
              Your store catalog has critical errors (missing images, zero/negative pricing, or duplicate SKUs) that impact customer purchases. Click above to view and resolve them immediately.
            </p>
          </Banner>
        )}

        <Layout>
          <Layout.Section variant="oneThird">
            <Card padding="500">
              <BlockStack gap="400" align="center">
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
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">
                  Catalog Overview Metrics
                </Text>
                <InlineStack gap="300" wrap={false} align="space-between">
                  <Box
                    padding="300"
                    borderRadius="200"
                    background="bg-surface-secondary"
                    style={{ flex: 1, textAlign: "center" }}
                  >
                    <Text variant="headingLg" as="p" fontWeight="bold">
                      {totalProducts}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Total Products
                    </Text>
                  </Box>

                  <Box
                    padding="300"
                    borderRadius="200"
                    background="bg-surface-secondary"
                    style={{ flex: 1, textAlign: "center" }}
                  >
                    <Text
                      variant="headingLg"
                      as="p"
                      fontWeight="bold"
                      tone={productsWithIssues > 0 ? "critical" : "success"}
                    >
                      {productsWithIssues}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Products w/ Issues
                    </Text>
                  </Box>

                  <Box
                    padding="300"
                    borderRadius="200"
                    background="bg-surface-secondary"
                    onClick={() => updateParams({ tab: "critical", page: 1 })}
                    style={{ flex: 1, textAlign: "center", cursor: "pointer", border: "1px solid rgba(224, 0, 0, 0.15)" }}
                    title="Click to view Critical Issues"
                  >
                    <Text variant="headingLg" as="p" fontWeight="bold" tone="critical">
                      {criticalIssuesCount}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Critical Issues ↗
                    </Text>
                  </Box>

                  <Box
                    padding="300"
                    borderRadius="200"
                    background="bg-surface-secondary"
                    onClick={() => updateParams({ tab: "warning", page: 1 })}
                    style={{ flex: 1, textAlign: "center", cursor: "pointer", border: "1px solid rgba(235, 140, 0, 0.15)" }}
                    title="Click to view Warning Issues"
                  >
                    <Text variant="headingLg" as="p" fontWeight="bold" tone="caution">
                      {warningIssuesCount}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Warnings ↗
                    </Text>
                  </Box>

                  <Box
                    padding="300"
                    borderRadius="200"
                    background="bg-surface-secondary"
                    onClick={() => updateParams({ tab: "resolved", page: 1 })}
                    style={{ flex: 1, textAlign: "center", cursor: "pointer", border: "1px solid rgba(0, 160, 0, 0.15)" }}
                    title="Click to view Resolved Issues"
                  >
                    <Text variant="headingLg" as="p" fontWeight="bold" tone="success">
                      {resolvedIssuesCount}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Resolved ↗
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

        {alerts.length > 0 && (
          <Card padding="500">
            <BlockStack gap="300">
              <Text variant="headingMd" as="h3">
                Recent Alerts
              </Text>
              <Text variant="bodySm" tone="subdued">
                Click any alert card below to filter matching issues in the table.
              </Text>
              <BlockStack gap="200">
                {alerts.map((alert) => (
                  <Box
                    key={alert.id}
                    padding="300"
                    borderRadius="200"
                    background="bg-surface-secondary"
                    onClick={() => updateParams({ tab: alert.criticalCount > 0 ? "critical" : "all", page: 1 })}
                    style={{
                      cursor: "pointer",
                      borderLeft: alert.criticalCount > 0 ? "4px solid var(--p-color-bg-fill-critical)" : "4px solid var(--p-color-bg-fill-info)",
                    }}
                    title="Click to filter issues for this alert"
                  >
                    <BlockStack gap="100">
                      <InlineStack gap="200" blockAlign="center" align="space-between">
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={alert.criticalCount > 0 ? "critical" : "info"}>
                            {alert.type === "CRITICAL_ALERT" ? "Critical Alert" : "Daily Digest"}
                          </Badge>
                          <Text variant="bodyMd" fontWeight="bold">
                            {alert.title}
                          </Text>
                          <Badge tone={alert.status === "SENT" ? "success" : "attention"}>
                            {alert.status}
                          </Badge>
                        </InlineStack>
                        <Button size="micro" variant="tertiary">
                          Filter Matching Issues ↗
                        </Button>
                      </InlineStack>
                      <Text variant="bodySm" tone="subdued">
                        Logged on: {new Date(alert.createdAt).toLocaleString()}
                      </Text>
                    </BlockStack>
                  </Box>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        <Card padding="0">
          <Tabs
            tabs={tabs}
            selected={selectedTab}
            onSelect={(index) => updateParams({ tab: TABS[index].id, page: null })}
          >
            <Box padding="400">
              <BlockStack gap="300">
                <InlineStack gap="300" align="space-between" blockAlign="center">
                  <Box style={{ flex: 1 }}>
                    <TextField
                      label="Search issues"
                      labelHidden
                      placeholder="Search issues by title, description, SKU, field name or severity..."
                      value={searchInput}
                      onChange={setSearchInput}
                      prefix={<Icon source={SearchIcon} />}
                      suffix={isLoading ? <Spinner size="small" /> : null}
                      clearButton
                      onClearButtonClick={() => {
                        setSearchInput("");
                        updateParams({ q: null, page: 1 });
                      }}
                      autoComplete="off"
                    />
                  </Box>
                  <InlineStack gap="200" blockAlign="center">
                    <Button
                      size="medium"
                      tone={tabId === "critical" ? "critical" : undefined}
                      variant={tabId === "critical" ? "primary" : "secondary"}
                      onClick={() => updateParams({ tab: "critical", page: 1 })}
                    >
                      Critical Only ({criticalIssuesCount})
                    </Button>
                    <Button
                      size="medium"
                      onClick={() => updateParams({ tab: "warning", page: 1 })}
                      variant={tabId === "warning" ? "primary" : "secondary"}
                    >
                      Warnings ({warningIssuesCount})
                    </Button>
                    {(searchInput || tabId !== "all") && (
                      <Button
                        size="medium"
                        tone="critical"
                        variant="tertiary"
                        onClick={() => {
                          setSearchInput("");
                          updateParams({ tab: "all", q: null, page: 1 });
                        }}
                      >
                        Reset Filters
                      </Button>
                    )}
                  </InlineStack>
                </InlineStack>

                {(searchInput || tabId !== "all") && (
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="bodySm" tone="subdued">
                      Active Filters:
                    </Text>
                    {tabId !== "all" && (
                      <Badge
                        tone={tabId === "critical" ? "critical" : "info"}
                        onDismiss={() => updateParams({ tab: "all", page: 1 })}
                      >
                        Status: {activeTab.label}
                      </Badge>
                    )}
                    {searchInput && (
                      <Badge onDismiss={() => setSearchInput("")}>
                        Query: "{searchInput}"
                      </Badge>
                    )}
                  </InlineStack>
                )}

                {issues.length === 0 ? (
                  <Box padding="800">
                    <BlockStack align="center" inlineAlign="center" gap="200">
                      <Icon source={CheckCircleIcon} tone="success" />
                      <Text variant="headingSm">No issues found!</Text>
                      <Text variant="bodySm" tone="subdued">
                        Your store catalog meets all active quality rules for this selection.
                      </Text>
                    </BlockStack>
                  </Box>
                ) : (
                  <BlockStack gap="400">
                    <DataTable
                      columnContentTypes={["text", "text", "text", "text", "text"]}
                      headings={["Severity", "Issue Title", "Product", "Status", "Actions"]}
                      rows={issueRows}
                    />
                    <Box paddingBlockStart="300" paddingBlockEnd="100">
                      <Divider />
                      <Box paddingBlockStart="300">
                        <InlineStack align="space-between" blockAlign="center">
                          <InlineStack gap="400" blockAlign="center">
                            <Text variant="bodySm" tone="subdued">
                              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, filteredCount)} of {filteredCount} issues
                            </Text>
                            <InlineStack gap="200" blockAlign="center">
                              <Text variant="bodySm" tone="subdued">
                                Per page:
                              </Text>
                              <div style={{ width: "130px" }}>
                                <Select
                                  label="Items per page"
                                  labelHidden
                                  options={[
                                    { label: "10", value: "10" },
                                    { label: "20", value: "20" },
                                    { label: "50", value: "50" },
                                    { label: "100", value: "100" },
                                  ]}
                                  value={String(pageSize)}
                                  onChange={(val) => updateParams({ limit: val, page: 1 })}
                                />
                              </div>
                            </InlineStack>
                          </InlineStack>

                          <Pagination
                            hasPrevious={page > 1}
                            onPrevious={() => updateParams({ page: page - 1 })}
                            hasNext={page < totalPages}
                            onNext={() => updateParams({ page: page + 1 })}
                            label={`Page ${page} of ${totalPages}`}
                          />
                        </InlineStack>
                      </Box>
                    </Box>
                  </BlockStack>
                )}
              </BlockStack>
            </Box>
          </Tabs>
        </Card>
      </BlockStack>
    </Page>
  );
}
