/* global process */
import { useState, useEffect } from "react";
import { useLoaderData, useActionData, useFetcher } from "react-router";
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
  TextField,
  Icon,
  Tabs,
  ProgressBar,
  Select,
} from "@shopify/polaris";
import {
  CheckCircleIcon,
  EmailIcon,
  SearchIcon,
  StoreIcon,
  CashDollarIcon,
  PersonIcon,
  ClockIcon,
  CheckIcon,
  XIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord } from "../services/syncEngine.server.js";
import {
  PLAN_CONFIG,
  PLAN_IDS,
  normalizePlanId,
  calculateYearlyPricing,
} from "../services/planConfig.js";
import {
  addAdminReply,
  listAllTickets,
  toggleTicketStatus,
} from "../services/supportEngine.server.js";
import {
  getYearlyDiscountPercentage,
  setYearlyDiscountPercentage,
} from "../services/settingsEngine.server.js";


// Read on the server only: this module is also evaluated in the browser, where
// `process` does not exist - a top-level `process.env` read here throws before
// React can hydrate and leaves the whole page inert.
const getAdminEmail = () => process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com";
const getAdminShopPrefix = () =>
  process.env.ADMIN_STORE_NAME || "quickstart-749ac396";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const currentStore = await ensureStoreRecord(session.shop);

  const adminEmail = getAdminEmail();
  const adminShopPrefix = getAdminShopPrefix();

  const shopDomain = session.shop.toLowerCase();
  const storeAdminEmail = (currentStore.adminEmail || "").toLowerCase();

  const isAdmin =
    shopDomain.includes(adminShopPrefix.toLowerCase()) ||
    storeAdminEmail === adminEmail.toLowerCase();

  if (!isAdmin) {
    return {
      isAdmin: false,
      adminEmail,
      adminShopPrefix,
      currentStore,
      stores: [],
      planCounts: { free: 0, growth: 0, pro: 0, enterprise: 0 },
      planTiers: [],
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
    const pId = normalizePlanId(st.plan) || "free";
    planCounts[pId] = (planCounts[pId] || 0) + 1;
  });

  const estimatedMRR = PLAN_IDS.reduce(
    (sum, id) => sum + (planCounts[id] || 0) * PLAN_CONFIG[id].priceAmount,
    0,
  );

  const planTiers = PLAN_IDS.map((id) => ({
    id,
    name: PLAN_CONFIG[id].name,
    price: PLAN_CONFIG[id].price,
    priceAmount: PLAN_CONFIG[id].priceAmount,
    merchants: planCounts[id] || 0,
    auditLimit: PLAN_CONFIG[id].maxProductsLabel,
    support: PLAN_CONFIG[id].supportSla,
    autoFix: PLAN_CONFIG[id].autoFix,
  }));

  const supportTickets = await listAllTickets();
  const yearlyDiscountPercent = await getYearlyDiscountPercentage();

  return {
    isAdmin: true,
    adminEmail,
    adminShopPrefix,
    currentStore,
    stores: stores.map((st) => ({
      ...st,
      planId: normalizePlanId(st.plan) || "free",
      healthScore: st.healthScore ?? 100,
    })),
    planCounts,
    planTiers,
    estimatedMRR,
    supportTickets,
    yearlyDiscountPercent,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const currentStore = await ensureStoreRecord(session.shop);

  const adminEmail = getAdminEmail();
  const adminShopPrefix = getAdminShopPrefix();

  const shopDomain = session.shop.toLowerCase();
  const storeAdminEmail = (currentStore.adminEmail || "").toLowerCase();

  const isAdmin =
    shopDomain.includes(adminShopPrefix.toLowerCase()) ||
    storeAdminEmail === adminEmail.toLowerCase();

  if (!isAdmin) {
    return {
      success: false,
      error: "Unauthorized access: Admin portal is restricted to authorized accounts only.",
    };
  }

  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "UPDATE_YEARLY_DISCOUNT") {
    const discount = formData.get("discountPercentage");
    const result = await setYearlyDiscountPercentage(discount);
    return result;
  }

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
        authorEmail: adminEmail,
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
    const rawPlan = formData.get("newPlan");
    const newPlan = normalizePlanId(rawPlan);

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

    return {
      success: true,
      message: `Merchant plan successfully updated to ${PLAN_CONFIG[newPlan].name}.`,
    };
  }

  return { success: false, error: "Invalid action request." };
};

export default function AdminDashboard() {
  const {
    isAdmin,
    adminEmail: ADMIN_EMAIL,
    adminShopPrefix: ADMIN_SHOP_PREFIX,
    currentStore,
    stores: serverStores,
    planTiers,
    supportTickets,
    yearlyDiscountPercent: serverYearlyDiscount,
  } = useLoaderData();

  const planFetcher = useFetcher();
  const ticketFetcher = useFetcher();
  const discountFetcher = useFetcher();
  const actionData = useActionData();

  const [yearlyDiscountInput, setYearlyDiscountInput] = useState(
    serverYearlyDiscount ?? 20
  );

  // Local state for stores (enables immediate optimistic UI updates)
  const [localStores, setLocalStores] = useState(serverStores);
  const [activeMainTab, setActiveMainTab] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [planFilter, setPlanFilter] = useState("all");
  const [healthFilter, setHealthFilter] = useState("all");
  const [ticketStatusFilter, setTicketStatusFilter] = useState("ALL");

  // Detailed Merchant view control
  const [expandedStoreId, setExpandedStoreId] = useState(null);

  const [replyInputs, setReplyInputs] = useState({});
  const [feedbackMessage, setFeedbackMessage] = useState(null);

  // Sync server stores when loader revalidates
  useEffect(() => {
    setLocalStores(serverStores);
  }, [serverStores]);

  useEffect(() => {
    if (serverYearlyDiscount !== undefined) {
      setYearlyDiscountInput(serverYearlyDiscount);
    }
  }, [serverYearlyDiscount]);

  // Handle action response alerts
  useEffect(() => {
    const data =
      planFetcher.data || ticketFetcher.data || discountFetcher.data || actionData;
    if (data?.message) {
      setFeedbackMessage({ tone: "success", text: data.message });
    } else if (data?.error) {
      setFeedbackMessage({ tone: "critical", text: data.error });
    }
  }, [planFetcher.data, ticketFetcher.data, discountFetcher.data, actionData]);

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

  // Calculate stats dynamically from localStores (instant optimistic responsiveness)
  const localPlanCounts = { free: 0, growth: 0, pro: 0, enterprise: 0 };
  localStores.forEach((st) => {
    const pId = normalizePlanId(st.plan) || st.planId || "free";
    localPlanCounts[pId] = (localPlanCounts[pId] || 0) + 1;
  });

  const localEstimatedMRR = PLAN_IDS.reduce(
    (sum, id) => sum + (localPlanCounts[id] || 0) * PLAN_CONFIG[id].priceAmount,
    0,
  );

  const paidSubscribersCount =
    (localPlanCounts.growth || 0) +
    (localPlanCounts.pro || 0) +
    (localPlanCounts.enterprise || 0);

  const planName = (planId) =>
    planTiers.find((tier) => tier.id === planId)?.name || PLAN_CONFIG[planId]?.name || planId;

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

  // Optimistic handler for updating merchant subscription plan
  const handleUpdateStorePlan = (storeId, newPlanInput) => {
    const newPlan = normalizePlanId(newPlanInput) || "free";

    // 1. Optimistically update local state immediately
    setLocalStores((prevStores) =>
      prevStores.map((st) =>
        st.id === storeId
          ? { ...st, plan: newPlan, planId: newPlan }
          : st
      )
    );

    // 2. Submit to server backend
    const fd = new FormData();
    fd.append("actionType", "UPDATE_MERCHANT_PLAN");
    fd.append("storeId", storeId);
    fd.append("newPlan", newPlan);
    planFetcher.submit(fd, { method: "post" });
  };

  // Filter stores
  const filteredStores = localStores.filter((st) => {
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
      content: `Merchant Directory (${localStores.length})`,
      panelID: "merchants-panel",
    },
    {
      id: "tiers-tab",
      content: `Yearly Discount Config (${yearlyDiscountInput}% OFF)`,
      panelID: "tiers-panel",
    },
    {
      id: "support-tab",
      content: `Support Tickets (${supportTickets.length})${openTicketsCount > 0 ? ` [${openTicketsCount} OPEN]` : ""}`,
      panelID: "support-panel",
    },
  ];

  const merchantTableRows = filteredStores.map((st) => {
    const openIssues = (st.issues || []).length;
    const criticalIssues = (st.issues || []).filter((i) => i.severity === "CRITICAL").length;
    const isUpdatingThisStore =
      planFetcher.state !== "idle" &&
      planFetcher.formData?.get("storeId") === st.id;

    const isExpanded = expandedStoreId === st.id;

    return [
      <div key={`store-${st.id}`} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
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
      </div>,

      <Badge key={`plan-${st.id}`} tone={planBadgeTone(st.planId)}>
        {planName(st.planId).toUpperCase()}
      </Badge>,

      <div key={`health-${st.id}`} style={{ minWidth: "140px", display: "flex", flexDirection: "column", gap: "4px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <Text variant="bodySm" fontWeight="bold" as="span">
            {(st.healthScore ?? 100).toFixed(1)}%
          </Text>
          <Badge tone={getHealthTone(st.healthScore ?? 100)} size="small">
            {(st.healthScore ?? 100) >= 85 ? "Healthy" : "Needs Review"}
          </Badge>
        </div>
        <ProgressBar progress={st.healthScore ?? 100} tone={getHealthTone(st.healthScore ?? 100)} size="small" />
      </div>,

      <Text key={`prods-${st.id}`} variant="bodyMd" fontWeight="bold" as="span">
        {st._count?.products || 0}
      </Text>,

      <div key={`issues-${st.id}`} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <Badge tone={openIssues > 0 ? "critical" : "success"}>
          {`${openIssues} Open`}
        </Badge>
        {criticalIssues > 0 && (
          <Badge tone="critical">{`${criticalIssues} Critical`}</Badge>
        )}
      </div>,

      <Text key={`date-${st.id}`} variant="bodySm" tone="subdued" as="span">
        {new Date(st.installedAt).toLocaleDateString()}
      </Text>,

      <div key={`actions-${st.id}`} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px" }}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpandedStoreId((prev) => (prev === st.id ? null : st.id));
          }}
          style={{
            cursor: "pointer",
            padding: "5px 12px",
            fontSize: "12px",
            fontWeight: "600",
            borderRadius: "6px",
            border: "1px solid #d2d5d8",
            backgroundColor: isExpanded ? "#008060" : "#ffffff",
            color: isExpanded ? "#ffffff" : "#202223",
            boxShadow: "0 1px 0 rgba(0,0,0,0.05)",
            transition: "all 0.15s ease-in-out",
          }}
        >
          {isExpanded ? "Hide Details" : "Details"}
        </button>
      </div>,
    ];
  });

  const expandedStore = localStores.find((s) => s.id === expandedStoreId);

  return (
    <Page
      fullWidth
      title="Admin Control Center"
      subtitle="Master management dashboard for merchant subscriptions, catalog audit status & support inquiries"
    >
      <BlockStack gap="500">
        {/* Action Feedback Banners */}
        {feedbackMessage && (
          <Banner
            tone={feedbackMessage.tone}
            onDismiss={() => setFeedbackMessage(null)}
          >
            <p>{feedbackMessage.text}</p>
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
                    {localStores.length}
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
                    ${localEstimatedMRR.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
                      {paidSubscribersCount}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      / {localStores.length} total
                    </Text>
                  </InlineStack>
                  <Text variant="bodySm" tone="subdued">
                    {localPlanCounts.enterprise || 0} Enterprise • {localPlanCounts.pro || 0} Pro • {localPlanCounts.growth || 0} Growth
                  </Text>
                </BlockStack>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => setActiveMainTab(2)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActiveMainTab(2);
                }
              }}
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
                      Showing {filteredStores.length} of {localStores.length} merchant stores
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

                {/* Inline Expanded Merchant Details Drawer Card */}
                {expandedStore && (
                  // Polaris Box ignores a raw `style` prop, so the highlight is
                  // expressed with its own border/background tokens.
                  <Box
                    padding="500"
                    borderRadius="300"
                    background="bg-surface-secondary"
                    shadow="300"
                    borderWidth="050"
                    borderColor="border-success"
                  >
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <InlineStack gap="200" blockAlign="center">
                          <Icon source={StoreIcon} tone="success" />
                          <Text variant="headingMd" as="h3" fontWeight="bold">
                            Merchant Store Details — {expandedStore.shopDomain}
                          </Text>
                        </InlineStack>
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={planBadgeTone(expandedStore.planId)}>
                            {`${planName(expandedStore.planId).toUpperCase()} PLAN`}
                          </Badge>
                          <Button
                            size="micro"
                            icon={XIcon}
                            accessibilityLabel="Close store details"
                            onClick={() => setExpandedStoreId(null)}
                          />
                        </InlineStack>
                      </InlineStack>

                      <Divider />

                      <Grid>
                        <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
                          <BlockStack gap="100">
                            <Text variant="bodySm" tone="subdued">
                              Database Store ID
                            </Text>
                            <Text variant="bodySm" fontWeight="bold">
                              {expandedStore.id}
                            </Text>
                          </BlockStack>
                        </Grid.Cell>
                        <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
                          <BlockStack gap="100">
                            <Text variant="bodySm" tone="subdued">
                              Installed Date
                            </Text>
                            <Text variant="bodyMd" fontWeight="bold">
                              {new Date(expandedStore.installedAt).toLocaleString()}
                            </Text>
                          </BlockStack>
                        </Grid.Cell>
                        <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
                          <BlockStack gap="100">
                            <Text variant="bodySm" tone="subdued">
                              Admin Contact Email
                            </Text>
                            <Text variant="bodyMd" fontWeight="bold">
                              {expandedStore.adminEmail || "sandeepptpss@gmail.com"}
                            </Text>
                          </BlockStack>
                        </Grid.Cell>
                        <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
                          <BlockStack gap="100">
                            <Text variant="bodySm" tone="subdued">
                              Synced Products Count
                            </Text>
                            <Text variant="headingLg" as="p" fontWeight="bold">
                              {expandedStore._count?.products || 0} Products
                            </Text>
                          </BlockStack>
                        </Grid.Cell>
                      </Grid>
                    </BlockStack>
                  </Box>
                )}

                {/* Merchant DataTable */}
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
                  <DataTable
                    columnContentTypes={["text", "text", "text", "numeric", "text", "text", "text"]}
                    headings={[
                      "Merchant Store",
                      "Active Plan",
                      "Catalog Health",
                      "Products",
                      "Open Issues",
                      "Installed Date",
                      "Actions",
                    ]}
                    rows={merchantTableRows}
                  />
                )}
              </BlockStack>
            )}

            {/* TAB 1: SUBSCRIPTION TIERS & PRICING MATRIX */}
            {activeMainTab === 1 && (
              <BlockStack gap="400">
                {/* Admin Yearly Discount Config Card */}
                <Card padding="500">
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Icon source={CashDollarIcon} tone="success" />
                          <Text variant="headingMd" as="h3" fontWeight="bold">
                            Yearly Subscription Discount Configuration
                          </Text>
                        </InlineStack>
                        <Text variant="bodySm" tone="subdued">
                          Configure a dynamic percentage discount for yearly subscription plans. Updates apply instantly across the merchant plans portal.
                        </Text>
                      </BlockStack>
                      <Badge tone="success">{`${yearlyDiscountInput}% OFF ANNUAL DISCOUNT`}</Badge>
                    </InlineStack>

                    <Divider />

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData();
                        fd.append("actionType", "UPDATE_YEARLY_DISCOUNT");
                        fd.append("discountPercentage", yearlyDiscountInput);
                        discountFetcher.submit(fd, { method: "post" });
                      }}
                    >
                      <Grid>
                        <Grid.Cell columnSpan={{ xs: 12, sm: 8, md: 8, lg: 8, xl: 8 }}>
                          <TextField
                            label="Annual Billing Discount Percentage (%)"
                            type="number"
                            min={0}
                            max={100}
                            step={0.5}
                            value={String(yearlyDiscountInput)}
                            onChange={(val) => setYearlyDiscountInput(val)}
                            helpText="Updating this percentage recalculates annual pricing for all paid plans (Growth, Pro, Enterprise)."
                            autoComplete="off"
                          />
                        </Grid.Cell>
                        <Grid.Cell columnSpan={{ xs: 12, sm: 4, md: 4, lg: 4, xl: 4 }}>
                          <Box paddingBlockStart="500">
                            <Button
                              submit
                              variant="primary"
                              fullWidth
                              loading={discountFetcher.state !== "idle"}
                            >
                              Save Discount Configuration
                            </Button>
                          </Box>
                        </Grid.Cell>
                      </Grid>
                    </form>
                  </BlockStack>
                </Card>
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

                            <InlineStack gap="200">
                              <Button
                                size="micro"
                                loading={
                                  ticketFetcher.state !== "idle" &&
                                  ticketFetcher.formData?.get("ticketId") === ticket.id
                                }
                                onClick={() => {
                                  const fd = new FormData();
                                  fd.append("actionType", "TOGGLE_TICKET_STATUS");
                                  fd.append("ticketId", ticket.id);
                                  ticketFetcher.submit(fd, { method: "post" });
                                }}
                              >
                                {ticket.status === "RESOLVED" ? "Reopen Ticket" : "Mark Resolved"}
                              </Button>
                              <Button
                                size="micro"
                                icon={EmailIcon}
                                url={`mailto:${ticket.merchantEmail}?subject=Re: ${encodeURIComponent(ticket.subject)}`}
                              >
                                Email Client
                              </Button>
                            </InlineStack>
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
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              const replyText = (replyInputs[ticket.id] || "").trim();
                              if (!replyText) return;

                              const fd = new FormData();
                              fd.append("actionType", "REPLY_SUPPORT_TICKET");
                              fd.append("ticketId", ticket.id);
                              fd.append("replyText", replyText);
                              ticketFetcher.submit(fd, { method: "post" });

                              setReplyInputs((prev) => ({ ...prev, [ticket.id]: "" }));
                            }}
                          >
                            <BlockStack gap="200">
                              <TextField
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
                                <Button
                                  submit
                                  size="micro"
                                  variant="primary"
                                  loading={
                                    ticketFetcher.state !== "idle" &&
                                    ticketFetcher.formData?.get("ticketId") === ticket.id &&
                                    ticketFetcher.formData?.get("actionType") === "REPLY_SUPPORT_TICKET"
                                  }
                                >
                                  Send &amp; Notify Merchant
                                </Button>
                              </InlineStack>
                            </BlockStack>
                          </form>
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
    </Page>
  );
}
