import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
  useSearchParams,
  useNavigate,
  useRevalidator,
  Link,
} from "react-router";
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
  Checkbox,
} from "@shopify/polaris";
import {
  CheckCircleIcon,
  RefreshIcon,
  SearchIcon,
  ViewIcon,
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  MagicIcon,
  ExportIcon,
} from "@shopify/polaris-icons";
import { useCallback, useEffect, useState } from "react";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord } from "../services/syncEngine.server.js";
import { calculateAndSaveHealthScores } from "../services/issueEngine.server.js";
import {
  checkManualScanAllowance,
  enqueueFullScan,
  ensureWorkerStarted,
  getQueueSnapshot,
  JOB_PRIORITY,
} from "../services/scanQueue.server.js";
import { serializablePlanConfig } from "../services/planEngine.server.js";
import { autoFixIssue } from "../services/autoFixEngine.server.js";

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

  const planConfig = serializablePlanConfig(store.plan);
  const scanAllowance = await checkManualScanAllowance(store.id, store.plan);

  return {
    store,
    planConfig,
    scanAllowance,
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
  const { admin, session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
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

  if (actionType === "BULK_AUTO_FIX") {
    const issueIdsRaw = formData.get("issueIds");
    if (!issueIdsRaw) return { success: false, error: "No issues selected for bulk fix." };
    try {
      const issueIds = JSON.parse(issueIdsRaw);
      let successCount = 0;
      let failCount = 0;
      for (const issueId of issueIds) {
        try {
          await autoFixIssue(admin, store.id, issueId);
          successCount++;
        } catch {
          failCount++;
        }
      }
      return {
        success: true,
        message: `Bulk Auto-Fix completed: ${successCount} issue(s) successfully repaired${failCount > 0 ? `, ${failCount} failed` : ""}.`,
      };
    } catch (err) {
      return { success: false, error: err.message || "Failed to process bulk auto-fix." };
    }
  }

  if (actionType === "RUN_SCAN") {
    // On-demand scans are a plan feature ("weekly manual catalog scan" on
    // Starter, unlimited on Plus Enterprise), so the allowance is checked before
    // anything is queued.
    const allowance = await checkManualScanAllowance(store.id, store.plan);
    if (!allowance.allowed) {
      return { success: false, error: allowance.message };
    }

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
    planConfig,
    scanAllowance,
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
  const revalidator = useRevalidator();
  const actionData = useActionData();
  const activeTab = TABS.find((t) => t.id === tabId) || TABS[0];

  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isLoading = navigation.state !== "idle";

  const [searchInput, setSearchInput] = useState(query);
  const [showAlerts, setShowAlerts] = useState(false);

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

  const isScanning = (queue?.PENDING || 0) > 0 || (queue?.PROCESSING || 0) > 0;

  // Auto-poll loader data silently without scrolling/jumping while scan is running in background
  useEffect(() => {
    if (!isScanning) return;

    const interval = setInterval(() => {
      if (revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [isScanning, revalidator]);

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

  const handleAutoFix = (issueId) => {
    submit({ actionType: "AUTO_FIX_ISSUE", issueId }, { method: "post" });
  };

  const [selectedIssueIds, setSelectedIssueIds] = useState([]);

  const handleToggleSelect = (issueId, checked) => {
    if (checked) {
      setSelectedIssueIds((prev) => [...prev, issueId]);
    } else {
      setSelectedIssueIds((prev) => prev.filter((id) => id !== issueId));
    }
  };

  const handleToggleSelectAll = (checked) => {
    if (checked) {
      setSelectedIssueIds(issues.map((i) => i.id));
    } else {
      setSelectedIssueIds([]);
    }
  };

  const handleBulkAutoFix = () => {
    if (selectedIssueIds.length === 0) return;
    submit(
      { actionType: "BULK_AUTO_FIX", issueIds: JSON.stringify(selectedIssueIds) },
      { method: "post" }
    );
    setSelectedIssueIds([]);
  };

  const handleExportCSV = (exportItems) => {
    const itemsToExport = exportItems || issues;
    if (!itemsToExport || itemsToExport.length === 0) return;

    const headers = ["Issue ID", "Severity", "Title", "Field Name", "Product Title", "Variant SKU", "Status", "Created At"];
    const rows = itemsToExport.map((i) => [
      `"${i.id}"`,
      `"${i.severity}"`,
      `"${(i.title || "").replace(/"/g, '""')}"`,
      `"${(i.fieldName || "").replace(/"/g, '""')}"`,
      `"${(i.product?.title || "").replace(/"/g, '""')}"`,
      `"${(i.variant?.sku || "").replace(/"/g, '""')}"`,
      `"${i.status}"`,
      `"${new Date(i.createdAt).toISOString()}"`,
    ]);

    const csvData = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csvData], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `cataloghealth_audit_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
    <div key={`chk-${issue.id}`} style={{ display: "flex", alignItems: "center" }}>
      <Checkbox
        labelHidden
        label={`Select issue ${issue.id}`}
        checked={selectedIssueIds.includes(issue.id)}
        onChange={(checked) => handleToggleSelect(issue.id, checked)}
      />
    </div>,
    <Box key={`sev-${issue.id}`}>
      <Badge
        tone={
          issue.severity === "CRITICAL"
            ? "critical"
            : issue.severity === "WARNING"
            ? "warning"
            : "info"
        }
      >
        {issue.severity}
      </Badge>
    </Box>,
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
          </BlockStack>
        </div>
      );
    })(),
    <div key={`prod-${issue.id}`} style={{ wordBreak: "break-word", whiteSpace: "normal" }}>
      <Button
        variant="plain"
        onClick={() => navigate(`/app/product/${issue.productId}`)}
        accessibilityLabel={`View product details for ${issue.product?.title || "Product"}`}
      >
        <Text variant="bodyMd" fontWeight="bold" as="span">
          {issue.product?.title || "N/A"}
        </Text>
      </Button>
    </div>,
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
    <InlineStack key={`act-${issue.id}`} gap="200" blockAlign="center">
      {issue.status === "OPEN" && planConfig.autoFix && (
        <Button
          size="micro"
          variant="primary"
          icon={MagicIcon}
          onClick={() => handleAutoFix(issue.id)}
        >
          Auto-Fix
        </Button>
      )}
      {issue.status === "OPEN" && (
        <Button
          size="micro"
          variant="tertiary"
          tone="critical"
          onClick={() => handleIgnoreIssue(issue.id)}
        >
          Ignore
        </Button>
      )}
      {issue.status === "IGNORED" && (
        <Button size="micro" variant="tertiary" onClick={() => handleUnignoreIssue(issue.id)}>
          Unignore
        </Button>
      )}
      <Button
        size="micro"
        variant="secondary"
        icon={ViewIcon}
        onClick={() => navigate(`/app/product/${issue.productId}`)}
      >
        View Details
      </Button>
    </InlineStack>,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredCount / pageSize));

  return (
    <Page fullWidth>
      <BlockStack gap="500">
        <Card padding="500">
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text variant="headingLg" as="h1" fontWeight="bold">
                Catalog Health Monitor
              </Text>
              <Text variant="bodySm" tone="subdued">
                Automated product catalog audits, quality metrics & issue tracking
              </Text>
            </BlockStack>
            <Button
              variant="primary"
              size="large"
              icon={RefreshIcon}
              loading={isLoading}
              disabled={scanRunning}
              onClick={handleRunScan}
            >
              {scanRunning ? "Scan in progress..." : "Run Full Catalog Scan"}
            </Button>
          </InlineStack>
        </Card>
        {actionData?.error && (
          <Banner tone="warning" title="Action not completed">
            <p>{actionData.error}</p>
            <p>
              <Link to="/app/plans" style={{ fontWeight: "bold" }}>
                Review subscription plans
              </Link>
            </p>
          </Banner>
        )}

        {actionData?.success && actionData?.message && (
          <Banner tone="success">
            <p>{actionData.message}</p>
          </Banner>
        )}

        {lastScan?.planLimited && (
          <Banner tone="warning" title={`Audit limited to ${planConfig.maxProductsLabel}`}>
            <p>
              Your catalog is larger than the {planConfig.name} plan audits, so the
              last scan stopped after {lastScan.processedProducts} product(s). Products
              beyond the limit are not monitored - upgrade to widen the audit.
            </p>
          </Banner>
        )}

        {scanAllowance?.limit !== null && scanAllowance?.remaining === 0 && (
          <Banner tone="info" title="On-demand scan allowance used">
            <p>
              The {planConfig.name} plan includes {scanAllowance.limit} on-demand scan(s)
              per 7 days. Automated scanning is unaffected.
            </p>
          </Banner>
        )}

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
          <Box
            padding="300"
            borderRadius="200"
            style={{
              background: "#FEF2F2",
              border: "1px solid #FECACA",
              borderLeft: "4px solid #EF4444",
            }}
          >
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="critical">CRITICAL ALERT</Badge>
                <Text variant="bodySm" fontWeight="bold">
                  {criticalIssuesCount} critical catalog issue(s) detected affecting product availability.
                </Text>
              </InlineStack>
              <Button
                size="micro"
                variant="primary"
                tone="critical"
                onClick={() => updateParams({ tab: "critical", page: 1 })}
              >
                View Critical Issues
              </Button>
            </InlineStack>
          </Box>
        )}

        <Layout>
          <Layout.Section variant="oneThird">
            <Card padding="500">
              <BlockStack gap="300" align="center">
                <Text variant="headingMd" as="h3" fontWeight="bold" alignment="center">
                  Store Health Score
                </Text>
                <div
                  style={{
                    textAlign: "center",
                    padding: "16px 20px",
                    borderRadius: "16px",
                    background: store.healthScore >= 85 ? "#F0FDF4" : store.healthScore >= 60 ? "#FFFBEB" : "#FEF2F2",
                    border: store.healthScore >= 85 ? "1px solid #BBF7D0" : store.healthScore >= 60 ? "1px solid #FDE68A" : "1px solid #FECACA",
                    boxShadow: "0 2px 10px rgba(0,0,0,0.03)",
                    width: "100%",
                  }}
                >
                  <div
                    style={{
                      fontSize: "48px",
                      fontWeight: "900",
                      letterSpacing: "-1px",
                      color: scoreColor,
                      lineHeight: "1.1",
                    }}
                  >
                    {store.healthScore.toFixed(1)}%
                  </div>
                  <Text variant="bodySm" fontWeight="bold" tone={store.healthScore >= 85 ? "success" : store.healthScore >= 60 ? "caution" : "critical"}>
                    {store.healthScore >= 85
                      ? "Excellent Catalog Quality"
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
                <Text variant="headingMd" as="h3" fontWeight="bold">
                  Catalog Overview Metrics
                </Text>
                <InlineStack gap="300" wrap align="space-between">
                  <Box
                    padding="300"
                    borderRadius="300"
                    background="bg-surface-secondary"
                    style={{
                      flex: 1,
                      textAlign: "center",
                      border: "1px solid var(--p-color-border-subdued)",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
                    }}
                  >
                    <Text variant="heading2xl" as="p" fontWeight="bold">
                      {totalProducts}
                    </Text>
                    <Text variant="bodySm" tone="subdued" fontWeight="medium">
                      Total Products
                    </Text>
                  </Box>

                  <Box
                    padding="300"
                    borderRadius="300"
                    background="bg-surface-secondary"
                    style={{
                      flex: 1,
                      textAlign: "center",
                      border: "1px solid var(--p-color-border-subdued)",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
                    }}
                  >
                    <Text
                      variant="heading2xl"
                      as="p"
                      fontWeight="bold"
                      tone={productsWithIssues > 0 ? "critical" : "success"}
                    >
                      {productsWithIssues}
                    </Text>
                    <Text variant="bodySm" tone="subdued" fontWeight="medium">
                      Products w/ Issues
                    </Text>
                  </Box>

                  <Box
                    padding="300"
                    borderRadius="300"
                    onClick={() => updateParams({ tab: "critical", page: 1 })}
                    style={{
                      flex: 1,
                      textAlign: "center",
                      cursor: "pointer",
                      backgroundColor: tabId === "critical" ? "#FEE2E2" : "#FEF2F2",
                      border: tabId === "critical" ? "2px solid #EF4444" : "1.5px solid #FCA5A5",
                      transition: "all 0.2s ease-in-out",
                      boxShadow: tabId === "critical" ? "0 4px 12px rgba(239,68,68,0.2)" : "0 1px 3px rgba(0,0,0,0.03)",
                    }}
                    title="Click to filter Critical Issues"
                  >
                    <BlockStack gap="050" align="center">
                      <Text variant="heading2xl" as="p" fontWeight="bold" tone="critical">
                        {criticalIssuesCount}
                      </Text>
                      <Text variant="bodySm" fontWeight="bold" tone="critical">
                        Critical Issues
                      </Text>
                    </BlockStack>
                  </Box>

                  <Box
                    padding="300"
                    borderRadius="300"
                    onClick={() => updateParams({ tab: "warning", page: 1 })}
                    style={{
                      flex: 1,
                      textAlign: "center",
                      cursor: "pointer",
                      backgroundColor: tabId === "warning" ? "#FEF3C7" : "#FFFBEB",
                      border: tabId === "warning" ? "2px solid #F59E0B" : "1.5px solid #FDE68A",
                      transition: "all 0.2s ease-in-out",
                      boxShadow: tabId === "warning" ? "0 4px 12px rgba(245,158,11,0.2)" : "0 1px 3px rgba(0,0,0,0.03)",
                    }}
                    title="Click to filter Warnings"
                  >
                    <BlockStack gap="050" align="center">
                      <Text variant="heading2xl" as="p" fontWeight="bold" tone="caution">
                        {warningIssuesCount}
                      </Text>
                      <Text variant="bodySm" fontWeight="bold" tone="caution">
                        Warnings
                      </Text>
                    </BlockStack>
                  </Box>

                  <Box
                    padding="300"
                    borderRadius="300"
                    onClick={() => updateParams({ tab: "resolved", page: 1 })}
                    style={{
                      flex: 1,
                      textAlign: "center",
                      cursor: "pointer",
                      backgroundColor: tabId === "resolved" ? "#DCFCE7" : "#F0FDF4",
                      border: tabId === "resolved" ? "2px solid #22C55E" : "1.5px solid #86EFAC",
                      transition: "all 0.2s ease-in-out",
                      boxShadow: tabId === "resolved" ? "0 4px 12px rgba(34,197,94,0.2)" : "0 1px 3px rgba(0,0,0,0.03)",
                    }}
                    title="Click to filter Resolved Issues"
                  >
                    <BlockStack gap="050" align="center">
                      <Text variant="heading2xl" as="p" fontWeight="bold" tone="success">
                        {resolvedIssuesCount}
                      </Text>
                      <Text variant="bodySm" fontWeight="bold" tone="success">
                        Resolved
                      </Text>
                    </BlockStack>
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
          <Card padding="400">
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Icon source={AlertCircleIcon} tone="subdued" />
                  <Text variant="headingSm" as="h3" fontWeight="bold">
                    Recent System Alerts & Audit Logs ({alerts.length})
                  </Text>
                </InlineStack>
                <Button
                  size="micro"
                  variant="tertiary"
                  icon={showAlerts ? ChevronUpIcon : ChevronDownIcon}
                  onClick={() => setShowAlerts((prev) => !prev)}
                >
                  {showAlerts ? "Hide Alerts" : "View Recent Alerts"}
                </Button>
              </InlineStack>

              {showAlerts && (
                <BlockStack gap="200">
                  <Text variant="bodySm" tone="subdued">
                    Click any alert to filter matching issues in the table below:
                  </Text>
                  <BlockStack gap="200">
                    {alerts.map((alert) => (
                      <Box
                        key={alert.id}
                        padding="300"
                        borderRadius="200"
                        background="bg-surface-secondary"
                        onClick={() =>
                          updateParams({
                            tab: alert.criticalCount > 0 ? "critical" : "all",
                            page: 1,
                          })
                        }
                        style={{
                          cursor: "pointer",
                          borderLeft:
                            alert.criticalCount > 0
                              ? "4px solid var(--p-color-bg-fill-critical)"
                              : "4px solid var(--p-color-bg-fill-info)",
                        }}
                        title="Click to filter matching issues"
                      >
                        <InlineStack gap="200" blockAlign="center" align="space-between">
                          <InlineStack gap="200" blockAlign="center">
                            <Badge
                              tone={alert.criticalCount > 0 ? "critical" : "info"}
                              size="small"
                            >
                              {alert.type === "CRITICAL_ALERT"
                                ? "Critical Alert"
                                : "Daily Digest"}
                            </Badge>
                            <Text variant="bodySm" fontWeight="bold">
                              {alert.title}
                            </Text>
                            <Badge
                              tone={alert.status === "SENT" ? "success" : "attention"}
                              size="small"
                            >
                              {alert.status}
                            </Badge>
                          </InlineStack>
                          <Text variant="bodySm" tone="subdued">
                            Logged: {new Date(alert.createdAt).toLocaleString()}
                          </Text>
                        </InlineStack>
                      </Box>
                    ))}
                  </BlockStack>
                </BlockStack>
              )}
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
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="200">
                    <TextField
                      label="Search issues"
                      labelHidden
                      placeholder="Search issues by title, product name, SKU, field name, or severity (e.g. Snowboard, Missing Image, Critical)..."
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
                    <InlineStack gap="200" blockAlign="center" align="space-between">
                      <InlineStack gap="200" blockAlign="center">
                        <Text variant="bodySm" tone="subdued" fontWeight="bold">
                          Quick Filters:
                        </Text>
                        <Button
                          size="micro"
                          tone={tabId === "critical" ? "critical" : undefined}
                          variant={tabId === "critical" ? "primary" : "secondary"}
                          onClick={() => updateParams({ tab: "critical", page: 1 })}
                        >
                          Critical Only ({criticalIssuesCount})
                        </Button>
                        <Button
                          size="micro"
                          tone={tabId === "warning" ? "caution" : undefined}
                          variant={tabId === "warning" ? "primary" : "secondary"}
                          onClick={() => updateParams({ tab: "warning", page: 1 })}
                        >
                          Warnings ({warningIssuesCount})
                        </Button>
                        <Button
                          size="micro"
                          icon={ExportIcon}
                          onClick={() => handleExportCSV(issues)}
                        >
                          Export CSV Report
                        </Button>
                      </InlineStack>

                      {(searchInput || tabId !== "all") && (
                        <Button
                          size="micro"
                          tone="critical"
                          variant="tertiary"
                          onClick={() => {
                            setSearchInput("");
                            updateParams({ tab: "all", q: null, page: 1 });
                          }}
                        >
                          Reset All Filters
                        </Button>
                      )}
                    </InlineStack>
                  </BlockStack>
                </Box>

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
                        Query: &quot;{searchInput}&quot;
                      </Badge>
                    )}
                  </InlineStack>
                )}

                {selectedIssueIds.length > 0 && (
                  <Box padding="300" background="bg-surface-selected" borderRadius="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text variant="bodySm" fontWeight="bold">
                        {selectedIssueIds.length} issue(s) selected
                      </Text>
                      <InlineStack gap="200" blockAlign="center">
                        {planConfig.autoFix && (
                          <Button
                            size="micro"
                            variant="primary"
                            icon={MagicIcon}
                            loading={isLoading}
                            onClick={handleBulkAutoFix}
                          >
                            Bulk Auto-Fix ({selectedIssueIds.length})
                          </Button>
                        )}
                        <Button
                          size="micro"
                          icon={ExportIcon}
                          onClick={() =>
                            handleExportCSV(issues.filter((i) => selectedIssueIds.includes(i.id)))
                          }
                        >
                          Export Selected CSV
                        </Button>
                        <Button
                          size="micro"
                          variant="tertiary"
                          onClick={() => setSelectedIssueIds([])}
                        >
                          Deselect All
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  </Box>
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
                    <Box overflowX="auto">
                      <DataTable
                        columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                        headings={[
                          <Checkbox
                            key="select-all"
                            labelHidden
                            label="Select all issues on page"
                            checked={issues.length > 0 && selectedIssueIds.length === issues.length}
                            onChange={handleToggleSelectAll}
                          />,
                          "Severity",
                          "Issue Title",
                          "Product",
                          "Status",
                          "Actions",
                        ]}
                        rows={issueRows}
                      />
                    </Box>
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
