/* global process */
import { useState } from "react";
import { Form, useLoaderData, useActionData, useNavigation } from "react-router";
import {
  Page,
  Card,
  Text,
  Button,
  InlineStack,
  BlockStack,
  Badge,
  Box,
  Divider,
  Banner,
  Grid,
} from "@shopify/polaris";
import { calculateYearlyPricing } from "../services/planConfig.js";

export const loader = async ({ request }) => {
  const { authenticate, MONTHLY_GROWTH, MONTHLY_PRO, MONTHLY_ENTERPRISE, YEARLY_GROWTH, YEARLY_PRO, YEARLY_ENTERPRISE } = await import("../shopify.server.js");
  const { ensureStoreRecord } = await import("../services/syncEngine.server.js");
  const { normalizePlanId } = await import("../services/planEngine.server.js");
  const { getYearlyDiscountPercentage } = await import("../services/settingsEngine.server.js");
  const { default: prisma } = await import("../db.server.js");

  const adminEmailEnv = process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com";
  const adminShopPrefix = process.env.ADMIN_STORE_NAME || "quickstart-749ac396";

  const { session, billing } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);

  const shopDomain = session.shop.toLowerCase();
  const adminEmail = (store.adminEmail || "").toLowerCase();
  const isAdmin =
    shopDomain.includes(adminShopPrefix.toLowerCase()) ||
    adminEmail === adminEmailEnv.toLowerCase();

  const yearlyDiscountPercent = await getYearlyDiscountPercentage();

  // Check active Shopify App Subscription if available
  try {
    const { hasActivePayment, appSubscriptions } = await billing.check({
      plans: [MONTHLY_GROWTH, MONTHLY_PRO, MONTHLY_ENTERPRISE, YEARLY_GROWTH, YEARLY_PRO, YEARLY_ENTERPRISE],
    });

    if (hasActivePayment && appSubscriptions && appSubscriptions.length > 0) {
      const activeSub = appSubscriptions[0];
      let matchedPlan = "free";
      let matchedInterval = "monthly";

      const subName = activeSub.name || "";
      if (subName.includes("Growth")) matchedPlan = "growth";
      else if (subName.includes("Pro")) matchedPlan = "pro";
      else if (subName.includes("Enterprise")) matchedPlan = "enterprise";

      if (subName.includes("Annual")) matchedInterval = "yearly";

      if (store.plan !== matchedPlan || store.billingInterval !== matchedInterval) {
        await prisma.store.update({
          where: { id: store.id },
          data: { plan: matchedPlan, billingInterval: matchedInterval },
        });
        store.plan = matchedPlan;
        store.billingInterval = matchedInterval;
      }
    }
  } catch {
    // Graceful fallback if billing check is unsupported in dev environment
  }

  // Handle return redirect approval parameter
  const url = new URL(request.url);
  if (url.searchParams.get("approved") === "true") {
    const approvedPlan = normalizePlanId(url.searchParams.get("plan"));
    const approvedInterval = url.searchParams.get("interval") === "yearly" ? "yearly" : "monthly";
    if (approvedPlan) {
      await prisma.store.update({
        where: { id: store.id },
        data: { plan: approvedPlan, billingInterval: approvedInterval },
      });
      store.plan = approvedPlan;
      store.billingInterval = approvedInterval;
    }
  }

  return {
    store,
    currentPlanId: normalizePlanId(store.plan) || "free",
    currentBillingInterval: store.billingInterval || "monthly",
    isAdmin,
    yearlyDiscountPercent,
  };
};

export const action = async ({ request }) => {
  const {
    authenticate,
    MONTHLY_GROWTH,
    MONTHLY_PRO,
    MONTHLY_ENTERPRISE,
    YEARLY_GROWTH,
    YEARLY_PRO,
    YEARLY_ENTERPRISE,
  } = await import("../shopify.server.js");
  const { ensureStoreRecord } = await import("../services/syncEngine.server.js");
  const { PLAN_CONFIG, PLAN_IDS, normalizePlanId } = await import("../services/planEngine.server.js");
  const { default: prisma } = await import("../db.server.js");

  const { session, billing } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "SELECT_PLAN") {
    const selectedPlan = normalizePlanId(formData.get("plan"));
    const selectedInterval = formData.get("billingInterval") === "yearly" ? "yearly" : "monthly";

    if (!selectedPlan) {
      return {
        success: false,
        error: `Unknown plan. Choose one of: ${PLAN_IDS.join(", ")}.`,
      };
    }

    const BILLING_MAP = {
      growth: { monthly: MONTHLY_GROWTH, yearly: YEARLY_GROWTH },
      pro: { monthly: MONTHLY_PRO, yearly: YEARLY_PRO },
      enterprise: { monthly: MONTHLY_ENTERPRISE, yearly: YEARLY_ENTERPRISE },
    };

    if (selectedPlan !== "free" && BILLING_MAP[selectedPlan]?.[selectedInterval]) {
      const billingPlanName = BILLING_MAP[selectedPlan][selectedInterval];
      try {
        const isTest = process.env.NODE_ENV !== "production" || session.shop.includes("myshopify.com");
        const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST || "http://localhost:3000";
        const returnUrl = `${appUrl}/app/plans?approved=true&plan=${selectedPlan}&interval=${selectedInterval}`;

        return await billing.request({
          plan: billingPlanName,
          isTest,
          returnUrl,
        });
      } catch (err) {
        // Rethrow Response objects so React Router can process the redirect to Shopify Admin Approval page
        if (err instanceof Response || (err && typeof err === "object" && ("status" in err || "headers" in err))) {
          throw err;
        }
        console.warn("[Billing] Shopify billing API request failed, falling back to local store update:", err?.message || err);
      }
    }

    // Direct fallback or Free tier selection
    await prisma.store.update({
      where: { id: store.id },
      data: {
        plan: selectedPlan,
        billingInterval: selectedInterval,
      },
    });

    const intervalText = selectedInterval === "yearly" ? "Annual / Yearly Billed" : "Monthly Billed";

    return {
      success: true,
      message: `Successfully subscribed to the ${PLAN_CONFIG[selectedPlan].name} plan (${intervalText})!`,
    };
  }

  return { success: false };
};

export default function Plans() {
  const { currentPlanId, currentBillingInterval, yearlyDiscountPercent } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const [billingInterval, setBillingInterval] = useState(currentBillingInterval || "monthly");

  const plans = [
    {
      id: "free",
      name: "Starter Free",
      priceAmount: 0,
      price: "$0",
      period: "/month",
      badge: "STARTER",
      badgeTone: "info",
      isPopular: false,
      description: "Essential catalog quality checks for small stores.",
      features: [
        "Audit up to 50 products",
        "Basic Missing SKU & Price checks",
        "Weekly manual catalog scan",
        "Standard Dashboard Metrics",
        "Community Support (48h SLA)",
      ],
    },
    {
      id: "growth",
      name: "Growth",
      priceAmount: 9.99,
      price: "$9.99",
      period: "/month",
      badge: "RECOMMENDED",
      badgeTone: "info",
      isPopular: false,
      description: "Automated daily audits & alerts for growing inventory.",
      features: [
        "Audit up to 1,000 products",
        "14-Day Free Trial included",
        "Automated Daily Catalog Scans",
        "Missing Image & Zero-Price Detection",
        "Duplicate SKU Detection Engine",
        "Email Alert Notifications",
        "Priority Support (24h SLA)",
      ],
    },
    {
      id: "pro",
      name: "Pro Advanced",
      priceAmount: 24.99,
      price: "$24.99",
      period: "/month",
      badge: "MOST POPULAR",
      badgeTone: "highlight",
      isPopular: true,
      description: "Real-time webhook scanning & custom rule engine.",
      features: [
        "Audit up to 10,000 products",
        "14-Day Free Trial included",
        "Real-time Webhook Instant Scans",
        "Required Metafield Audit with Smart Defaults",
        "Custom Validation Rule Builder",
        "Instant Critical Email Alerts",
        "Priority Support (4h SLA)",
      ],
    },
    {
      id: "enterprise",
      name: "Plus Enterprise",
      priceAmount: 49.99,
      price: "$49.99",
      period: "/month",
      badge: "UNLIMITED",
      badgeTone: "success",
      isPopular: false,
      description: "Full automation, auto-fix engine & VIP SLA.",
      features: [
        "Unlimited Product Audits",
        "14-Day Free Trial included",
        "Smart & Custom Metafield Auto-Fix Engine",
        "Multi-Location Catalog Sync",
        "Unlimited Webhook & On-Demand Scans",
        "Custom Dedicated Rule Engineering",
        "VIP 1-on-1 Admin Support (1h SLA)",
      ],
    },
  ];

  const featureMatrix = [
    {
      category: "Audit Allowance & Scanning",
      rows: [
        { feature: "Product Audit Capacity", free: "50 products", growth: "1,000 products", pro: "10,000 products", enterprise: "Unlimited" },
        { feature: "Scan Automation", free: "Weekly Manual", growth: "Daily Automated", pro: "Real-time Webhook", enterprise: "Instant Webhook & On-Demand" },
        { feature: "On-Demand Manual Audits", free: "1 / week", growth: "7 / week", pro: "30 / week", enterprise: "Unlimited" },
      ],
    },
    {
      category: "Health Checks & Rules",
      rows: [
        { feature: "Missing SKU & Zero-Price Detection", free: "✓", growth: "✓", pro: "✓", enterprise: "✓" },
        { feature: "Missing Image & Variant Checks", free: "Basic", growth: "✓", pro: "✓", enterprise: "✓" },
        { feature: "Duplicate SKU Detection Engine", free: "-", growth: "✓", pro: "✓", enterprise: "✓" },
        { feature: "Required Metafield Audit with Smart Defaults", free: "-", growth: "-", pro: "✓", enterprise: "✓" },
        { feature: "Custom Rule Builder Engine", free: "-", growth: "-", pro: "✓", enterprise: "✓" },
      ],
    },
    {
      category: "Automation & Resolution",
      rows: [
        { feature: "Smart & Custom Metafield Auto-Fix Engine", free: "-", growth: "-", pro: "-", enterprise: "✓" },
        { feature: "Multi-Location Inventory Sync", free: "-", growth: "-", pro: "-", enterprise: "✓" },
        { feature: "Instant Email Alert Dispatch", free: "-", growth: "✓", pro: "✓", enterprise: "✓" },
      ],
    },
    {
      category: "Support & SLA",
      rows: [
        { feature: "Guaranteed Response SLA", free: "48 Hours", growth: "24 Hours", pro: "4 Hours", enterprise: "1 Hour VIP" },
        { feature: "Support Channel", free: "Community", growth: "Email", pro: "Priority Email", enterprise: "VIP 1-on-1 Admin" },
      ],
    },
  ];

  return (
    <Page
      fullWidth
      title="Subscription Plans & Feature Matrix"
      subtitle="Select a plan tier suited for your store catalog size and automation requirements"
    >
      <Box paddingBlockEnd="1000">
        <BlockStack gap="500">
          {actionData?.error && (
            <Banner tone="critical" title="Plan Change Failed">
              <p>{actionData.error}</p>
            </Banner>
          )}

          {actionData?.success && actionData?.message && (
            <Banner tone="success" title="Plan Updated">
              <p>{actionData.message}</p>
            </Banner>
          )}

          {/* Current Plan Overview Card */}
          <Card padding="500">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text variant="headingSm" as="h3" fontWeight="bold">
                  Current Active Subscription
                </Text>
                <Text variant="bodySm" tone="subdued">
                  Your store is currently subscribed to the <strong>{(currentPlanId || "free").toUpperCase()}</strong> plan ({currentPlanId === "free" ? "FREE TIER" : `${(currentBillingInterval || "monthly").toUpperCase()} BILLING`}).
                </Text>
              </BlockStack>
              <Badge tone="success">
                {currentPlanId === "free"
                  ? "Active Plan: FREE"
                  : `Active: ${(currentPlanId || "free").toUpperCase()} (${(currentBillingInterval || "monthly").toUpperCase()})`}
              </Badge>
            </InlineStack>
          </Card>

          {/* Billing Frequency Switcher Toolbar */}
          <Box padding="400" borderRadius="300" background="bg-surface-secondary">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="050">
                <Text variant="headingSm" as="h4" fontWeight="bold">
                  Billing Cycle Options
                </Text>
                <Text variant="bodySm" tone="subdued">
                  Save up to <strong>{yearlyDiscountPercent}% OFF</strong> with annual billing
                </Text>
              </BlockStack>
              <InlineStack gap="200">
                <button
                  type="button"
                  onClick={() => setBillingInterval("monthly")}
                  style={{
                    cursor: "pointer",
                    padding: "8px 16px",
                    fontSize: "13px",
                    fontWeight: "600",
                    borderRadius: "8px",
                    border: billingInterval === "monthly" ? "2px solid #008060" : "1px solid #c9cccf",
                    backgroundColor: billingInterval === "monthly" ? "#008060" : "#ffffff",
                    color: billingInterval === "monthly" ? "#ffffff" : "#202223",
                    boxShadow: "0 1px 0 rgba(0,0,0,0.05)",
                    transition: "all 0.15s ease-in-out",
                  }}
                >
                  Monthly Billing
                </button>

                <button
                  type="button"
                  onClick={() => setBillingInterval("yearly")}
                  style={{
                    cursor: "pointer",
                    padding: "8px 16px",
                    fontSize: "13px",
                    fontWeight: "600",
                    borderRadius: "8px",
                    border: billingInterval === "yearly" ? "2px solid #008060" : "1px solid #c9cccf",
                    backgroundColor: billingInterval === "yearly" ? "#008060" : "#ffffff",
                    color: billingInterval === "yearly" ? "#ffffff" : "#202223",
                    boxShadow: "0 1px 0 rgba(0,0,0,0.05)",
                    transition: "all 0.15s ease-in-out",
                  }}
                >
                  Yearly Billing ({yearlyDiscountPercent}% OFF)
                </button>
              </InlineStack>
            </InlineStack>
          </Box>

          {/* Pricing Cards Grid */}
          <Grid>
            {plans.map((plan) => {
              const isCurrent = currentPlanId === plan.id;
              const yearlyInfo = calculateYearlyPricing(plan.priceAmount, yearlyDiscountPercent);
              const isYearly = billingInterval === "yearly" && plan.priceAmount > 0;

              return (
                <Grid.Cell
                  key={plan.id}
                  columnSpan={{ xs: 12, sm: 6, md: 3, lg: 3, xl: 3 }}
                >
                  <div
                    style={{
                      height: "100%",
                      borderRadius: "12px",
                      border: isCurrent
                        ? "2px solid var(--p-color-border-success, #008060)"
                        : plan.isPopular
                          ? "2px solid var(--p-color-border-brand, #005bd3)"
                          : "1px solid var(--p-color-border, #e1e3e5)",
                      overflow: "hidden",
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    <Card padding="500">
                      <BlockStack gap="400">
                        {/* Card Header */}
                        <BlockStack gap="100">
                          <InlineStack align="space-between" blockAlign="center">
                            <Text variant="headingMd" as="h3" fontWeight="bold">
                              {plan.name}
                            </Text>
                            {isCurrent ? (
                              <Badge tone="success">ACTIVE</Badge>
                            ) : isYearly ? (
                              <Badge tone="success">{`${yearlyDiscountPercent}% OFF`}</Badge>
                            ) : (
                              <Badge tone={plan.badgeTone}>{plan.badge}</Badge>
                            )}
                          </InlineStack>

                          <Text variant="bodyXs" tone="subdued">
                            {plan.description}
                          </Text>
                        </BlockStack>

                        {/* Pricing Display */}
                        <BlockStack gap="050">
                          <InlineStack gap="100" align="baseline">
                            <Text variant="heading2xl" as="span" fontWeight="bold">
                              {isYearly ? yearlyInfo.monthlyEquivalentFormatted : plan.price}
                            </Text>
                            <Text variant="bodySm" tone="subdued" as="span">
                              {isYearly ? "/mo (billed annually)" : plan.period}
                            </Text>
                          </InlineStack>
                          {isYearly && (
                            <Text variant="bodyXs" tone="success" fontWeight="bold">
                              Total: {yearlyInfo.yearlyTotalFormatted}/yr ({yearlyInfo.savingsLabel})
                            </Text>
                          )}
                        </BlockStack>

                        <Divider />

                        {/* Feature List */}
                        <BlockStack gap="250">
                          <Text variant="bodyXs" tone="subdued" fontWeight="bold">
                            FEATURES INCLUDED:
                          </Text>

                          {plan.features.map((feat, idx) => (
                            <div
                              key={idx}
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                gap: "8px",
                              }}
                            >
                              <span
                                style={{
                                  color: "var(--p-color-text-success, #008060)",
                                  fontWeight: "bold",
                                  fontSize: "14px",
                                  lineHeight: "1.3",
                                  flexShrink: 0,
                                }}
                              >
                                ✓
                              </span>
                              <Text variant="bodySm" as="span">
                                {feat}
                              </Text>
                            </div>
                          ))}
                        </BlockStack>

                        <Box paddingBlockStart="300">
                          <Form method="post">
                            <input type="hidden" name="actionType" value="SELECT_PLAN" />
                            <input type="hidden" name="plan" value={plan.id} />
                            <input type="hidden" name="billingInterval" value={isYearly ? "yearly" : "monthly"} />
                            <Button
                              submit
                              fullWidth
                              size="large"
                              variant={isCurrent ? "secondary" : plan.isPopular ? "primary" : "secondary"}
                              disabled={isCurrent || isLoading}
                            >
                              {isCurrent
                                ? "Active Plan"
                                : plan.priceAmount === 0
                                  ? "Select Starter Free"
                                  : isYearly
                                    ? `Subscribe Yearly (${yearlyInfo.yearlyTotalFormatted}/yr)`
                                    : `Subscribe Monthly (${plan.price}/mo)`}
                            </Button>
                          </Form>
                        </Box>
                      </BlockStack>
                    </Card>
                  </div>
                </Grid.Cell>
              );
            })}
          </Grid>

          {/* Feature Comparison Matrix Table */}
          <Card padding="500">
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text variant="headingMd" as="h2" fontWeight="bold">
                  Detailed Feature Comparison Matrix
                </Text>
                <Text variant="bodySm" tone="subdued">
                  Compare plan capabilities side-by-side to choose the right monitoring tier for your business.
                </Text>
              </BlockStack>

              <Divider />

              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    textAlign: "left",
                    fontSize: "13px",
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: "2px solid var(--p-color-border, #e1e3e5)", background: "var(--p-color-bg-surface-secondary, #f6f6f7)" }}>
                      <th style={{ padding: "12px 16px", width: "32%" }}>Feature / Capability</th>
                      <th style={{ padding: "12px 16px", width: "17%" }}>Starter Free</th>
                      <th style={{ padding: "12px 16px", width: "17%" }}>
                        {billingInterval === "yearly"
                          ? `Growth (${calculateYearlyPricing(9.99, yearlyDiscountPercent).monthlyEquivalentFormatted}/mo)`
                          : "Growth ($9.99/mo)"}
                      </th>
                      <th style={{ padding: "12px 16px", width: "17%" }}>
                        {billingInterval === "yearly"
                          ? `Pro (${calculateYearlyPricing(24.99, yearlyDiscountPercent).monthlyEquivalentFormatted}/mo)`
                          : "Pro ($24.99/mo)"}
                      </th>
                      <th style={{ padding: "12px 16px", width: "17%" }}>
                        {billingInterval === "yearly"
                          ? `Enterprise (${calculateYearlyPricing(49.99, yearlyDiscountPercent).monthlyEquivalentFormatted}/mo)`
                          : "Enterprise ($49.99/mo)"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {featureMatrix.map((section, sIdx) => (
                      <>
                        <tr key={`sec-${sIdx}`} style={{ background: "var(--p-color-bg-surface-secondary, #f9fafb)" }}>
                          <td
                            colSpan={5}
                            style={{
                              padding: "10px 16px",
                              fontWeight: "bold",
                              color: "var(--p-color-text-subdued, #6d7175)",
                              fontSize: "12px",
                              textTransform: "uppercase",
                              letterSpacing: "0.5px",
                            }}
                          >
                            {section.category}
                          </td>
                        </tr>
                        {section.rows.map((r, rIdx) => (
                          <tr
                            key={`row-${sIdx}-${rIdx}`}
                            style={{
                              borderBottom: "1px solid var(--p-color-border-subdued, #f1f2f3)",
                            }}
                          >
                            <td style={{ padding: "12px 16px", fontWeight: "500" }}>{r.feature}</td>
                            <td style={{ padding: "12px 16px", color: r.free === "✓" ? "#008060" : "inherit" }}>
                              {r.free === "✓" ? <strong>✓</strong> : r.free}
                            </td>
                            <td style={{ padding: "12px 16px", color: r.growth === "✓" ? "#008060" : "inherit" }}>
                              {r.growth === "✓" ? <strong>✓</strong> : r.growth}
                            </td>
                            <td style={{ padding: "12px 16px", color: r.pro === "✓" ? "#008060" : "inherit" }}>
                              {r.pro === "✓" ? <strong>✓</strong> : r.pro}
                            </td>
                            <td style={{ padding: "12px 16px", color: r.enterprise === "✓" ? "#008060" : "inherit", fontWeight: r.enterprise === "✓" ? "bold" : "regular" }}>
                              {r.enterprise === "✓" ? <strong>✓</strong> : r.enterprise}
                            </td>
                          </tr>
                        ))}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            </BlockStack>
          </Card>
        </BlockStack>
      </Box>
    </Page>
  );
}
