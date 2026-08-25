/* global process */
import { useState, useRef, useEffect } from "react";
import { useLoaderData, useActionData, useSubmit, useNavigation, useFetcher } from "react-router";
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
  FormLayout,
  TextField,
  Select,
  Banner,
  Icon,
  Grid,
} from "@shopify/polaris";
import { CheckIcon, EmailIcon, SendIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord } from "../services/syncEngine.server.js";
import {
  PLAN_CONFIG,
  PLAN_IDS,
  normalizePlanId,
} from "../services/planEngine.server.js";

// Server-only read: this module is evaluated in the browser too, where
// `process` is undefined and a top-level read would break hydration.
const getAdminEmail = () => process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);

  return { store, adminEmail: getAdminEmail() };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "SELECT_PLAN") {
    // Only canonical plan ids reach the database: anything else is stored
    // verbatim and then reads back as the free tier on every feature check.
    const selectedPlan = normalizePlanId(formData.get("plan"));

    if (!selectedPlan) {
      return {
        success: false,
        error: `Unknown plan. Choose one of: ${PLAN_IDS.join(", ")}.`,
      };
    }

    await prisma.store.update({
      where: { id: store.id },
      data: { plan: selectedPlan },
    });

    return {
      success: true,
      message: `Successfully updated to the ${PLAN_CONFIG[selectedPlan].name} plan!`,
    };
  }

  if (actionType === "SUBMIT_SUPPORT_TICKET") {
    const subject = (formData.get("subject") || "").toString().trim();
    const message = (formData.get("message") || "").toString().trim();
    const merchantEmail = (formData.get("merchantEmail") || "").toString().trim() || getAdminEmail();

    if (subject && message) {
      const { createTicket } = await import("../services/supportEngine.server.js");
      const res = await createTicket({
        storeId: store.id,
        merchantEmail,
        subject,
        message,
        plan: store.plan,
      });

      if (!res.success) {
        return { success: false, error: res.error || "Failed to create support ticket." };
      }

      await prisma.store.update({
        where: { id: store.id },
        data: { adminEmail: merchantEmail },
      });

      return {
        success: true,
        message: `Support ticket sent to ${getAdminEmail()} successfully!`,
      };
    }
  }

  return { success: false, error: "Subject and detailed message are required." };
};

export default function PricingPlans() {
  const { store, adminEmail: ADMIN_EMAIL } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const supportFetcher = useFetcher();
  const isLoading = navigation.state !== "idle";
  const isSupportSubmitting = supportFetcher.state !== "idle";

  const supportFormRef = useRef(null);
  const subjectInputRef = useRef(null);

  const [supportCategory, setSupportCategory] = useState("Technical Support Query");
  const [customSubject, setCustomSubject] = useState("");
  const [supportMessage, setSupportMessage] = useState("");
  const [contactEmail, setContactEmail] = useState(store.adminEmail || ADMIN_EMAIL);
  const [feedbackBanner, setFeedbackBanner] = useState("");
  const [validationError, setValidationError] = useState("");

  const subjectOptions = [
    { label: "Technical Support Query", value: "Technical Support Query" },
    { label: "Custom Metafield Audit Rule Setup", value: "Custom Metafield Audit Rule Setup" },
    { label: "Billing & Subscription Plan Upgrade", value: "Billing & Subscription Plan Upgrade" },
    { label: "Auto-Fix Engine Assistance", value: "Auto-Fix Engine Assistance" },
    { label: "Feature Request / Feedback", value: "Feature Request / Feedback" },
    { label: "Other / Custom Topic", value: "Other / Custom Topic" },
  ];

  const handleSelectPlan = (planName) => {
    const formData = new FormData();
    formData.append("actionType", "SELECT_PLAN");
    formData.append("plan", planName);
    submit(formData, { method: "post" });
    setFeedbackBanner(`Switched to ${planName} Plan!`);
  };

  const handleOpenSupportForm = () => {
    setValidationError("");
    if (supportFormRef.current) {
      supportFormRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setTimeout(() => {
      if (subjectInputRef.current) {
        subjectInputRef.current.focus();
      }
    }, 150);
  };

  useEffect(() => {
    const res = supportFetcher.data || actionData;
    if (res?.success && (res?.message?.includes("Support ticket") || res?.message?.includes("sent") || res?.message?.includes("submitted"))) {
      setCustomSubject("");
      setSupportMessage("");
      setFeedbackBanner(res.message);
    }
  }, [supportFetcher.data, actionData]);

  const handleSendSupportTicket = (e) => {
    if (e && e.preventDefault) e.preventDefault();

    const finalSubject =
      supportCategory === "Other / Custom Topic"
        ? customSubject.trim()
        : supportCategory;

    if (!finalSubject || !supportMessage.trim()) {
      setValidationError("Please specify a Subject / Inquiry Topic and a Detailed Message.");
      return;
    }

    setValidationError("");
    const formData = new FormData();
    formData.append("actionType", "SUBMIT_SUPPORT_TICKET");
    formData.append("subject", finalSubject);
    formData.append("message", supportMessage.trim());
    formData.append("merchantEmail", contactEmail.trim());

    supportFetcher.submit(formData, { method: "post" });
  };

  const plans = [
    {
      id: "free",
      name: "Starter Free",
      price: "$0",
      period: "/month",
      badge: "Starter",
      badgeTone: "subdued",
      description: "Essential health checks for growing Shopify catalogs.",
      features: [
        "Audit up to 500 products",
        "Basic Missing SKU & Price checks",
        "Weekly manual catalog scan",
        "Standard Dashboard Metrics",
        "Community Support (2-3 days SLA)",
      ],
    },
    {
      id: "growth",
      name: "Growth Plan",
      price: "$4.99",
      period: "/month",
      badge: "Growing Stores",
      badgeTone: "info",
      description: "Automated daily catalog audits & duplicate SKU detection.",
      features: [
        "Audit up to 3,000 products",
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
      price: "$9.99",
      period: "/month",
      badge: "Most Popular",
      badgeTone: "highlight",
      description: "Real-time webhook monitoring & custom metafield compliance engine.",
      features: [
        "Audit up to 15,000 products",
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
      price: "$19.99",
      period: "/month",
      badge: "Unlimited",
      badgeTone: "success",
      description: "Auto-fix safety layer, multi-location inventory & VIP dedicated support.",
      features: [
        "Unlimited Product Audits",
        "Smart & Custom Metafield Auto-Fix Engine",
        "Multi-Location Catalog Sync",
        "Unlimited Webhook & On-Demand Scans",
        "Custom Dedicated Rule Engineering",
        "VIP 1-on-1 Admin Support (1h SLA)",
      ],
    },
  ];

  return (
    <Page
      title="Pricing Plans & Support"
      subtitle="Choose the right catalog monitoring plan for your store size & get instant merchant support"
      primaryAction={{
        content: "Contact Support",
        icon: EmailIcon,
        onClick: handleOpenSupportForm,
      }}
    >
      <BlockStack gap="5">
        {feedbackBanner && (
          <Banner tone="success" onDismiss={() => setFeedbackBanner("")}>
            <p>{feedbackBanner}</p>
          </Banner>
        )}

        {/* Pricing Cards Grid */}
        <Grid>
          {plans.map((plan) => {
            const isCurrentPlan = store.plan.toLowerCase() === plan.id;
            return (
              <Grid.Cell
                key={plan.id}
                columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}
              >
                <Card padding="500">
                  <BlockStack gap="4">
                    <InlineStack align="space-between">
                      <Text variant="headingLg" as="h3" fontWeight="bold">
                        {plan.name}
                      </Text>
                      <Badge tone={isCurrentPlan ? "success" : plan.badgeTone}>
                        {isCurrentPlan ? "Current Plan" : plan.badge}
                      </Badge>
                    </InlineStack>

                    <InlineStack gap="1" align="baseline">
                      <Text variant="heading2xl" as="span" fontWeight="bold">
                        {plan.price}
                      </Text>
                      <Text variant="bodyMd" tone="subdued">
                        {plan.period}
                      </Text>
                    </InlineStack>

                    <Text variant="bodySm" tone="subdued">
                      {plan.description}
                    </Text>

                    <Divider />

                    <BlockStack gap="2">
                      <Text variant="headingSm" as="h4">
                        Included Features:
                      </Text>
                      {plan.features.map((feat, idx) => (
                        <InlineStack key={idx} gap="2" align="start">
                          <Icon source={CheckIcon} tone="success" />
                          <Text variant="bodySm">{feat}</Text>
                        </InlineStack>
                      ))}
                    </BlockStack>

                    <Box paddingBlockStart="300">
                      <Button
                        fullWidth
                        variant={isCurrentPlan ? "secondary" : "primary"}
                        disabled={isCurrentPlan || isLoading}
                        onClick={() => handleSelectPlan(plan.name)}
                      >
                        {isCurrentPlan ? "Active Plan" : `Upgrade to ${plan.name}`}
                      </Button>
                    </Box>
                  </BlockStack>
                </Card>
              </Grid.Cell>
            );
          })}
        </Grid>

        {/* Support Section */}
        <Card padding="500">
          <BlockStack gap="4">
            <InlineStack align="space-between">
              <BlockStack gap="1">
                <Text variant="headingMd" as="h3">
                  Merchant Support & Escalations
                </Text>
                <Text variant="bodySm" tone="subdued">
                  Need help with rule configuration, custom audit setups, or billing inquiries? Contact app administrator directly.
                </Text>
              </BlockStack>
              <Button
                variant="primary"
                icon={EmailIcon}
                onClick={handleOpenSupportForm}
              >
                Submit Support Ticket
              </Button>
            </InlineStack>

            <Divider />

            <Grid>
              <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                <Card padding="400">
                  <BlockStack gap="2">
                    <Text variant="headingSm" as="h4">
                      Direct Email Support
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      App Lead: {ADMIN_EMAIL}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Managed Store Domain: {store.shopDomain}
                    </Text>
                  </BlockStack>
                </Card>
              </Grid.Cell>
              <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                <Card padding="400">
                  <BlockStack gap="2">
                    <Text variant="headingSm" as="h4">
                      Support SLA & Response Times
                    </Text>
                    <Text variant="bodySm">
                      Plus Enterprise: <strong>1 Hour VIP Response SLA</strong>
                    </Text>
                    <Text variant="bodySm">
                      Pro Advanced: <strong>4 Hours Priority Response SLA</strong>
                    </Text>
                    <Text variant="bodySm">
                      Growth Plan: <strong>Within 24 Hours Response SLA</strong>
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Starter Free: Within 2 to 3 business days
                    </Text>
                  </BlockStack>
                </Card>
              </Grid.Cell>
            </Grid>

            {/* Permanent Inline Support Form */}
            <div ref={supportFormRef}>
              <Box
                padding="500"
                borderRadius="300"
                background="bg-surface"
                shadow="300"
                style={{
                  border: "1.5px solid var(--p-color-border-brand, #008060)",
                  background: "linear-gradient(180deg, var(--p-color-bg-surface-success-subdued, #f1f8f5) 0%, var(--p-color-bg-surface, #ffffff) 100%)",
                }}
              >
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="200" blockAlign="center">
                      <Icon source={SendIcon} tone="success" />
                      <Text variant="headingMd" as="h4" fontWeight="bold">
                        Submit Support & Escalation Inquiry
                      </Text>
                    </InlineStack>
                    <Badge tone="success">Priority Queue</Badge>
                  </InlineStack>

                  {feedbackBanner && (
                    <Banner
                      tone="success"
                      title="Support Ticket Submitted Successfully!"
                      onDismiss={() => setFeedbackBanner("")}
                    >
                      <BlockStack gap="100">
                        <Text variant="bodyMd">{feedbackBanner}</Text>
                        <Text variant="bodySm" tone="subdued">
                          Our technical engineering team ({ADMIN_EMAIL}) has logged your request and will follow up at <strong>{contactEmail}</strong>.
                        </Text>
                      </BlockStack>
                    </Banner>
                  )}

                  {validationError && (
                    <Banner tone="critical" onDismiss={() => setValidationError("")}>
                      <p>{validationError}</p>
                    </Banner>
                  )}

                  <FormLayout>
                    <Grid>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                        <TextField
                          label="Your Contact Email"
                          value={contactEmail}
                          onChange={setContactEmail}
                          autoComplete="email"
                          helpText="Replies will be sent to this email address."
                        />
                      </Grid.Cell>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                        <Select
                          label="Subject / Inquiry Topic"
                          options={subjectOptions}
                          value={supportCategory}
                          onChange={(val) => {
                            setSupportCategory(val);
                            if (validationError) setValidationError("");
                          }}
                          helpText="Select topic category for faster routing."
                        />
                      </Grid.Cell>
                    </Grid>

                    {supportCategory === "Other / Custom Topic" && (
                      <TextField
                        ref={subjectInputRef}
                        label="Specify Custom Subject Topic"
                        value={customSubject}
                        onChange={(val) => {
                          setCustomSubject(val);
                          if (validationError) setValidationError("");
                        }}
                        placeholder="e.g. Question regarding custom API integration"
                        autoComplete="off"
                      />
                    )}
                    <TextField
                      label="Detailed Message / Issue Description"
                      value={supportMessage}
                      onChange={(val) => {
                        setSupportMessage(val);
                        if (validationError) setValidationError("");
                      }}
                      multiline={4}
                      placeholder="Describe your inquiry or request for the catalog health team..."
                      autoComplete="off"
                    />
                    <InlineStack align="end">
                      <Button
                        variant="primary"
                        size="large"
                        icon={SendIcon}
                        loading={isSupportSubmitting}
                        onClick={handleSendSupportTicket}
                      >
                        Submit Support Ticket
                      </Button>
                    </InlineStack>
                  </FormLayout>
                </BlockStack>
              </Box>
            </div>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
