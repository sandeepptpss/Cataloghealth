/* global process */
import { useState } from "react";
import { Form, useLoaderData, useActionData, useSubmit } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  IndexTable,
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
  Select,
} from "@shopify/polaris";
import {
  CheckCircleIcon,
  EmailIcon,
  SearchIcon,
  ViewIcon,
  StoreIcon,
  CashDollarIcon,
  PersonIcon,
  ClockIcon,
  CheckIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord } from "../services/syncEngine.server.js";
import {
  PLAN_CONFIG,
  PLAN_IDS,
  normalizePlanId,
} from "../services/planEngine.server.js";
import {
  addAdminReply,
  listAllTickets,
  toggleTicketStatus,
} from "../services/supportEngine.server.js";

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

  const planCounts = { free: 0, growth: 0, pro: 0, enterprise: 0 };

  stores.forEach((st) => {
    planCounts[normalizePlanId(st.plan) || "free"]++;
  });

  const estimatedMRR = PLAN_IDS.reduce(
    (sum, id) => sum + planCounts[id] * PLAN_CONFIG[id].priceAmount,
    0,
  );

  const planTiers = PLAN_IDS.map((id) => ({
    id,
    name: PLAN_CONFIG[id].name,
    price: PLAN_CONFIG[id].price,
    priceAmount: PLAN_CONFIG[id].priceAmount,
    merchants: planCounts[id],
    auditLimit: PLAN_CONFIG[id].maxProductsLabel,
    support: PLAN_CONFIG[id].supportSla,
    autoFix: PLAN_CONFIG[id].autoFix,
  }));

  const supportTickets = await listAllTickets();

  return {
    isAdmin: true,
    currentStore,
    stores: stores.map((st) => ({ ...st, planId: normalizePlanId(st.plan) || "free" })),
    planCounts,
    planTiers,
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
    try {
      const result = await toggleTicketStatus({ ticketId: formData.get("ticketId") });
      if (!result.success) return result;
      return { success: true, message: `Ticket status updated to ${result.ticket.status}.` };
    } catch (error) {
      console.error("[admin] ticket status change failed:", error);
      return { success: false, error: `Could not update the ticket: ${error.message}` };
    }
  }

  if (actionType === "REPLY_SUPPORT_TICKET") {
    try {
      const result = await addAdminReply({
        ticketId: formData.get("ticketId"),
        body: formData.get("replyText"),
        authorEmail: ADMIN_EMAIL,
      });

      if (!result.success) return result;

      return { success: true, message: "Reply sent to the merchant successfully!" };
    } catch (error) {
      console.error("[admin] support reply failed:", error);
      return { success: false, error: `Could not send the reply: ${error.message}` };
    }
  }

  if (actionType === "UPDATE_MERCHANT_PLAN") {
    const storeId = formData.get("storeId");
    const newPlan = normalizePlanId(formData.get("newPlan"));

    if (!storeId || !newPlan) {
      return {
        success: false,
        error: `Unknown plan. Choose one of: ${PLAN_IDS.join(", ")}.`,
      };
    }

    await prisma.store.update({
      where: { id: storeId },
      data: { plan: newPlan },
    });

    return { success: true, message: `Plan updated to ${PLAN_CONFIG[newPlan].name}.` };
  }

  return { success: false };
};

export default function AdminDashboard() {
  const {
    isAdmin,
    currentStore,
    stores,
    planCounts,
    planTiers,
    estimatedMRR,
    supportTickets,
  } = useLoaderData();

  const submit = useSubmit();

  const [activeMainTab, setActiveMainTab] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [planFilter, setPlanFilter] = useState("all");
  const [healthFilter, setHealthFilter] = useState("all");
  const [ticketStatusFilter, setTicketStatusFilter] = useState("ALL");
  const [selectedStoreModal, setSelectedStoreModal] = useState(null);
  const [replyInputs, setReplyInputs] = useState({});

  const actionData = useActionData();

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
                    <li><strong>Admin Email:</strong> {ADMIN_EMAIL}</li>
                    <li><strong>Admin Store ID:</strong> {ADMIN_SHOP_PREFIX}</li>
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

  const planName = (planId) =>
    planTiers.find((tier) => tier.id === planId)?.name || planId;

  const planBadgeTone = (planId) =>
    planId === "enterprise"
      ? "success"
      : planId === "pro"
      ? "attention"
      : planId === "growth"
      ? "highlight"
      : "subdued";

  const getHealthTone = (score) => {
    if (score >= 85) return "success";
    if (score >= 60) return "caution";
    return "critical";
  };

  const handleUpdateStorePlan = (storeId, newPlan) => {
    const fd = new FormData();
    fd.append("actionType", "UPDATE_MERCHANT_PLAN");
    fd.append("storeId", storeId);
    fd.append("newPlan", newPlan);
    submit(fd, { method: "post" });
    if (selectedStoreModal && selectedStoreModal.id === storeId) {
      setSelectedStoreModal((prev) => (prev ? { ...prev, planId: newPlan.toLowerCase() } : null));
    }
  };

  // Filter stores
  const filteredStores = stores.filter((st) => {
    const matchesSearch =
      st.shopDomain.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (st.adminEmail && st.adminEmail.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesPlan = planFilter === "all" || st.planId === planFilter;

    let matchesHealth = true;
    if (healthFilter === "healthy") matchesHealth = st.healthScore >= 85;
    else if (healthFilter === "review") matchesHealth = st.healthScore < 85;

    return matchesSearch && matchesPlan && matchesHealth;
  });

  const openTicketsCount = supportTickets.filter((t) => t.status === "OPEN").length;
  const answeredTicketsCount = supportTickets.filter((t) => t.status === "ANSWERED").length;
  const resolvedTicketsCount = supportTickets.filter((t) => t.status === "RESOLVED").length;

  const filteredTickets = supportTickets.filter((t) => {
    if (ticketStatusFilter === "ALL") return true;
    return t.status === ticketStatusFilter;
  });

  const mainTabs = [
    {
      id: "merchants-tab",
      content: `Merchant Directory (${stores.length})`,
      panelID: "merchants-panel",
    },
    {
      id: "tiers-tab",
      content: `Subscription Tiers (${planTiers.length})`,
      panelID: "tiers-panel",
    },
    {
      id: "support-tab",
      content: `Support Tickets (${supportTickets.length})${openTicketsCount > 0 ? ` [${openTicketsCount} OPEN]` : ""}`,
      panelID: "support-panel",
    },
  ];

  const merchantRowsMarkup = filteredStores.map((st, index) => {
    const openIssues = (st.issues || []).length;
    const criticalIssues = (st.issues || []).filter((i) => i.severity === "CRITICAL").length;

    return (
      <IndexTable.Row id={st.id} key={st.id} position={index}>
        <IndexTable.Cell>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
              <Icon source={StoreIcon} tone="subdued" />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <Text variant="bodyMd" fontWeight="bold" as="span">
                {st.shopDomain}
              </Text>
              <Text variant="bodySm" tone="subdued" as="span">
                Admin: {st.adminEmail || "sandeepptpss@gmail.com"}
              </Text>
            </div>
          </div>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Badge tone={planBadgeTone(st.planId)}>
            {planName(st.planId).toUpperCase()}
          </Badge>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <div style={{ minWidth: "140px", display: "flex", flexDirection: "column", gap: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <Text variant="bodySm" fontWeight="bold" as="span">
                {st.healthScore.toFixed(1)}%
              </Text>
              <Badge tone={getHealthTone(st.healthScore)} size="small">
                {st.healthScore >= 85 ? "Healthy" : "Needs Review"}
              </Badge>
            </div>
            <ProgressBar progress={st.healthScore} tone={getHealthTone(st.healthScore)} size="small" />
          </div>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text variant="bodyMd" fontWeight="bold" as="span">
            {st._count?.products || 0}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <Badge tone={openIssues > 0 ? "critical" : "success"}>
              {`${openIssues} Open`}
            </Badge>
            {criticalIssues > 0 && (
              <Badge tone="critical">{`${criticalIssues} Critical`}</Badge>
            )}
          </div>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text variant="bodySm" tone="subdued" as="span">
            {new Date(st.installedAt).toLocaleDateString()}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px" }}>
            <Button
              size="micro"
              icon={ViewIcon}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedStoreModal(st);
              }}
            >
              Details
            </Button>
            {st.planId !== "enterprise" ? (
              <Button
                size="micro"
                tone="success"
                onClick={(e) => {
                  e.stopPropagation();
                  handleUpdateStorePlan(st.id, "enterprise");
                }}
              >
                Set Enterprise
              </Button>
            ) : (
              <Button
                size="micro"
                onClick={(e) => {
                  e.stopPropagation();
                  handleUpdateStorePlan(st.id, "free");
                }}
              >
                Set Free
              </Button>
            )}
          </div>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page
      fullWidth
      title="Admin Control Center"
      subtitle="Master management dashboard for merchant subscriptions, catalog audit status & support inquiries"
    >
      <BlockStack gap="500">
        {/* Action Feedback Banners */}
        {actionData?.error && (
          <Banner tone="critical" title="Action Failed">
            <p>{actionData.error}</p>
          </Banner>
        )}

        {actionData?.success && actionData?.message && (
          <Banner tone="success">
            <p>{actionData.message}</p>
          </Banner>
        )}

        {/* Executive Quick Stats Cards Header */}
        <Grid>
          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="bodySm" tone="subdued" fontWeight="bold">
                    Total Active Merchants
                  </Text>
                  <Box padding="200" borderRadius="200" background="bg-surface-secondary">
                    <Icon source={StoreIcon} tone="primary" />
                  </Box>
                </InlineStack>
                <BlockStack gap="100">
                  <Text variant="heading2xl" as="p" fontWeight="bold">
                    {stores.length}
                  </Text>
                  <InlineStack gap="100" blockAlign="center">
                    <Badge tone="success">100% Active Retention</Badge>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="bodySm" tone="subdued" fontWeight="bold">
                    Monthly Recurring Revenue
                  </Text>
                  <Box padding="200" borderRadius="200" background="bg-surface-success-subdued">
                    <Icon source={CashDollarIcon} tone="success" />
                  </Box>
                </InlineStack>
                <BlockStack gap="100">
                  <Text variant="heading2xl" as="p" fontWeight="bold" tone="success">
                    ${estimatedMRR.toLocaleString()}
                  </Text>
                  <InlineStack gap="100" blockAlign="center">
                    <Text variant="bodySm" tone="success" fontWeight="bold">
                      Active Subscriptions
                    </Text>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="bodySm" tone="subdued" fontWeight="bold">
                    Paid Subscribers
                  </Text>
                  <Box padding="200" borderRadius="200" background="bg-surface-caution-subdued">
                    <Icon source={PersonIcon} tone="highlight" />
                  </Box>
                </InlineStack>
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="baseline">
                    <Text variant="heading2xl" as="p" fontWeight="bold" tone="highlight">
                      {planCounts.growth + planCounts.pro + planCounts.enterprise}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      / {stores.length} total
                    </Text>
                  </InlineStack>
                  <Text variant="bodySm" tone="subdued">
                    {planCounts.enterprise} Enterprise • {planCounts.pro} Pro • {planCounts.growth} Growth
                  </Text>
                </BlockStack>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <div
              onClick={() => setActiveMainTab(2)}
              style={{ cursor: "pointer" }}
              title="Click to view Support Tickets Inbox"
            >
              <Card padding="400">
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="bodySm" tone="subdued" fontWeight="bold">
                      Support Ticket Inbox
                    </Text>
                    <Box
                      padding="200"
                      borderRadius="200"
                      background={openTicketsCount > 0 ? "bg-surface-critical-subdued" : "bg-surface-success-subdued"}
                    >
                      <Icon source={EmailIcon} tone={openTicketsCount > 0 ? "critical" : "success"} />
                    </Box>
                  </InlineStack>
                  <BlockStack gap="100">
                    <Text
                      variant="heading2xl"
                      as="p"
                      fontWeight="bold"
                      tone={openTicketsCount > 0 ? "critical" : undefined}
                    >
                      {openTicketsCount}
                    </Text>
                    <InlineStack gap="100" blockAlign="center">
                      <Badge tone={openTicketsCount > 0 ? "critical" : "success"}>
                        {openTicketsCount === 0 ? "All inquiries resolved" : `${openTicketsCount} open inquiries pending`}
                      </Badge>
                      <Text variant="bodySm" tone="interactive">
                        Click to Respond →
                      </Text>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              </Card>
            </div>
          </Grid.Cell>
        </Grid>

        {/* Main Nav Tabs */}
        <Card padding="0">
          <Tabs
            tabs={mainTabs}
            selected={activeMainTab}
            onSelect={(index) => setActiveMainTab(index)}
          />
          <Box padding="500">
            {/* TAB 0: MERCHANT DIRECTORY */}
            {activeMainTab === 0 && (
                <BlockStack gap="400">
                  {/* Toolbar & Filters */}
                  <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                    <Grid>
                      <Grid.Cell columnSpan={{ xs: 12, sm: 12, md: 6, lg: 6, xl: 6 }}>
                        <TextField
                          label="Search Merchants"
                          labelHidden
                          placeholder="Search merchant domain or admin email..."
                          value={searchQuery}
                          onChange={setSearchQuery}
                          prefix={<Icon source={SearchIcon} />}
                          clearButton
                          onClearButtonClick={() => setSearchQuery("")}
                          autoComplete="off"
                        />
                      </Grid.Cell>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
                        <Select
                          label="Filter by Plan"
                          labelHidden
                          options={[
                            { label: "All Plans", value: "all" },
                            { label: "Starter Free", value: "free" },
                            { label: "Growth Plan", value: "growth" },
                            { label: "Pro Advanced", value: "pro" },
                            { label: "Plus Enterprise", value: "enterprise" },
                          ]}
                          value={planFilter}
                          onChange={setPlanFilter}
                        />
                      </Grid.Cell>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
                        <Select
                          label="Filter by Health"
                          labelHidden
                          options={[
                            { label: "All Health Scores", value: "all" },
                            { label: "Healthy (≥85%)", value: "healthy" },
                            { label: "Needs Review (<85%)", value: "review" },
                          ]}
                          value={healthFilter}
                          onChange={setHealthFilter}
                        />
                      </Grid.Cell>
                    </Grid>
                  </Box>

                  {/* Filter Status Text */}
                  {(searchQuery || planFilter !== "all" || healthFilter !== "all") && (
                    <InlineStack align="space-between" blockAlign="center">
                      <Text variant="bodySm" tone="subdued">
                        Showing {filteredStores.length} of {stores.length} merchant stores
                      </Text>
                      <Button
                        size="micro"
                        variant="tertiary"
                        onClick={() => {
                          setSearchQuery("");
                          setPlanFilter("all");
                          setHealthFilter("all");
                        }}
                      >
                        Reset Filters
                      </Button>
                    </InlineStack>
                  )}

                  {/* Merchant IndexTable */}
                  {filteredStores.length === 0 ? (
                    <Box padding="800">
                      <BlockStack align="center" inlineAlign="center" gap="200">
                        <Icon source={StoreIcon} tone="subdued" />
                        <Text variant="headingSm">No merchants match your filters</Text>
                        <Text variant="bodySm" tone="subdued">
                          Try searching another store domain or resetting active filters.
                        </Text>
                      </BlockStack>
                    </Box>
                  ) : (
                    <IndexTable
                      resourceName={{ singular: "merchant", plural: "merchants" }}
                      itemCount={filteredStores.length}
                      headings={[
                        { title: "Merchant Store" },
                        { title: "Active Plan" },
                        { title: "Catalog Health" },
                        { title: "Products" },
                        { title: "Open Issues" },
                        { title: "Installed Date" },
                        { title: "Actions", alignment: "end" },
                      ]}
                      selectable={false}
                    >
                      {merchantRowsMarkup}
                    </IndexTable>
                  )}
                </BlockStack>
              )}

              {/* TAB 1: SUBSCRIPTION TIERS & PRICING MATRIX */}
              {activeMainTab === 1 && (
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h3">
                      Subscription Tiers & Plan Details
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Overview of active merchant allocations, product audit limits, and support SLAs across subscription tiers.
                    </Text>
                  </BlockStack>

                  <Grid>
                    {planTiers.map((tier) => (
                      <Grid.Cell key={tier.id} columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
                        <Card padding="500">
                          <BlockStack gap="400">
                            <InlineStack align="space-between" blockAlign="center">
                              <Text variant="headingMd" as="h4">
                                {tier.name}
                              </Text>
                              <Badge tone={planBadgeTone(tier.id)}>
                                {`${tier.merchants} Merchants`}
                              </Badge>
                            </InlineStack>

                            <BlockStack gap="100">
                              <Text variant="heading2xl" as="p" fontWeight="bold">
                                {tier.price}{" "}
                                <Text variant="bodySm" tone="subdued" as="span">
                                  / month
                                </Text>
                              </Text>
                              <Text variant="bodySm" tone="subdued">
                                MRR generated: ${tier.merchants * tier.priceAmount}
                              </Text>
                            </BlockStack>

                            <Divider />

                            <BlockStack gap="200">
                              <InlineStack gap="150" blockAlign="center">
                                <Icon source={CheckIcon} tone="success" size="small" />
                                <Text variant="bodySm">
                                  <strong>Audit Limit:</strong> {tier.auditLimit}
                                </Text>
                              </InlineStack>

                              <InlineStack gap="150" blockAlign="center">
                                <Icon source={CheckIcon} tone="success" size="small" />
                                <Text variant="bodySm">
                                  <strong>Support:</strong> {tier.support}
                                </Text>
                              </InlineStack>

                              <InlineStack gap="150" blockAlign="center">
                                <Icon
                                  source={tier.autoFix ? CheckIcon : ClockIcon}
                                  tone={tier.autoFix ? "success" : "subdued"}
                                  size="small"
                                />
                                <Text variant="bodySm" tone={tier.autoFix ? undefined : "subdued"}>
                                  <strong>Auto-Fix Engine:</strong> {tier.autoFix ? "Enabled" : "Manual only"}
                                </Text>
                              </InlineStack>
                            </BlockStack>
                          </BlockStack>
                        </Card>
                      </Grid.Cell>
                    ))}
                  </Grid>
                </BlockStack>
              )}

              {/* TAB 2: SUPPORT TICKETS INBOX */}
              {activeMainTab === 2 && (
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text variant="headingMd" as="h3">
                        Merchant Support Ticket Inbox
                      </Text>
                      <Text variant="bodySm" tone="subdued">
                        Inquiries submitted directly by merchants to support ({ADMIN_EMAIL})
                      </Text>
                    </BlockStack>
                    <Button icon={EmailIcon} url={`mailto:${ADMIN_EMAIL}`}>
                      Open Mailbox ({ADMIN_EMAIL})
                    </Button>
                  </InlineStack>

                  {/* Sub-Filter Buttons */}
                  <InlineStack gap="200" blockAlign="center">
                    <Button
                      size="micro"
                      variant={ticketStatusFilter === "ALL" ? "primary" : "secondary"}
                      onClick={() => setTicketStatusFilter("ALL")}
                    >
                      All Tickets ({supportTickets.length})
                    </Button>
                    <Button
                      size="micro"
                      tone="critical"
                      variant={ticketStatusFilter === "OPEN" ? "primary" : "secondary"}
                      onClick={() => setTicketStatusFilter("OPEN")}
                    >
                      Open ({openTicketsCount})
                    </Button>
                    <Button
                      size="micro"
                      tone="caution"
                      variant={ticketStatusFilter === "ANSWERED" ? "primary" : "secondary"}
                      onClick={() => setTicketStatusFilter("ANSWERED")}
                    >
                      Answered ({answeredTicketsCount})
                    </Button>
                    <Button
                      size="micro"
                      tone="success"
                      variant={ticketStatusFilter === "RESOLVED" ? "primary" : "secondary"}
                      onClick={() => setTicketStatusFilter("RESOLVED")}
                    >
                      Resolved ({resolvedTicketsCount})
                    </Button>
                  </InlineStack>

                  <Divider />

                  {filteredTickets.length === 0 ? (
                    <Box padding="600">
                      <BlockStack align="center" inlineAlign="center" gap="200">
                        <Icon source={CheckCircleIcon} tone="success" size="large" />
                        <Text variant="headingSm">No Support Tickets Found</Text>
                        <Text variant="bodySm" tone="subdued">
                          {ticketStatusFilter === "ALL"
                            ? "All merchant inquiries have been addressed and resolved."
                            : `No tickets with status "${ticketStatusFilter}".`}
                        </Text>
                      </BlockStack>
                    </Box>
                  ) : (
                    <BlockStack gap="400">
                      {filteredTickets.map((ticket) => (
                        <Card key={ticket.id} padding="500">
                          <BlockStack gap="400">
                            <InlineStack align="space-between" blockAlign="start">
                              <BlockStack gap="200">
                                <InlineStack gap="200" blockAlign="center">
                                  <Badge
                                    tone={
                                      ticket.status === "OPEN"
                                        ? "critical"
                                        : ticket.status === "ANSWERED"
                                        ? "caution"
                                        : "success"
                                    }
                                  >
                                    {ticket.status}
                                  </Badge>
                                  <Text variant="headingSm" as="h4" fontWeight="bold">
                                    {ticket.subject}
                                  </Text>
                                </InlineStack>
                                <InlineStack gap="400" wrap>
                                  <Text variant="bodySm" tone="subdued">
                                    <strong>Store:</strong> {ticket.store?.shopDomain || "Unknown Store"}
                                  </Text>
                                  <Text variant="bodySm" tone="subdued">
                                    <strong>Plan:</strong> {(ticket.planAtSubmission || "free").toUpperCase()}
                                  </Text>
                                  <Text variant="bodySm" tone="subdued">
                                    <strong>Contact:</strong> {ticket.merchantEmail}
                                  </Text>
                                  <Text variant="bodySm" tone="subdued">
                                    <strong>Date:</strong> {new Date(ticket.createdAt).toLocaleString()}
                                  </Text>
                                </InlineStack>
                              </BlockStack>

                              <ButtonGroup gap="200">
                                <Form method="post">
                                  <input
                                    type="hidden"
                                    name="actionType"
                                    value="TOGGLE_TICKET_STATUS"
                                  />
                                  <input type="hidden" name="ticketId" value={ticket.id} />
                                  <Button submit size="micro">
                                    {ticket.status === "RESOLVED" ? "Reopen Ticket" : "Mark Resolved"}
                                  </Button>
                                </Form>
                                <Button
                                  size="micro"
                                  icon={EmailIcon}
                                  url={`mailto:${ticket.merchantEmail}?subject=Re: ${encodeURIComponent(ticket.subject)}`}
                                >
                                  Email Client
                                </Button>
                              </ButtonGroup>
                            </InlineStack>

                            {/* Message Conversation History Thread */}
                            <BlockStack gap="200">
                              <Text variant="bodySm" fontWeight="bold" tone="subdued">
                                Conversation Thread:
                              </Text>
                              {(ticket.messages || []).map((msg) => {
                                const isAdminMsg = msg.sender === "ADMIN";
                                return (
                                  <Box
                                    key={msg.id}
                                    padding="300"
                                    borderRadius="200"
                                    background={
                                      isAdminMsg
                                        ? "bg-surface-success-subdued"
                                        : "bg-surface-secondary"
                                    }
                                    style={
                                      isAdminMsg
                                        ? { borderLeft: "4px solid var(--p-color-border-brand, #008060)" }
                                        : undefined
                                    }
                                  >
                                    <BlockStack gap="100">
                                      <InlineStack align="space-between" blockAlign="center">
                                        <InlineStack gap="200" blockAlign="center">
                                          <Text
                                            variant="bodySm"
                                            fontWeight="bold"
                                            tone={isAdminMsg ? "success" : undefined}
                                          >
                                            {isAdminMsg
                                              ? `Support Team (${msg.authorEmail || ADMIN_EMAIL})`
                                              : `Merchant (${msg.authorEmail || ticket.merchantEmail})`}
                                          </Text>
                                          {isAdminMsg && <Badge tone="success">ADMIN RESPONSE</Badge>}
                                        </InlineStack>
                                        <Text variant="bodySm" tone="subdued">
                                          {new Date(msg.createdAt).toLocaleString()}
                                        </Text>
                                      </InlineStack>
                                      <Text variant="bodySm" fontWeight={isAdminMsg ? "medium" : undefined}>
                                        {msg.body}
                                      </Text>
                                    </BlockStack>
                                  </Box>
                                );
                              })}
                            </BlockStack>

                            <Divider />

                            {/* Reply Input Form */}
                            <Form method="post">
                              <input type="hidden" name="actionType" value="REPLY_SUPPORT_TICKET" />
                              <input type="hidden" name="ticketId" value={ticket.id} />
                              <BlockStack gap="200">
                                <TextField
                                  name="replyText"
                                  label="Send Response to Merchant"
                                  value={replyInputs[ticket.id] || ""}
                                  onChange={(val) =>
                                    setReplyInputs((prev) => ({ ...prev, [ticket.id]: val }))
                                  }
                                  placeholder="Type your response message for the merchant..."
                                  multiline={2}
                                  autoComplete="off"
                                />
                                <InlineStack align="end">
                                  <Button submit size="micro" variant="primary">
                                    Send &amp; Notify Merchant
                                  </Button>
                                </InlineStack>
                              </BlockStack>
                            </Form>
                          </BlockStack>
                        </Card>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              )}
            </Box>
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
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text variant="headingSm" as="h4">
                    Store Metadata & Subscription Status
                  </Text>
                  <Text variant="bodySm" tone="subdued">
                    Store ID: {selectedStoreModal.id}
                  </Text>
                </BlockStack>
                <Badge tone={planBadgeTone(selectedStoreModal.planId)}>
                  {`${planName(selectedStoreModal.planId).toUpperCase()} PLAN`}
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
                      Catalog Health Score
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
                <InlineStack gap="200" wrap>
                  {planTiers.map((tier) => (
                    <Button
                      key={tier.id}
                      tone={tier.id === "enterprise" ? "success" : undefined}
                      disabled={selectedStoreModal.planId === tier.id}
                      onClick={() => handleUpdateStorePlan(selectedStoreModal.id, tier.id)}
                    >
                      {`Switch to ${tier.name} (${tier.price})`}
                    </Button>
                  ))}
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
