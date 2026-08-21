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
} from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord, syncAndScanCatalog } from "../services/syncEngine.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);

  const scans = await prisma.catalogScan.findMany({
    where: { storeId: store.id },
    orderBy: { startedAt: "desc" },
    take: 50,
  });

  return { store, scans };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const formData = await request.formData();

  if (formData.get("actionType") === "TRIGGER_FULL_SCAN") {
    await syncAndScanCatalog(admin, store.id, "MANUAL");
    return { success: true };
  }

  return { success: false };
};

export default function CatalogScans() {
  const { scans } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const handleTriggerScan = () => {
    submit({ actionType: "TRIGGER_FULL_SCAN" }, { method: "post" });
  };

  const rows = scans.map((scan) => [
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
    <Text key={`proc-${scan.id}`} variant="bodyMd" fontWeight="bold">
      {scan.processedProducts} / {scan.totalProducts || "—"}
    </Text>,
    <Text key={`fail-${scan.id}`} variant="bodyMd" tone={scan.failedProducts > 0 ? "critical" : "subdued"}>
      {scan.failedProducts}
    </Text>,
    <Text key={`start-${scan.id}`} variant="bodySm">
      {new Date(scan.startedAt).toLocaleString()}
    </Text>,
    <Text key={`comp-${scan.id}`} variant="bodySm">
      {scan.completedAt ? new Date(scan.completedAt).toLocaleString() : "Running..."}
    </Text>,
  ]);

  return (
    <Page
      title="Catalog Audit Scan History"
      subtitle="Track background batch scans, webhook syncs, and manual audits"
      primaryAction={{
        content: "Trigger Full Audit",
        icon: RefreshIcon,
        loading: isLoading,
        onClick: handleTriggerScan,
      }}
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text", "text"]}
              headings={["Scan Type", "Status", "Products Processed", "Failed", "Started At", "Completed At"]}
              rows={rows}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
