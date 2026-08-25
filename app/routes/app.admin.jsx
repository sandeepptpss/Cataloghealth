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
  getYearlyDiscountPercentage,
  setYearlyDiscountPercentage,
  getMerchantOffers,
  setMerchantOffer,
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

  const yearlyDiscountPercent = await getYearlyDiscountPercentage();
  const merchantOffers = await getMerchantOffers();

  return {
    isAdmin: true,
    adminEmail,
    adminShopPrefix,
    currentStore,
    stores: stores.map((st) => ({
      ...st,
      planId: normalizePlanId(st.plan) || "free",
      healthScore: st.healthScore ?? 100,
      offerTag: merchantOffers[st.id] || null,
    })),
    planCounts,
    planTiers,
    estimatedMRR,
    yearlyDiscountPercent,
    merchantOffers,
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

  if (actionType === "UPDATE_MERCHANT_OFFER") {
    const storeId = formData.get("storeId");
    const offerTag = formData.get("offerTag");
    const targetPlan = formData.get("targetPlan");

    if (!storeId) {
      return { success: false, error: "Store ID is required." };
    }

    const result = await setMerchantOffer(storeId, offerTag);

    if (targetPlan) {
      const newPlan = normalizePlanId(targetPlan);
      if (newPlan) {
        await prisma.store.update({
          where: { id: storeId },
          data: { plan: newPlan },
        });
      }
    }

    return result;
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
    yearlyDiscountPercent: serverYearlyDiscount,
  } = useLoaderData();

  const planFetcher = useFetcher();
  const discountFetcher = useFetcher();
  const actionData = useActionData();

  const [yearlyDiscountInput, setYearlyDiscountInput] = useState(
    serverYearlyDiscount ?? 20
  );

  // Local state for stores (enables immediate optimistic UI updates)
  const [localStores, setLocalStores] = useState(serverStores || []);
  const [activeMainTab, setActiveMainTab] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [planFilter, setPlanFilter] = useState("all");
  const [healthFilter, setHealthFilter] = useState("all");

  // Detailed Merchant view control
  const [expandedStoreId, setExpandedStoreId] = useState(null);
  const [feedbackMessage, setFeedbackMessage] = useState(null);

  // Sync server stores when loader revalidates
  useEffect(() => {
    setLocalStores(serverStores || []);
  }, [serverStores]);

  useEffect(() => {
    if (serverYearlyDiscount !== undefined) {
      setYearlyDiscountInput(serverYearlyDiscount);
    }
  }, [serverYearlyDiscount]);

  // Handle action response alerts
  useEffect(() => {
    const data = planFetcher.data || discountFetcher.data || actionData;
    if (data?.message) {
      setFeedbackMessage({ tone: "success", text: data.message });
    } else if (data?.error) {
      setFeedbackMessage({ tone: "critical", text: data.error });
    }
  }, [planFetcher.data, discountFetcher.data, actionData]);

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
  let totalProductsMonitored = 0;
  let totalHealthSum = 0;

  localStores.forEach((st) => {
    const pId = normalizePlanId(st.plan) || st.planId || "free";
    localPlanCounts[pId] = (localPlanCounts[pId] || 0) + 1;
    totalProductsMonitored += st._count?.products || 0;
    totalHealthSum += st.healthScore ?? 100;
  });

  const avgPlatformHealth =
    localStores.length > 0 ? totalHealthSum / localStores.length : 100;

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

  // Optimistic handler for merchant-specific promotional offer
  const handleUpdateStoreOffer = (storeId, offerTag, targetPlan) => {
    const cleanOffer = offerTag ? offerTag.trim() : "";
    const cleanPlan = targetPlan ? normalizePlanId(targetPlan) : null;

    setLocalStores((prevStores) =>
      prevStores.map((st) =>
        st.id === storeId
          ? {
              ...st,
              offerTag: cleanOffer || null,
              ...(cleanPlan ? { plan: cleanPlan, planId: cleanPlan } : {}),
            }
          : st
      )
    );

    const fd = new FormData();
    fd.append("actionType", "UPDATE_MERCHANT_OFFER");
    fd.append("storeId", storeId);
    fd.append("offerTag", cleanOffer);
    if (cleanPlan) fd.append("targetPlan", cleanPlan);
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
    else if (healthFilter === "offers") matchesHealth = Boolean(st.offerTag);

    return matchesSearch && matchesPlan && matchesHealth;
  });

  const mainTabs = [
    {
      id: "merchants-tab",
      content: `Merchant Directory (${localStores.length})`,
      panelID: "merchants-panel",
    },
    {
      id: "tiers-tab",
      content: `Yearly Discount Config (${Number(yearlyDiscountInput) || 0}% OFF)`,
      panelID: "tiers-panel",
    },
    {
      id: "analytics-tab",
      content: "Subscription Analytics",
      panelID: "analytics-panel",
    },
  ];

  const merchantTableRows = filteredStores.map((st) => {
    const openIssues = (st.issues || []).length;
    const criticalIssues = (st.issues || []).filter((i) => i.severity === "CRITICAL").length;
    const isUpdatingThisStore =
      planFetcher.state !== "idle" &&
      planFetcher.formData?.get("storeId") === st.id;

    const isExpanded = expandedStoreId === st.id;
    const currentPlan = st.planId || normalizePlanId(st.plan) || "free";

    return [
      // Store Domain & Admin Info
      <div key={`store-${st.id}`} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "4px 0" }}>
        <div
          style={{
            width: "36px",
            height: "36px",
            borderRadius: "10px",
            background: "linear-gradient(135deg, #008060 0%, #004c3f 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#ffffff",
            boxShadow: "0 2px 6px rgba(0,128,96,0.25)",
            flexShrink: 0,
          }}
        >
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

      // Active Plan & Direct Plan Switcher Dropdown
      <div key={`plan-${st.id}`} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          <Badge tone={planBadgeTone(currentPlan)}>
            {planName(currentPlan).toUpperCase()}
          </Badge>
          {st.offerTag && (
            <Badge tone="warning">
              {`PROMO: ${st.offerTag}`}
            </Badge>
          )}
          {isUpdatingThisStore && (
            <Text variant="bodyXs" tone="subdued" as="span">
              Updating...
            </Text>
          )}
        </div>
        <div style={{ maxWidth: "160px" }}>
          <Select
            label="Change Plan"
            labelHidden
            options={[
              { label: "Starter Free ($0)", value: "free" },
              { label: "Growth Plan ($4.99)", value: "growth" },
              { label: "Pro Advanced ($9.99)", value: "pro" },
              { label: "Plus Enterprise ($19.99)", value: "enterprise" },
            ]}
            value={currentPlan}
            onChange={(val) => handleUpdateStorePlan(st.id, val)}
            disabled={isUpdatingThisStore}
          />
        </div>
      </div>,

      // Health Score & Mini Progress Meter
      <div key={`health-${st.id}`} style={{ minWidth: "150px", display: "flex", flexDirection: "column", gap: "4px" }}>
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

      // Synced Products Count
      <Text key={`prods-${st.id}`} variant="bodyMd" fontWeight="bold" as="span">
        {(st._count?.products || 0).toLocaleString()}
      </Text>,

      // Open & Critical Issues Pills
      <div key={`issues-${st.id}`} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <Badge tone={openIssues > 0 ? "critical" : "success"}>
          {`${openIssues} Open`}
        </Badge>
        {criticalIssues > 0 && (
          <Badge tone="critical">{`${criticalIssues} Critical`}</Badge>
        )}
      </div>,

      // Installation Date
      <div key={`date-${st.id}`} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <Text variant="bodySm" fontWeight="medium" as="span">
          {new Date(st.installedAt).toLocaleDateString()}
        </Text>
        <Text variant="bodyXs" tone="subdued" as="span">
          {Math.max(1, Math.floor((Date.now() - new Date(st.installedAt).getTime()) / (1000 * 60 * 60 * 24)))} days ago
        </Text>
      </div>,

      // Actions Column
      <div key={`actions-${st.id}`} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px" }}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpandedStoreId((prev) => (prev === st.id ? null : st.id));
          }}
          style={{
            cursor: "pointer",
            padding: "6px 14px",
            fontSize: "12px",
            fontWeight: "600",
            borderRadius: "6px",
            border: isExpanded ? "1px solid #008060" : "1px solid #c9cccf",
            backgroundColor: isExpanded ? "#008060" : "#ffffff",
            color: isExpanded ? "#ffffff" : "#202223",
            boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
            transition: "all 0.15s ease-in-out",
          }}
        >
          {isExpanded ? "Close Controls" : "Inspect Store"}
        </button>
      </div>,
    ];
  });

  const expandedStore = localStores.find((s) => s.id === expandedStoreId);

  return (
    <Page fullWidth>
      <BlockStack gap="500">
        {/* Executive Hero Banner Header */}
        <Box
          padding="600"
          borderRadius="400"
          style={{
            background: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)",
            color: "#ffffff",
            boxShadow: "0 10px 25px -5px rgba(15,23,42,0.3)",
            border: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="success" size="large">
                  SUPERADMIN CONTROL CENTER
                </Badge>
                <span style={{ fontSize: "12px", color: "#34d399", fontWeight: "600", letterSpacing: "0.5px" }}>
                  ● LIVE PLATFORM MONITORED
                </span>
              </InlineStack>
              <Text variant="bodySm" style={{ color: "#94a3b8" }}>
                Admin Email: <strong style={{ color: "#ffffff" }}>{ADMIN_EMAIL}</strong>
              </Text>
            </InlineStack>

            <BlockStack gap="100">
              <Text variant="heading2xl" as="h1" fontWeight="bold" style={{ color: "#ffffff" }}>
                Master Platform Control Panel
              </Text>
              <Text variant="bodyMd" style={{ color: "#cbd5e1" }}>
                Manage merchant subscriptions, inspect store catalog audit metrics, and configure annual billing discounts in real-time.
              </Text>
            </BlockStack>

            <Divider />

            <InlineStack gap="400" blockAlign="center" wrap>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#e2e8f0", fontSize: "13px" }}>
                <span style={{ color: "#38bdf8", fontWeight: "bold" }}>●</span>
                <span>Active Stores: <strong style={{ color: "#ffffff" }}>{localStores.length}</strong></span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#e2e8f0", fontSize: "13px" }}>
                <span style={{ color: "#34d399", fontWeight: "bold" }}>●</span>
                <span>Platform MRR: <strong style={{ color: "#ffffff" }}>${localEstimatedMRR.toFixed(2)}</strong></span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#e2e8f0", fontSize: "13px" }}>
                <span style={{ color: "#fbbf24", fontWeight: "bold" }}>●</span>
                <span>Avg. Catalog Health: <strong style={{ color: "#ffffff" }}>{avgPlatformHealth.toFixed(1)}%</strong></span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#e2e8f0", fontSize: "13px" }}>
                <span style={{ color: "#a855f7", fontWeight: "bold" }}>●</span>
                <span>Products Monitored: <strong style={{ color: "#ffffff" }}>{totalProductsMonitored.toLocaleString()}</strong></span>
              </div>
            </InlineStack>
          </BlockStack>
        </Box>

        {/* Action Feedback Banners */}
        {feedbackMessage && (
          <Banner
            tone={feedbackMessage.tone}
            onDismiss={() => setFeedbackMessage(null)}
          >
            <p>{feedbackMessage.text}</p>
          </Banner>
        )}

        {/* 4-Grid Executive KPI Quick Stats Header */}
        <Grid>
          {/* Card 1: Total Merchants */}
          <Grid.Cell columnSpan={{ xs: 12, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="bodySm" tone="subdued" fontWeight="bold">
                    Active Merchants
                  </Text>
                  <Box padding="200" borderRadius="200" background="bg-surface-secondary">
                    <Icon source={StoreIcon} tone="primary" />
                  </Box>
                </InlineStack>
                <BlockStack gap="050">
                  <Text variant="heading2xl" as="p" fontWeight="bold">
                    {localStores.length}
                  </Text>
                  <InlineStack gap="100" blockAlign="center">
                    <Badge tone="success">100% Active Retention</Badge>
                  </InlineStack>
                </BlockStack>
                <Text variant="bodyXs" tone="subdued">
                  {localStores.length} total installed merchant accounts
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>

          {/* Card 2: Monthly Recurring Revenue */}
          <Grid.Cell columnSpan={{ xs: 12, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="bodySm" tone="subdued" fontWeight="bold">
                    Monthly Revenue (MRR)
                  </Text>
                  <Box padding="200" borderRadius="200" background="bg-surface-success-subdued">
                    <Icon source={CashDollarIcon} tone="success" />
                  </Box>
                </InlineStack>
                <BlockStack gap="050">
                  <Text variant="heading2xl" as="p" fontWeight="bold" tone="success">
                    ${localEstimatedMRR.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </Text>
                  <Text variant="bodyXs" tone="success" fontWeight="bold">
                    ${(localEstimatedMRR * 12).toFixed(2)}/yr annualized
                  </Text>
                </BlockStack>
                <Text variant="bodyXs" tone="subdued">
                  Based on active merchant plan tiers
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>

          {/* Card 3: Paid Subscribers */}
          <Grid.Cell columnSpan={{ xs: 12, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="bodySm" tone="subdued" fontWeight="bold">
                    Paid Subscribers
                  </Text>
                  <Box padding="200" borderRadius="200" background="bg-surface-caution-subdued">
                    <Icon source={PersonIcon} tone="highlight" />
                  </Box>
                </InlineStack>
                <BlockStack gap="050">
                  <InlineStack gap="200" blockAlign="baseline">
                    <Text variant="heading2xl" as="p" fontWeight="bold" tone="highlight">
                      {paidSubscribersCount}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      / {localStores.length} total stores
                    </Text>
                  </InlineStack>
                  <Badge tone="highlight">
                    {localStores.length > 0
                      ? `${((paidSubscribersCount / localStores.length) * 100).toFixed(0)}% Conversion`
                      : "0% Conversion"}
                  </Badge>
                </BlockStack>
                <Text variant="bodyXs" tone="subdued">
                  {localPlanCounts.enterprise || 0} Enterprise • {localPlanCounts.pro || 0} Pro • {localPlanCounts.growth || 0} Growth
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>

          {/* Card 4: Platform Avg Catalog Health */}
          <Grid.Cell columnSpan={{ xs: 12, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="bodySm" tone="subdued" fontWeight="bold">
                    Avg Catalog Health
                  </Text>
                  <Box padding="200" borderRadius="200" background="bg-surface-secondary">
                    <Icon source={CheckCircleIcon} tone="success" />
                  </Box>
                </InlineStack>
                <BlockStack gap="050">
                  <Text variant="heading2xl" as="p" fontWeight="bold" tone={getHealthTone(avgPlatformHealth)}>
                    {avgPlatformHealth.toFixed(1)}%
                  </Text>
                  <Badge tone={getHealthTone(avgPlatformHealth)}>
                    {avgPlatformHealth >= 85 ? "Healthy Platform" : "Needs Attention"}
                  </Badge>
                </BlockStack>
                <Text variant="bodyXs" tone="subdued">
                  Monitored across {totalProductsMonitored.toLocaleString()} total products
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>
        </Grid>

        {/* Main Nav Tabs Card Container */}
        <Card padding="0">
          <Tabs
            tabs={mainTabs}
            selected={activeMainTab}
            onSelect={(index) => setActiveMainTab(index)}
          />
          <Box padding="500">
            {/* TAB 0: MERCHANT DIRECTORY CONTROL CENTER */}
            {activeMainTab === 0 && (
              <BlockStack gap="500">
                {/* Toolbar & Filters */}
                <Box padding="400" background="bg-surface-secondary" borderRadius="300">
                  <BlockStack gap="300">
                    <Grid>
                      <Grid.Cell columnSpan={{ xs: 12, sm: 12, md: 6, lg: 6, xl: 6 }}>
                        <TextField
                          label="Search Merchants"
                          labelHidden
                          placeholder="Search merchant shop domain or admin email..."
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
                            { label: "All Subscription Plans", value: "all" },
                            { label: "Starter Free ($0)", value: "free" },
                            { label: "Growth Plan ($4.99)", value: "growth" },
                            { label: "Pro Advanced ($9.99)", value: "pro" },
                            { label: "Plus Enterprise ($19.99)", value: "enterprise" },
                          ]}
                          value={planFilter}
                          onChange={setPlanFilter}
                        />
                      </Grid.Cell>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
                        <Select
                          label="Filter by Health & Offers"
                          labelHidden
                          options={[
                            { label: "All Health & Offer Types", value: "all" },
                            { label: "Healthy (≥85%)", value: "healthy" },
                            { label: "Needs Review (<85%)", value: "review" },
                            { label: "With Active Special Offers", value: "offers" },
                          ]}
                          value={healthFilter}
                          onChange={setHealthFilter}
                        />
                      </Grid.Cell>
                    </Grid>

                    {/* Quick Filter Tag Buttons */}
                    <InlineStack align="space-between" blockAlign="center">
                      <InlineStack gap="200" blockAlign="center">
                        <Text variant="bodySm" tone="subdued" fontWeight="bold">
                          Quick Presets:
                        </Text>
                        <Button
                          size="micro"
                          variant={planFilter === "all" && healthFilter === "all" ? "primary" : "secondary"}
                          onClick={() => {
                            setPlanFilter("all");
                            setHealthFilter("all");
                          }}
                        >
                          All ({localStores.length})
                        </Button>
                        <Button
                          size="micro"
                          variant={planFilter === "growth" || planFilter === "pro" || planFilter === "enterprise" ? "primary" : "secondary"}
                          onClick={() => setPlanFilter("growth")}
                        >
                          Paid Plans
                        </Button>
                        <Button
                          size="micro"
                          variant={healthFilter === "review" ? "primary" : "secondary"}
                          onClick={() => setHealthFilter("review")}
                        >
                          Needs Review (&lt;85%)
                        </Button>
                      </InlineStack>

                      {(searchQuery || planFilter !== "all" || healthFilter !== "all") && (
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
                      )}
                    </InlineStack>
                  </BlockStack>
                </Box>

                {/* Inline Expanded Merchant Inspection & Control Panel Card */}
                {expandedStore && (
                  <Box
                    padding="500"
                    borderRadius="400"
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
                            Store Inspection & Plan Controls — {expandedStore.shopDomain}
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

                      {/* Interactive Plan Switcher Hub */}
                      <Card padding="400">
                        <BlockStack gap="300">
                          <Text variant="headingSm" as="h4" fontWeight="bold">
                            Quick Plan Upgrade / Downgrade Switcher
                          </Text>
                          <Text variant="bodySm" tone="subdued">
                            Click any tier below to immediately update this merchant store's subscription plan:
                          </Text>
                          <InlineStack gap="300" wrap>
                            {[
                              { id: "free", name: "Starter Free", price: "$0/mo" },
                              { id: "growth", name: "Growth Plan", price: "$4.99/mo" },
                              { id: "pro", name: "Pro Advanced", price: "$9.99/mo" },
                              { id: "enterprise", name: "Plus Enterprise", price: "$19.99/mo" },
                            ].map((tier) => {
                              const isActive = expandedStore.planId === tier.id;
                              return (
                                <Button
                                  key={tier.id}
                                  variant={isActive ? "primary" : "secondary"}
                                  onClick={() => handleUpdateStorePlan(expandedStore.id, tier.id)}
                                  disabled={isActive}
                                >
                                  {isActive ? `${tier.name} (${tier.price}) - ACTIVE` : `Switch to ${tier.name} (${tier.price})`}
                                </Button>
                              );
                            })}
                          </InlineStack>
                        </BlockStack>
                      </Card>

                      {/* Merchant-Specific Promotional Offer & Trial Override Card */}
                      <Card padding="400">
                        <BlockStack gap="300">
                          <InlineStack align="space-between" blockAlign="center">
                            <BlockStack gap="050">
                              <Text variant="headingSm" as="h4" fontWeight="bold">
                                Merchant-Specific Special Offers & Custom Promotions
                              </Text>
                              <Text variant="bodySm" tone="subdued">
                                Assign individual merchant deals (e.g. 2 Months Free Pro for First 20 Users, 3 Months Free Trial, or Custom Discounts).
                              </Text>
                            </BlockStack>
                            {expandedStore.offerTag && (
                              <Badge tone="warning">
                                {`ACTIVE PROMO: ${expandedStore.offerTag}`}
                              </Badge>
                            )}
                          </InlineStack>

                          <Divider />

                          <Text variant="bodySm" fontWeight="bold">
                            Quick Merchant Offer Presets:
                          </Text>
                          <InlineStack gap="200" wrap>
                            <Button
                              variant="secondary"
                              onClick={() => handleUpdateStoreOffer(expandedStore.id, "2 Months Free Pro", "pro")}
                            >
                              First 20 Users: 2 Months Free Pro
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => handleUpdateStoreOffer(expandedStore.id, "3 Months Free Pro", "pro")}
                            >
                              Early Adopter: 3 Months Free Pro
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => handleUpdateStoreOffer(expandedStore.id, "3 Months Free Access", "growth")}
                            >
                              Trial Extension: 3 Months Free Access
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => handleUpdateStoreOffer(expandedStore.id, "50% VIP Merchant Offer")}
                            >
                              50% VIP Merchant Offer
                            </Button>
                            {expandedStore.offerTag && (
                              <Button
                                tone="critical"
                                variant="tertiary"
                                onClick={() => handleUpdateStoreOffer(expandedStore.id, "")}
                              >
                                Clear Active Special Offer
                              </Button>
                            )}
                          </InlineStack>
                        </BlockStack>
                      </Card>

                      {/* Store Metrics Summary Grid */}
                      <Grid>
                        <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
                          <BlockStack gap="100">
                            <Text variant="bodySm" tone="subdued">
                              Database Store ID
                            </Text>
                            <Text variant="bodySm" fontWeight="bold">
                              <code>{expandedStore.id}</code>
                            </Text>
                          </BlockStack>
                        </Grid.Cell>
                        <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
                          <BlockStack gap="100">
                            <Text variant="bodySm" tone="subdued">
                              Installation Date
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
                              {(expandedStore._count?.products || 0).toLocaleString()} Products
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
                    <BlockStack align="center" inlineAlign="center" gap="300">
                      <Icon source={StoreIcon} tone="subdued" />
                      <Text variant="headingSm">No merchant stores found</Text>
                      <Text variant="bodySm" tone="subdued">
                        Try modifying your search query or resetting active plan & health filters.
                      </Text>
                    </BlockStack>
                  </Box>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "numeric", "text", "text", "text"]}
                    headings={[
                      "Merchant Store",
                      "Subscription Plan",
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

            {/* TAB 1: SUBSCRIPTION TIERS & ANNUAL DISCOUNT CONFIG */}
            {activeMainTab === 1 && (
              <BlockStack gap="500">
                {/* Admin Yearly Discount Config Card */}
                <Card padding="500">
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Icon source={CashDollarIcon} tone="success" />
                          <Text variant="headingMd" as="h3" fontWeight="bold">
                            Annual Subscription Discount Manager
                          </Text>
                        </InlineStack>
                        <Text variant="bodySm" tone="subdued">
                          Configure a dynamic percentage discount for yearly subscription plans. Updates apply instantly across the merchant plans portal.
                        </Text>
                      </BlockStack>
                      <Badge tone="success" size="large">{`${Number(yearlyDiscountInput) || 0}% OFF ACTIVE`}</Badge>
                    </InlineStack>

                    <Divider />

                    {/* Presets & Custom Input 2-Column Form Grid */}
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData();
                        fd.append("actionType", "UPDATE_YEARLY_DISCOUNT");
                        fd.append("discountPercentage", yearlyDiscountInput);
                        discountFetcher.submit(fd, { method: "post" });
                      }}
                    >
                      <Grid gap={{ xs: "400", sm: "400", md: "400", lg: "400", xl: "400" }}>
                        {/* Left Column: Quick Presets Picker */}
                        <Grid.Cell columnSpan={{ xs: 12, sm: 6, md: 6, lg: 6, xl: 6 }}>
                          <Box padding="400" background="bg-surface-secondary" borderRadius="300" style={{ height: "100%" }}>
                            <BlockStack gap="300">
                              <Text variant="headingSm" as="h4" fontWeight="bold">
                                1. Quick Discount Presets
                              </Text>
                              <Text variant="bodySm" tone="subdued">
                                Click any standard percentage to quickly populate the discount rate:
                              </Text>
                              <InlineStack gap="200" wrap align="start">
                                {[10, 15, 17, 20, 25, 30].map((preset) => {
                                  const isSelected = Number(yearlyDiscountInput) === preset;
                                  return (
                                    <Button
                                      key={preset}
                                      variant={isSelected ? "primary" : "secondary"}
                                      size="medium"
                                      onClick={() => setYearlyDiscountInput(preset)}
                                    >
                                      {preset === 17 ? "17% OFF" : `${preset}% OFF`}
                                    </Button>
                                  );
                                })}
                              </InlineStack>
                            </BlockStack>
                          </Box>
                        </Grid.Cell>

                        {/* Right Column: Custom Percentage & Save Action */}
                        <Grid.Cell columnSpan={{ xs: 12, sm: 6, md: 6, lg: 6, xl: 6 }}>
                          <Box padding="400" background="bg-surface-secondary" borderRadius="300" style={{ height: "100%" }}>
                            <BlockStack gap="300">
                              <Text variant="headingSm" as="h4" fontWeight="bold">
                                2. Custom Percentage & Save
                              </Text>
                              <BlockStack gap="300">
                                <TextField
                                  label="Discount Percentage (%)"
                                  type="number"
                                  min={0}
                                  max={100}
                                  step={0.1}
                                  suffix="%"
                                  placeholder="Enter percentage e.g. 17"
                                  value={String(yearlyDiscountInput !== undefined && yearlyDiscountInput !== null ? yearlyDiscountInput : "")}
                                  onChange={(val) => setYearlyDiscountInput(val)}
                                  helpText="Type any custom rate (e.g. 17 or 17.5). Updates preview live below."
                                  autoComplete="off"
                                />
                                <Button
                                  submit
                                  variant="primary"
                                  size="large"
                                  fullWidth
                                  loading={discountFetcher.state !== "idle"}
                                >
                                  Save Discount Configuration ({Number(yearlyDiscountInput) || 0}% OFF)
                                </Button>
                              </BlockStack>
                            </BlockStack>
                          </Box>
                        </Grid.Cell>
                      </Grid>
                    </form>
                  </BlockStack>
                </Card>

                {/* Annual Savings Calculator Preview Grid */}
                <Card padding="500">
                  <BlockStack gap="400">
                    <Text variant="headingMd" as="h3" fontWeight="bold">
                      Live Annual Price & Merchant Savings Preview ({Number(yearlyDiscountInput) || 0}% OFF)
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Below is how merchant pricing and annual savings will be presented across the application:
                    </Text>

                    <Grid>
                      {[
                        { id: "growth", name: "Growth Plan", monthly: 4.99 },
                        { id: "pro", name: "Pro Advanced", monthly: 9.99 },
                        { id: "enterprise", name: "Plus Enterprise", monthly: 19.99 },
                      ].map((plan) => {
                        const yearlyInfo = calculateYearlyPricing(
                          plan.monthly,
                          Number(yearlyDiscountInput) || 0
                        );
                        return (
                          <Grid.Cell key={plan.id} columnSpan={{ xs: 12, sm: 4, md: 4, lg: 4, xl: 4 }}>
                            <Box
                              padding="400"
                              borderRadius="300"
                              background="bg-surface-secondary"
                              style={{ border: "1px solid var(--p-color-border-subdued)" }}
                            >
                              <BlockStack gap="200">
                                <InlineStack align="space-between" blockAlign="center">
                                  <Text variant="headingSm" as="h4" fontWeight="bold">
                                    {plan.name}
                                  </Text>
                                  <Badge tone="success">{`${yearlyDiscountInput}% OFF`}</Badge>
                                </InlineStack>
                                <Text variant="bodyXs" tone="subdued">
                                  Monthly Billed: ${plan.monthly}/mo (${(plan.monthly * 12).toFixed(2)}/yr)
                                </Text>
                                <Divider />
                                <BlockStack gap="050">
                                  <Text variant="headingLg" as="p" fontWeight="bold" tone="success">
                                    {yearlyInfo.monthlyEquivalentFormatted}/mo
                                  </Text>
                                  <Text variant="bodySm" tone="subdued">
                                    Billed annually at <strong>{yearlyInfo.yearlyTotalFormatted}/yr</strong>
                                  </Text>
                                  <Text variant="bodyXs" tone="success" fontWeight="bold">
                                    Merchant Saves: {yearlyInfo.savingsLabel}
                                  </Text>
                                </BlockStack>
                              </BlockStack>
                            </Box>
                          </Grid.Cell>
                        );
                      })}
                    </Grid>
                  </BlockStack>
                </Card>
              </BlockStack>
            )}

            {/* TAB 2: PLATFORM OVERVIEW & PLAN ANALYTICS */}
            {activeMainTab === 2 && (
              <BlockStack gap="500">
                <Grid>
                  <Grid.Cell columnSpan={{ xs: 12, sm: 6, md: 6, lg: 6, xl: 6 }}>
                    <Card padding="500">
                      <BlockStack gap="300">
                        <Text variant="headingMd" as="h3" fontWeight="bold">
                          Subscriber Tier Distribution
                        </Text>
                        <Text variant="bodySm" tone="subdued">
                          Breakdown of merchants across subscription tiers:
                        </Text>

                        <Divider />

                        <BlockStack gap="200">
                          {[
                            { name: "Starter Free", count: localPlanCounts.free || 0, price: "$0/mo", tone: "info" },
                            { name: "Growth Plan", count: localPlanCounts.growth || 0, price: "$4.99/mo", tone: "highlight" },
                            { name: "Pro Advanced", count: localPlanCounts.pro || 0, price: "$9.99/mo", tone: "attention" },
                            { name: "Plus Enterprise", count: localPlanCounts.enterprise || 0, price: "$19.99/mo", tone: "success" },
                          ].map((item) => (
                            <Box
                              key={item.name}
                              padding="300"
                              borderRadius="200"
                              background="bg-surface-secondary"
                            >
                              <InlineStack align="space-between" blockAlign="center">
                                <InlineStack gap="200" blockAlign="center">
                                  <Badge tone={item.tone}>{item.name}</Badge>
                                  <Text variant="bodySm" tone="subdued">
                                    ({item.price})
                                  </Text>
                                </InlineStack>
                                <Text variant="bodyMd" fontWeight="bold">
                                  {item.count} merchant(s)
                                </Text>
                              </InlineStack>
                            </Box>
                          ))}
                        </BlockStack>
                      </BlockStack>
                    </Card>
                  </Grid.Cell>

                  <Grid.Cell columnSpan={{ xs: 12, sm: 6, md: 6, lg: 6, xl: 6 }}>
                    <Card padding="500">
                      <BlockStack gap="300">
                        <Text variant="headingMd" as="h3" fontWeight="bold">
                          Platform Health Summary
                        </Text>
                        <Text variant="bodySm" tone="subdued">
                          Overall catalog audit performance across monitored shops:
                        </Text>

                        <Divider />

                        <BlockStack gap="300">
                          <Box padding="400" borderRadius="300" background="bg-surface-secondary">
                            <BlockStack gap="200">
                              <InlineStack align="space-between" blockAlign="center">
                                <Text variant="bodySm" fontWeight="bold">
                                  Average Platform Health Score
                                </Text>
                                <Badge tone={getHealthTone(avgPlatformHealth)}>
                                  {avgPlatformHealth >= 85 ? "EXCELLENT" : "NEEDS REVIEW"}
                                </Badge>
                              </InlineStack>
                              <ProgressBar progress={avgPlatformHealth} tone={getHealthTone(avgPlatformHealth)} />
                              <Text variant="headingXl" as="p" fontWeight="bold">
                                {avgPlatformHealth.toFixed(1)}%
                              </Text>
                            </BlockStack>
                          </Box>

                          <Grid>
                            <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                              <Box padding="300" borderRadius="200" background="bg-surface-success-subdued">
                                <BlockStack gap="050">
                                  <Text variant="bodyXs" tone="success" fontWeight="bold">
                                    TOTAL MONITORED PRODUCTS
                                  </Text>
                                  <Text variant="headingLg" as="p" fontWeight="bold">
                                    {totalProductsMonitored.toLocaleString()}
                                  </Text>
                                </BlockStack>
                              </Box>
                            </Grid.Cell>
                            <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                              <Box padding="300" borderRadius="200" background="bg-surface-caution-subdued">
                                <BlockStack gap="050">
                                  <Text variant="bodyXs" tone="highlight" fontWeight="bold">
                                    ANNUAL REVENUE RUN-RATE
                                  </Text>
                                  <Text variant="headingLg" as="p" fontWeight="bold">
                                    ${(localEstimatedMRR * 12).toFixed(2)}
                                  </Text>
                                </BlockStack>
                              </Box>
                            </Grid.Cell>
                          </Grid>
                        </BlockStack>
                      </BlockStack>
                    </Card>
                  </Grid.Cell>
                </Grid>
              </BlockStack>
            )}
          </Box>
        </Card>
      </BlockStack>
    </Page>
  );
}


