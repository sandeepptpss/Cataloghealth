import { useState } from "react";
import { useLoaderData, useSubmit, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  DataTable,
  Button,
  InlineStack,
  BlockStack,
  Box,
  Divider,
  Banner,
  Grid,
  Modal,
  TextField,
  Icon,
  Tabs,
  ProgressBar,
  ButtonGroup,
} from "@shopify/polaris";
import {
  CheckCircleIcon,
  EmailIcon,
  RefreshIcon,
  SearchIcon,
  ViewIcon,
  PersonIcon,
  StoreIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord } from "../services/syncEngine.server.js";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com";
const ADMIN_SHOP_PREFIX = process.env.ADMIN_STORE_NAME || "quickstart-749ac396";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const currentStore = await ensureStoreRecord(session.shop);

  const shopDomain = session.shop.toLowerCase();
  const adminEmail = (currentStore.adminEmail || "").toLowerCase();

  const isAdmin =
    shopDomain.includes(ADMIN_SHOP_PREFIX.toLowerCase()) ||
    adminEmail === ADMIN_EMAIL.toLowerCase();

  if (!isAdmin) {
    return {
      isAdmin: false,
      currentStore,
      stores: [],
      freeCount: 0,
      growthCount: 0,
      proCount: 0,
      estimatedMRR: 0,
      supportTickets: [],
    };
  }

  const stores = await prisma.store.findMany({
    include: {
      _count: {
        select: {
          products: true,
          issues: true,
          catalogScans: true,
        },
      },
      issues: {
        where: { status: "OPEN" },
        select: { id: true, severity: true },
      },
    },
    orderBy: { installedAt: "desc" },
  });

  let freeCount = 0;
  let growthCount = 0;
  let proCount = 0;

  stores.forEach((st) => {
    const p = (st.plan || "free").toLowerCase();
    if (p === "growth") growthCount++;
    else if (p === "pro") proCount++;
    else freeCount++;
  });

  const estimatedMRR = growthCount * 9 + proCount * 29;

  const supportTickets = await prisma.supportTicket.findMany({
    include: {
      store: { select: { shopDomain: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return {
    isAdmin: true,
    currentStore,
    stores,
    freeCount,
    growthCount,
    proCount,
    estimatedMRR,
    supportTickets,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const currentStore = await ensureStoreRecord(session.shop);

  const shopDomain = session.shop.toLowerCase();
  const adminEmail = (currentStore.adminEmail || "").toLowerCase();

  const isAdmin =
    shopDomain.includes(ADMIN_SHOP_PREFIX.toLowerCase()) ||
    adminEmail === ADMIN_EMAIL.toLowerCase();

  if (!isAdmin) {
    return { success: false, error: "Unauthorized access: Admin portal is restricted to authorized accounts only." };
  }

  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "TOGGLE_TICKET_STATUS") {
    const ticketId = formData.get("ticketId");
    if (ticketId) {
      const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
      if (ticket) {
        await prisma.supportTicket.update({
          where: { id: ticketId },
          data: { status: ticket.status === "OPEN" ? "RESOLVED" : "OPEN" },
        });
      }
    }
    return { success: true };
  }

  if (actionType === "UPDATE_MERCHANT_PLAN") {
    const storeId = formData.get("storeId");
    const newPlan = formData.get("newPlan");
    if (storeId && newPlan) {
      await prisma.store.update({
        where: { id: storeId },
        data: { plan: newPlan.toLowerCase() },
      });
    }
    return { success: true };
  }

  return { success: false };
};

export default function AdminDashboard() {
  const {
    isAdmin,
    currentStore,
    stores,
    freeCount,
    growthCount,
    proCount,
    estimatedMRR,
    supportTickets,
  } = useLoaderData();

  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const [selectedTab, setSelectedTab] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedStoreModal, setSelectedStoreModal] = useState(null);

  if (!isAdmin) {
    return (
      <Page fullWidth title="Admin Access Restricted">
        <Layout>
          <Layout.Section>
            <Card padding="600">
              <BlockStack gap="400">
                <Banner title="Access Restricted" tone="critical">
                  <p>
                    The Admin Portal is restricted to authorized platform administrators only:
                  </p>
                  <ul>
                    <li><strong>Admin Email:</strong> sandeepptpss@gmail.com</li>
                    <li><strong>Admin Store ID:</strong> quickstart-749ac396</li>
                  </ul>
                  <p>
                    Your current store account (<code>{currentStore?.shopDomain}</code>) does not have administrator privileges.
                  </p>
                </Banner>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const tabs = [
    { id: "all", content: `All Merchants (${stores.length})` },
    { id: "free", content: `Free Plan (${freeCount})` },
    { id: "growth", content: `Growth Plan (${growthCount})` },
    { id: "pro", content: `Pro Plan (${proCount})` },
  ];

  const handleToggleTicketStatus = (ticketId) => {
    submit({ actionType: "TOGGLE_TICKET_STATUS", ticketId }, { method: "post" });
  };

  const handleUpdateStorePlan = (storeId, newPlan) => {
    submit({ actionType: "UPDATE_MERCHANT_PLAN", storeId, newPlan }, { method: "post" });
    if (selectedStoreModal && selectedStoreModal.id === storeId) {
      setSelectedStoreModal((prev) => (prev ? { ...prev, plan: newPlan.toLowerCase() } : null));
    }
  };

  // Filter stores based on search query & active tab
  const filteredStores = stores.filter((st) => {
    const matchesSearch =
      st.shopDomain.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (st.adminEmail && st.adminEmail.toLowerCase().includes(searchQuery.toLowerCase()));

    const currentTabId = tabs[selectedTab].id;
    if (currentTabId === "all") return matchesSearch;
    return matchesSearch && (st.plan || "free").toLowerCase() === currentTabId;
  });

  const getHealthTone = (score) => {
    if (score >= 85) return "success";
    if (score >= 60) return "highlight";
    return "critical";
  };

  // Build rows for Merchant Table
  const merchantTableRows = filteredStores.map((st) => {
    const openIssues = (st.issues || []).length;
    const criticalIssues = (st.issues || []).filter((i) => i.severity === "CRITICAL").length;

    return [
      <BlockStack key={`domain-${st.id}`} gap="100">
        <InlineStack gap="150" align="start">
          <Icon source={StoreIcon} tone="subdued" />
          <Text variant="bodyMd" fontWeight="bold">
            {st.shopDomain}
          </Text>
        </InlineStack>
        <Text variant="bodySm" tone="subdued">
          Admin Email: {st.adminEmail || "sandeepptpss@gmail.com"}
        </Text>
      </BlockStack>,
      <Badge
        key={`plan-${st.id}`}
        tone={
          st.plan.toLowerCase() === "pro"
            ? "success"
            : st.plan.toLowerCase() === "growth"
            ? "highlight"
            : "subdued"
        }
      >
        {st.plan.toUpperCase()}
      </Badge>,
      <Box key={`score-${st.id}`} minWidth="120px">
        <BlockStack gap="100">
          <InlineStack align="space-between">
            <Text variant="bodySm" fontWeight="bold">
              {st.healthScore.toFixed(1)}%
            </Text>
            <Text variant="bodySm" tone="subdued">
              {st.healthScore >= 85 ? "Healthy" : "Needs Review"}
            </Text>
          </InlineStack>
          <ProgressBar progress={st.healthScore} tone={getHealthTone(st.healthScore)} size="small" />
        </BlockStack>
      </Box>,
      <Text key={`prods-${st.id}`} variant="bodyMd" fontWeight="bold">
        {st._count.products}
      </Text>,
      <InlineStack key={`issues-${st.id}`} gap="100">
        <Badge tone={openIssues > 0 ? "critical" : "success"}>
          {openIssues} Open
        </Badge>
        {criticalIssues > 0 && <Badge tone="critical">{criticalIssues} Critical</Badge>}
      </InlineStack>,
      <Text key={`date-${st.id}`} variant="bodySm">
        {new Date(st.installedAt).toLocaleDateString()}
      </Text>,
      <InlineStack key={`act-${st.id}`} gap="150">
        <Button
          size="micro"
          icon={ViewIcon}
          onClick={() => setSelectedStoreModal(st)}
        >
          View Details
        </Button>
        {st.plan.toLowerCase() !== "pro" ? (
          <Button
            size="micro"
            tone="success"
            onClick={() => handleUpdateStorePlan(st.id, "pro")}
          >
            Set Pro
          </Button>
        ) : (
          <Button
            size="micro"
            onClick={() => handleUpdateStorePlan(st.id, "free")}
          >
            Set Free
          </Button>
        )}
      </InlineStack>,
    ];
  });

  return (
    <Page
      fullWidth
      title="App Admin Dashboard"
      subtitle={`Administrator Portal • Pre-Granted Access for ${ADMIN_EMAIL} (${ADMIN_SHOP})`}
    >
      <BlockStack gap="500">
        {/* Top Summary Banner */}
        <Banner title="Admin Control Center & Subscription Analytics" tone="info">
          <p>
            Welcome to your master administration dashboard. Monitor all merchant installations, subscription plans, MRR revenue metrics, catalog audit status, and merchant support inquiries.
          </p>
        </Banner>

        {/* Metric Cards Header */}
        <Grid>
          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="200">
                <Text variant="bodySm" tone="subdued">
                  Total Active Merchants
                </Text>
                <Text variant="heading2xl" as="p" fontWeight="bold">
                  {stores.length}
                </Text>
                <InlineStack gap="100">
                  <Badge tone="success">Active</Badge>
                  <Text variant="bodySm" tone="subdued">
                    100% retention
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="200">
                <Text variant="bodySm" tone="subdued">
                  Free Plan Subscribers
                </Text>
                <Text variant="heading2xl" as="p" fontWeight="bold">
                  {freeCount}
                </Text>
                <Text variant="bodySm" tone="subdued">
                  $0/mo tier merchants
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="200">
                <Text variant="bodySm" tone="subdued">
                  Paid Plan Subscribers
                </Text>
                <Text variant="heading2xl" as="p" fontWeight="bold" tone="highlight">
                  {growthCount + proCount}
                </Text>
                <Text variant="bodySm" tone="subdued">
                  {growthCount} Growth (${growthCount * 19}) | {proCount} Pro (${proCount * 49})
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="200">
                <Text variant="bodySm" tone="subdued">
                  Monthly Recurring Revenue (MRR)
                </Text>
                <Text variant="heading2xl" as="p" fontWeight="bold" tone="success">
                  ${estimatedMRR}
                </Text>
                <Text variant="bodySm" tone="success">
                  Active Subscription Revenue
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>
        </Grid>

        {/* Merchant Subscription Directory Table with Tabs & Search */}
        <Card padding="0">
          <BlockStack gap="0">
            <Box padding="400">
              <InlineStack align="space-between">
                <BlockStack gap="100">
                  <Text variant="headingMd" as="h3">
                    Merchant Subscription Directory
                  </Text>
                  <Text variant="bodySm" tone="subdued">
                    Search and manage plan subscriptions for registered Shopify merchant stores.
                  </Text>
                </BlockStack>
              </InlineStack>
            </Box>

            <Divider />

            <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
              <Box padding="400">
                <BlockStack gap="400">
                  <TextField
                    label="Search Merchants"
                    labelHidden
                    placeholder="Search merchant by store domain name or email..."
                    value={searchQuery}
                    onChange={setSearchQuery}
                    prefix={<Icon source={SearchIcon} />}
                    clearButton
                    onClearButtonClick={() => setSearchQuery("")}
                    autoComplete="off"
                  />

                  {filteredStores.length === 0 ? (
                    <Box padding="600">
                      <BlockStack align="center" inlineAlign="center" gap="200">
                        <Icon source={StoreIcon} tone="subdued" />
                        <Text variant="headingSm">No merchants match your search</Text>
                        <Text variant="bodySm" tone="subdued">
                          Try searching for another store domain or clear search filters.
                        </Text>
                      </BlockStack>
                    </Box>
                  ) : (
                    <DataTable
                      columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
                      headings={[
                        "Merchant Store",
                        "Active Plan",
                        "Health Score",
                        "Products",
                        "Open Issues",
                        "Installed Date",
                        "Actions",
                      ]}
                      rows={merchantTableRows}
                    />
                  )}
                </BlockStack>
              </Box>
            </Tabs>
          </BlockStack>
        </Card>

        {/* Plans Overview & Pricing Comparison Matrix */}
        <Card padding="500">
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text variant="headingMd" as="h3">
                Subscription Tiers & Plan Details
              </Text>
              <Text variant="bodySm" tone="subdued">
                Overview of available plan features and active merchant allocations across tiers.
              </Text>
            </BlockStack>

            <Grid>
              <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
                <Card padding="400" background="bg-surface-secondary">
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text variant="headingSm" as="h4">
                        Free Tier
                      </Text>
                      <Badge tone="subdued">{freeCount} Merchants</Badge>
                    </InlineStack>
                    <Text variant="headingLg" as="p" fontWeight="bold">
                      $0 <Text variant="bodySm" tone="subdued" as="span">/ month</Text>
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Audit limit: Up to 250 products. Basic image & SKU checks, weekly manual audits.
                    </Text>
                  </BlockStack>
                </Card>
              </Grid.Cell>

              <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
                <Card padding="400" background="bg-surface-secondary">
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text variant="headingSm" as="h4">
                        Growth Plan
                      </Text>
                      <Badge tone="highlight">{growthCount} Merchants</Badge>
                    </InlineStack>
                    <Text variant="headingLg" as="p" fontWeight="bold">
                      $19 <Text variant="bodySm" tone="subdued" as="span">/ month</Text>
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Audit limit: Up to 2,500 products. Daily automated scans, required metafield checks.
                    </Text>
                  </BlockStack>
                </Card>
              </Grid.Cell>

              <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
                <Card padding="400" background="bg-surface-secondary">
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text variant="headingSm" as="h4">
                        Pro Enterprise
                      </Text>
                      <Badge tone="success">{proCount} Merchants</Badge>
                    </InlineStack>
                    <Text variant="headingLg" as="p" fontWeight="bold">
                      $49 <Text variant="bodySm" tone="subdued" as="span">/ month</Text>
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Audit limit: Unlimited products. Real-time webhooks, auto-fix engine, 24/7 support.
                    </Text>
                  </BlockStack>
                </Card>
              </Grid.Cell>
            </Grid>
          </BlockStack>
        </Card>

        {/* Merchant Support Tickets Inbox */}
        <Card padding="500">
          <BlockStack gap="400">
            <InlineStack align="space-between">
              <BlockStack gap="100">
                <Text variant="headingMd" as="h3">
                  Merchant Support Ticket Inbox ({supportTickets.length})
                </Text>
                <Text variant="bodySm" tone="subdued">
                  Inquiries submitted by merchants directly to support ({ADMIN_EMAIL})
                </Text>
              </BlockStack>
              <Button icon={EmailIcon} url={`mailto:${ADMIN_EMAIL}`}>
                Open Mailbox ({ADMIN_EMAIL})
              </Button>
            </InlineStack>

            <Divider />

            {supportTickets.length === 0 ? (
              <Box padding="500">
                <BlockStack align="center" inlineAlign="center" gap="200">
                  <Icon source={CheckCircleIcon} tone="success" size="large" />
                  <Text variant="headingSm">No Open Support Tickets</Text>
                  <Text variant="bodySm" tone="subdued">
                    All merchant inquiries have been addressed and resolved.
                  </Text>
                </BlockStack>
              </Box>
            ) : (
              <BlockStack gap="300">
                {supportTickets.map((ticket) => (
                  <Card key={ticket.id} padding="400">
                    <InlineStack align="space-between" blockAlign="start">
                      <BlockStack gap="200">
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={ticket.status === "OPEN" ? "attention" : "success"}>
                            {ticket.status}
                          </Badge>
                          <Text variant="bodyMd" fontWeight="bold">
                            {ticket.subject}
                          </Text>
                        </InlineStack>
                        <Text variant="bodySm">
                          {ticket.message}
                        </Text>
                        <InlineStack gap="400">
                          <Text variant="bodySm" tone="subdued">
                            Store: {ticket.store?.shopDomain || "Unknown Store"}
                          </Text>
                          <Text variant="bodySm" tone="subdued">
                            Contact: {ticket.merchantEmail}
                          </Text>
                          <Text variant="bodySm" tone="subdued">
                            Submitted: {new Date(ticket.createdAt).toLocaleString()}
                          </Text>
                        </InlineStack>
                      </BlockStack>

                      <ButtonGroup gap="200">
                        <Button
                          size="micro"
                          onClick={() => handleToggleTicketStatus(ticket.id)}
                        >
                          {ticket.status === "OPEN" ? "Mark Resolved" : "Reopen"}
                        </Button>
                        <Button
                          size="micro"
                          icon={EmailIcon}
                          url={`mailto:${ticket.merchantEmail}?subject=Re: ${encodeURIComponent(ticket.subject)}`}
                        >
                          Reply Email
                        </Button>
                      </ButtonGroup>
                    </InlineStack>
                  </Card>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>

      {/* Detailed Merchant Modal */}
      {selectedStoreModal && (
        <Modal
          open={Boolean(selectedStoreModal)}
          onClose={() => setSelectedStoreModal(null)}
          title={`Merchant Details — ${selectedStoreModal.shopDomain}`}
          primaryAction={{
            content: "Close",
            onClick: () => setSelectedStoreModal(null),
          }}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <BlockStack gap="100">
                  <Text variant="headingSm" as="h4">
                    Store Metadata & Subscription Status
                  </Text>
                  <Text variant="bodySm" tone="subdued">
                    Store ID: {selectedStoreModal.id}
                  </Text>
                </BlockStack>
                <Badge
                  tone={
                    selectedStoreModal.plan.toLowerCase() === "pro"
                      ? "success"
                      : selectedStoreModal.plan.toLowerCase() === "growth"
                      ? "highlight"
                      : "subdued"
                  }
                >
                  {selectedStoreModal.plan.toUpperCase()} PLAN
                </Badge>
              </InlineStack>

              <Divider />

              <Grid>
                <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued">
                      Installed Date
                    </Text>
                    <Text variant="bodyMd" fontWeight="bold">
                      {new Date(selectedStoreModal.installedAt).toLocaleString()}
                    </Text>
                  </BlockStack>
                </Grid.Cell>
                <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued">
                      Merchant Admin Email
                    </Text>
                    <Text variant="bodyMd" fontWeight="bold">
                      {selectedStoreModal.adminEmail || "sandeepptpss@gmail.com"}
                    </Text>
                  </BlockStack>
                </Grid.Cell>
              </Grid>

              <Grid>
                <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued">
                      Total Synced Products
                    </Text>
                    <Text variant="headingLg" as="p" fontWeight="bold">
                      {selectedStoreModal._count?.products || 0}
                    </Text>
                  </BlockStack>
                </Grid.Cell>
                <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued">
                      Active Catalog Health Score
                    </Text>
                    <Text
                      variant="headingLg"
                      as="p"
                      fontWeight="bold"
                      tone={getHealthTone(selectedStoreModal.healthScore)}
                    >
                      {selectedStoreModal.healthScore.toFixed(1)}%
                    </Text>
                  </BlockStack>
                </Grid.Cell>
              </Grid>

              <Divider />

              <BlockStack gap="200">
                <Text variant="headingSm" as="h4">
                  Quick Subscription Plan Controls
                </Text>
                <InlineStack gap="200">
                  <Button
                    disabled={selectedStoreModal.plan.toLowerCase() === "free"}
                    onClick={() => handleUpdateStorePlan(selectedStoreModal.id, "free")}
                  >
                    Switch to Free ($0)
                  </Button>
                  <Button
                    disabled={selectedStoreModal.plan.toLowerCase() === "growth"}
                    onClick={() => handleUpdateStorePlan(selectedStoreModal.id, "growth")}
                  >
                    Switch to Growth ($19)
                  </Button>
                  <Button
                    tone="success"
                    disabled={selectedStoreModal.plan.toLowerCase() === "pro"}
                    onClick={() => handleUpdateStorePlan(selectedStoreModal.id, "pro")}
                  >
                    Upgrade to Pro ($49)
                  </Button>
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
