import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
  useRevalidator,
  Link,
} from "react-router";
import { useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  DataTable,
  Banner,
  BlockStack,
  ProgressBar,
  Box,
} from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord } from "../services/syncEngine.server.js";
import {
  checkManualScanAllowance,
  enqueueFullScan,
  ensureWorkerStarted,
  getQueueSnapshot,
  JOB_PRIORITY,
} from "../services/scanQueue.server.js";
import { serializablePlanConfig } from "../services/planEngine.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);

  ensureWorkerStarted();

  const [scans, queue, activeJobs] = await Promise.all([
    prisma.catalogScan.findMany({
      where: { storeId: store.id },
      orderBy: { startedAt: "desc" },
      take: 50,
    }),
    getQueueSnapshot(store.id),
    prisma.scanJob.findMany({
      where: { storeId: store.id, status: { in: ["PENDING", "PROCESSING", "FAILED"] } },
      orderBy: [{ priority: "asc" }, { runAt: "asc" }],
      take: 25,
    }),
  ]);

  return {
    store,
    scans,
    queue,
    activeJobs,
    planConfig: serializablePlanConfig(store.plan),
    scanAllowance: await checkManualScanAllowance(store.id, store.plan),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const formData = await request.formData();

  if (formData.get("actionType") === "TRIGGER_FULL_SCAN") {
    // Same plan allowance as the dashboard button: this route must not be a way
    // around it.
    const allowance = await checkManualScanAllowance(store.id, store.plan);
    if (!allowance.allowed) {
      return { success: false, error: allowance.message };
    }

    // Background job, not an inline crawl (spec #3, #22).
    await enqueueFullScan({
      storeId: store.id,
      scanType: "MANUAL",
      priority: JOB_PRIORITY.MANUAL_FULL_SCAN,
    });
    ensureWorkerStarted();
    return { success: true };
  }

  return { success: false };
};

export default function CatalogScans() {
  const { scans, queue, activeJobs, planConfig, scanAllowance } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isLoading = navigation.state !== "idle";

  const scanRunning = queue.PENDING > 0 || queue.PROCESSING > 0;

  // Scans run in the background, so poll while there is work in flight.
  useEffect(() => {
    if (!scanRunning) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [scanRunning, revalidator]);

  const handleTriggerScan = () => {
    submit({ actionType: "TRIGGER_FULL_SCAN" }, { method: "post" });
  };

  const rows = scans.map((scan) => {
    const total = scan.totalProducts || 0;
    const pct = total > 0 ? Math.min(100, Math.round((scan.processedProducts / total) * 100)) : 0;

    return [
      <Badge key={`type-${scan.id}`} tone="info">
        {scan.scanType}
      </Badge>,
      <Badge
        key={`stat-${scan.id}`}
        tone={
          scan.status === "COMPLETED"
            ? "success"
            : scan.status === "IN_PROGRESS"
            ? "attention"
            : scan.status === "QUEUED"
            ? "info"
            : "critical"
        }
      >
        {scan.status}
      </Badge>,
      <BlockStack key={`proc-${scan.id}`} gap="100">
        <Text variant="bodyMd" fontWeight="bold">
          {scan.processedProducts} / {total || "—"}
        </Text>
        {scan.status === "IN_PROGRESS" && total > 0 && (
          <ProgressBar progress={pct} size="small" tone="primary" />
        )}
      </BlockStack>,
      <Text
        key={`fail-${scan.id}`}
        variant="bodyMd"
        tone={scan.failedProducts > 0 ? "critical" : "subdued"}
      >
        {scan.failedProducts}
      </Text>,
      <Text key={`start-${scan.id}`} variant="bodySm">
        {new Date(scan.startedAt).toLocaleString()}
      </Text>,
      <Text key={`comp-${scan.id}`} variant="bodySm">
        {scan.completedAt ? new Date(scan.completedAt).toLocaleString() : "Running..."}
      </Text>,
      scan.planLimited ? (
        <Badge key={`lim-${scan.id}`} tone="warning">
          Plan limit reached
        </Badge>
      ) : (
        <Text key={`lim-${scan.id}`} variant="bodySm" tone="subdued">
          —
        </Text>
      ),
    ];
  });

  const jobRows = activeJobs.map((job) => [
    <Text key={`t-${job.id}`} variant="bodyMd">
      {job.jobType}
    </Text>,
    <Badge key={`p-${job.id}`} tone="info">
      {`P${job.priority}`}
    </Badge>,
    <Badge
      key={`s-${job.id}`}
      tone={
        job.status === "PROCESSING"
          ? "attention"
          : job.status === "FAILED"
          ? "critical"
          : undefined
      }
    >
      {job.status}
    </Badge>,
    <Text key={`a-${job.id}`} variant="bodySm">
      {`${job.attempts}/${job.maxAttempts}`}
    </Text>,
    <Text key={`r-${job.id}`} variant="bodySm">
      {new Date(job.runAt).toLocaleString()}
    </Text>,
    <Text key={`e-${job.id}`} variant="bodySm" tone={job.lastError ? "critical" : "subdued"}>
      {job.lastError ? job.lastError.slice(0, 120) : "—"}
    </Text>,
  ]);

  return (
    <Page
      fullWidth
      title="Catalog Audit Scan History"
      subtitle="Track background batch scans, webhook syncs, and manual audits"
      primaryAction={{
        content: scanRunning ? "Scan in progress..." : "Trigger Full Audit",
        icon: RefreshIcon,
        loading: isLoading,
        disabled: scanRunning,
        onClick: handleTriggerScan,
      }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.error && (
              <Banner tone="warning" title="On-demand scan not queued">
                <p>{actionData.error}</p>
                <p>
                  <Link to="/app/plans" style={{ fontWeight: "bold" }}>
                    Review subscription plans
                  </Link>
                </p>
              </Banner>
            )}

            <Banner tone="info" title={`${planConfig.name} plan coverage`}>
              <p>
                {`Audit limit: ${planConfig.maxProductsLabel}. On-demand scans: ${
                  scanAllowance.limit === null
                    ? "unlimited"
                    : `${scanAllowance.remaining} of ${scanAllowance.limit} left in the current 7 days`
                }. Automated daily scans: ${planConfig.dailyScan ? "included" : "not included"}. Real-time webhook scans: ${
                  planConfig.webhookScan ? "included" : "not included"
                }.`}
              </p>
            </Banner>

            {scanRunning && (
              <Banner tone="info" title="Background work in progress">
                <p>
                  {`${queue.PROCESSING} job(s) running, ${queue.PENDING} queued. This view refreshes automatically.`}
                </p>
              </Banner>
            )}

            {queue.FAILED > 0 && (
              <Banner tone="warning" title={`${queue.FAILED} scan job(s) failed`}>
                <p>
                  Jobs retry with escalating delays and are marked failed after the
                  final attempt. See the queue table below for the recorded error.
                </p>
              </Banner>
            )}

            <Card padding="0">
              <Box padding="400">
                <Text variant="headingMd" as="h3">
                  Scan History
                </Text>
              </Box>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
                headings={[
                  "Scan Type",
                  "Status",
                  "Products Processed",
                  "Failed",
                  "Started At",
                  "Completed At",
                  "Coverage",
                ]}
                rows={rows}
              />
            </Card>

            {jobRows.length > 0 && (
              <Card padding="0">
                <Box padding="400">
                  <Text variant="headingMd" as="h3">
                    Scan Queue
                  </Text>
                </Box>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                  headings={["Job Type", "Priority", "Status", "Attempts", "Runs At", "Last Error"]}
                  rows={jobRows}
                />
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
