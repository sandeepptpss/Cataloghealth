/* global process */
import { useState, useRef, useEffect } from "react";
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
  FormLayout,
  TextField,
  Select,
  Banner,
  Icon,
  Grid,
} from "@shopify/polaris";
import { CheckIcon, EmailIcon, ClockIcon, CheckCircleIcon, SendIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord } from "../services/syncEngine.server.js";
import {
  PLAN_CONFIG,
  PLAN_IDS,
  normalizePlanId,
} from "../services/planEngine.server.js";
import {
  addMerchantReply,
  createTicket,
  listStoreTickets,
  ticketSlaLabel,
} from "../services/supportEngine.server.js";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com";
const ADMIN_SHOP_PREFIX = process.env.ADMIN_STORE_NAME || "quickstart-749ac396";

// Value of the "write your own subject" option in the topic list.
export const CUSTOM_SUBJECT_OPTION = "Other / Custom Topic";

// Display names for the SLA line; the plan engine itself is server-only.
const PLAN_LABELS = {
  free: "Starter Free",
  growth: "Growth",
  pro: "Pro Advanced",
  enterprise: "Plus Enterprise",
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);

  const shopDomain = session.shop.toLowerCase();
  const adminEmail = (store.adminEmail || "").toLowerCase();
  const isAdmin =
    shopDomain.includes(ADMIN_SHOP_PREFIX.toLowerCase()) ||
    adminEmail === ADMIN_EMAIL.toLowerCase();

  const supportTickets = await listStoreTickets(store.id);

  return {
    store,
    supportTickets,
    supportSla: ticketSlaLabel(store.plan),
    currentPlanId: normalizePlanId(store.plan) || "free",
    isAdmin,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  console.log(`[plans] action ${actionType} received for ${store.shopDomain}`);

  if (actionType === "SELECT_PLAN") {
    const selectedPlan = normalizePlanId(formData.get("plan"));

    if (!selectedPlan) {
      return {
        scope: "plan",
        success: false,
        error: `Unknown plan. Choose one of: ${PLAN_IDS.join(", ")}.`,
      };
    }

    await prisma.store.update({
      where: { id: store.id },
      data: { plan: selectedPlan },
    });

    return {
      scope: "plan",
      success: true,
      message: `Successfully updated to the ${PLAN_CONFIG[selectedPlan].name} plan!`,
    };
  }

  if (actionType === "SUBMIT_SUPPORT_TICKET") {
    try {
      const chosenSubject = (formData.get("subject") || "").toString();
      const subject =
        chosenSubject === CUSTOM_SUBJECT_OPTION
          ? (formData.get("customSubject") || "").toString()
          : chosenSubject;

      const userEmailInput = (formData.get("merchantEmail") || "").toString().trim();
      const merchantEmail = userEmailInput || store.adminEmail || "";

      const result = await createTicket({
        storeId: store.id,
        subject,
        message: formData.get("message"),
        merchantEmail,
        plan: store.plan,
      });

      if (!result.success) return { ...result, scope: "support" };

      console.log(
        `[plans] support ticket ${result.ticket.id} saved for ${store.shopDomain}`,
      );

      return {
        scope: "support",
        success: true,
        ticketId: result.ticket.id,
        messageCount: result.ticket.messages.length,
        message: `Your query has been submitted successfully! Saved as Ticket #${result.ticket.id.slice(0, 8)}. Email notification sent to admin and follow-up will arrive at ${result.ticket.merchantEmail}.`,
      };
    } catch (error) {
      console.error("[plans] support ticket submission failed:", error);
      return {
        scope: "support",
        success: false,
        error: `Could not save your support ticket: ${error.message}`,
      };
    }
  }

  if (actionType === "REPLY_SUPPORT_TICKET") {
    try {
      const result = await addMerchantReply({
        storeId: store.id,
        ticketId: formData.get("ticketId"),
        body: formData.get("replyText"),
      });

      if (!result.success) return { ...result, scope: "support" };

      console.log(
        `[plans] support reply saved for ticket ${result.ticket.id} (store ${store.shopDomain})`,
      );

      return {
        scope: "support",
        success: true,
        ticketId: result.ticket.id,
        messageCount: result.ticket.messages.length,
        message: "Your reply was sent to the support team successfully.",
      };
    } catch (error) {
      console.error("[plans] support reply failed:", error);
      return {
        scope: "support",
        success: false,
        error: `Could not send your reply: ${error.message}`,
      };
    }
  }

  console.warn(`[plans] unhandled actionType ${JSON.stringify(actionType)}`);
  return { success: false, error: `Unsupported action "${actionType}".` };
};

export default function Plans() {
  const { store, supportTickets, currentPlanId, supportSla, isAdmin } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const submittedAction = navigation.formData?.get("actionType");
  const isSupportSubmitting =
    submittedAction === "SUBMIT_SUPPORT_TICKET" || submittedAction === "REPLY_SUPPORT_TICKET";

  const supportResult = actionData?.scope === "support" ? actionData : null;
  const planResult = actionData?.scope === "plan" ? actionData : null;

  const supportFormRef = useRef(null);
  const subjectInputRef = useRef(null);

  // Safely resolve merchant contact email string without crashing on null
  const storeEmail = (store?.adminEmail || "").toString().trim();
  const initialContactEmail =
    storeEmail && storeEmail.toLowerCase() !== ADMIN_EMAIL.toLowerCase()
      ? storeEmail
      : "";

  const [supportCategory, setSupportCategory] = useState("Technical Support Query");
  const [customSubject, setCustomSubject] = useState("");
  const [supportMessage, setSupportMessage] = useState("");
  const [contactEmail, setContactEmail] = useState(initialContactEmail);
  const [validationError, setValidationError] = useState("");
  const [ticketReplies, setTicketReplies] = useState({});

  useEffect(() => {
    if (supportResult?.success) {
      setSupportMessage("");
      setCustomSubject("");
    }
  }, [supportResult]);

  const supportError = supportResult?.success === false ? supportResult.error : null;
  const supportSavedId =
    supportResult?.success && supportResult.ticketId ? supportResult.ticketId : null;

  const subjectOptions = [
    { label: "Technical Support Query", value: "Technical Support Query" },
    { label: "Custom Metafield Audit Rule Setup", value: "Custom Metafield Audit Rule Setup" },
    { label: "Billing & Subscription Plan Upgrade", value: "Billing & Subscription Plan Upgrade" },
    { label: "Auto-Fix Engine Assistance", value: "Auto-Fix Engine Assistance" },
    { label: "Feature Request / Feedback", value: "Feature Request / Feedback" },
    { label: "Other / Custom Topic", value: "Other / Custom Topic" },
  ];

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

  const handleValidateBeforeSubmit = (event) => {
    const finalSubject =
      supportCategory === CUSTOM_SUBJECT_OPTION ? (customSubject || "").trim() : supportCategory;

    const emailVal = (contactEmail || "").trim();
    const messageVal = (supportMessage || "").trim();

    if (!emailVal || !emailVal.includes("@")) {
      event.preventDefault();
      setValidationError("Please enter a valid contact email address where our support team can reach you.");
      return;
    }

    if (!finalSubject || !messageVal) {
      event.preventDefault();
      setValidationError("Please specify a Subject / Inquiry Topic and a Detailed Message.");
    }
  };

  const plans = [
    {
      id: "free",
      name: "Starter Free",
      price: "$0",
      period: "/month",
      badge: "Starter",
      badgeTone: "subdued",
      isPopular: false,
      description: "Essential health checks for growing Shopify catalogs.",
      features: [
        "Audit up to 250 products",
        "Basic Missing SKU & Price checks",
        "Weekly manual catalog scan",
        "Standard Dashboard Metrics",
        "Community Support (2-3 days SLA)",
      ],
    },
    {
      id: "growth",
      name: "Growth Plan",
      price: "$9",
      period: "/month",
      badge: "Growing Stores",
      badgeTone: "info",
      isPopular: false,
      description: "Automated daily catalog audits & duplicate SKU detection.",
      features: [
        "Audit up to 2,500 products",
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
      price: "$29",
      period: "/month",
      badge: "MOST POPULAR",
      badgeTone: "highlight",
      isPopular: true,
      description: "Real-time webhook monitoring & custom metafield compliance engine.",
      features: [
        "Audit up to 10,000 products",
        "Real-time Webhook Instant Scans",
        "Required Metafield & Barcode Audit",
        "Custom Validation Rule Builder",
        "Instant Critical Email Alerts",
        "Priority Support (4h SLA)",
      ],
    },
    {
      id: "enterprise",
      name: "Plus Enterprise",
      price: "$49",
      period: "/month",
      badge: "UNLIMITED",
      badgeTone: "success",
      isPopular: false,
      description: "Auto-fix safety layer, multi-location inventory & VIP dedicated support.",
      features: [
        "Unlimited Product Audits",
        "Auto-Fix Resolution Engine",
        "Multi-Location Catalog Sync",
        "Unlimited Webhook & On-Demand Scans",
        "Custom Dedicated Rule Engineering",
        "VIP 1-on-1 Admin Support (1h SLA)",
      ],
    },
  ];

  const bannerMessage = planResult?.success ? planResult.message : null;

  return (
    <Page
      fullWidth
      title="Plans & Merchant Support"
      subtitle="Select the ideal monitoring tier for your Shopify store catalog size and feature needs"
      primaryAction={{
        content: "Submit Support Ticket",
        icon: EmailIcon,
        onClick: handleOpenSupportForm,
      }}
    >
      <BlockStack gap="500">
        {planResult?.error && (
          <Banner tone="critical" title="Plan change failed">
            <p>{planResult.error}</p>
          </Banner>
        )}

        {bannerMessage && (
          <Banner tone="success">
            <p>{bannerMessage}</p>
          </Banner>
        )}

        {supportSavedId && (
          <Banner tone="success" title="Support Ticket / Query Submitted Successfully!">
            <p>{supportResult?.message}</p>
          </Banner>
        )}

        {isAdmin && (
          <Banner
            tone="info"
            title="Admin Notice: Switch to Admin Portal to Reply to Tickets"
            action={{ content: "Open Admin Portal Control Center", url: "/app/admin" }}
          >
            <p>
              You are logged in as Admin. To view all merchant queries across stores, send replies, and manage statuses, click <strong>Admin Portal</strong> in the left sidebar or the button above.
            </p>
          </Banner>
        )}

        {/* Top Intro Banner */}
        <Banner tone="info" title="Feature-Aligned Subscription Plans">
          <p>
            Scale your product catalog quality assurance with automated daily scanning, required metafield enforcement, real-time webhook updates, and auto-fix rules. Current active store plan: <strong>{currentPlanId.toUpperCase()}</strong>.
          </p>
        </Banner>

        {/* Pricing Cards Grid */}
        <Grid>
          {plans.map((plan) => {
            const isCurrent = currentPlanId === plan.id;
            return (
              <Grid.Cell
                key={plan.id}
                columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}
              >
                <Card
                  padding="500"
                  background={plan.isPopular ? "bg-surface-secondary" : undefined}
                >
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text variant="headingLg" as="h3" fontWeight="bold">
                        {plan.name}
                      </Text>
                      {isCurrent ? (
                        <Badge tone="success">ACTIVE PLAN</Badge>
                      ) : (
                        <Badge tone={plan.badgeTone}>{plan.badge}</Badge>
                      )}
                    </InlineStack>

                    <InlineStack gap="100" align="baseline">
                      <Text variant="heading2xl" as="span" fontWeight="bold">
                        {plan.price}
                      </Text>
                      <Text variant="bodyMd" tone="subdued" as="span">
                        {plan.period}
                      </Text>
                    </InlineStack>

                    <Text variant="bodySm" tone="subdued">
                      {plan.description}
                    </Text>

                    <Divider />

                    <BlockStack gap="200">
                      <Text variant="headingSm" as="h4" fontWeight="bold">
                        Included Features:
                      </Text>
                      {plan.features.map((feat, idx) => (
                        <InlineStack key={idx} gap="200" align="start" blockAlign="center">
                          <Icon source={CheckIcon} tone="success" />
                          <Text variant="bodySm">{feat}</Text>
                        </InlineStack>
                      ))}
                    </BlockStack>

                    <Box paddingBlockStart="300">
                      <Form method="post">
                        <input type="hidden" name="actionType" value="SELECT_PLAN" />
                        <input type="hidden" name="plan" value={plan.id} />
                        <Button
                          submit
                          fullWidth
                          size="large"
                          variant={plan.isPopular && !isCurrent ? "primary" : "secondary"}
                          disabled={isCurrent || isLoading}
                        >
                          {isCurrent ? "Current Active Plan" : `Select ${plan.name}`}
                        </Button>
                      </Form>
                    </Box>
                  </BlockStack>
                </Card>
              </Grid.Cell>
            );
          })}
        </Grid>

        {/* Merchant Support Section */}
        <Card padding="500">
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <Icon source={CheckCircleIcon} tone="success" />
                  <Text variant="headingMd" as="h3">
                    Merchant Support & Escalations
                  </Text>
                </InlineStack>
                <Text variant="bodySm" tone="subdued">
                  Direct support assistance for custom audit rules, metafield setup, or plan upgrades.
                </Text>
              </BlockStack>

              <Button
                variant="primary"
                icon={EmailIcon}
                onClick={handleOpenSupportForm}
              >
                Open Support Ticket
              </Button>
            </InlineStack>

            <Divider />

            <Grid>
              <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                <Card padding="400" background="bg-surface-secondary">
                  <BlockStack gap="200">
                    <InlineStack gap="200" blockAlign="center">
                      <Icon source={EmailIcon} tone="highlight" />
                      <Text variant="headingSm" as="h4">
                        Direct Email Support
                      </Text>
                    </InlineStack>
                    <Text variant="bodySm">
                      Dedicated Support Email: <strong>{ADMIN_EMAIL}</strong>
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Managed Store Domain: {store.shopDomain}
                    </Text>
                  </BlockStack>
                </Card>
              </Grid.Cell>

              <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                <Card padding="400" background="bg-surface-secondary">
                  <BlockStack gap="200">
                    <InlineStack gap="200" blockAlign="center">
                      <Icon source={ClockIcon} tone="highlight" />
                      <Text variant="headingSm" as="h4">
                        Guaranteed Support SLA Response
                      </Text>
                    </InlineStack>
                    <BlockStack gap="100">
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
                  </BlockStack>
                </Card>
              </Grid.Cell>
            </Grid>

            {/* Permanent Inline Support Ticket Creation Form */}
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

                  {supportSavedId && (
                    <Banner tone="success" title="Support Ticket Submitted Successfully!">
                      <BlockStack gap="100">
                        <Text variant="bodyMd" fontWeight="bold">{supportResult.message}</Text>
                        <Text variant="bodySm" tone="subdued">
                          Saved as ticket <strong>{supportResult?.ticketId}</strong>. Replies appear in your ticket history below.
                        </Text>
                      </BlockStack>
                    </Banner>
                  )}

                  {validationError && (
                    <Banner tone="critical" onDismiss={() => setValidationError("")}>
                      <p>{validationError}</p>
                    </Banner>
                  )}

                  {supportError && (
                    <Banner tone="critical" title="Support ticket was not saved">
                      <p>{supportError}</p>
                      <p>
                        Nothing was lost - your text is still in the form below.
                        Try again, or email {ADMIN_EMAIL} directly.
                      </p>
                    </Banner>
                  )}

                  <Text variant="bodySm" tone="subdued">
                    {`Your ${PLAN_LABELS[currentPlanId] || currentPlanId} plan response target: ${supportSla}. `}
                    {`${supportTickets.length} ticket(s) on record for this store.`}
                  </Text>

                  <Form method="post" onSubmit={handleValidateBeforeSubmit}>
                    <input type="hidden" name="actionType" value="SUBMIT_SUPPORT_TICKET" />
                    <FormLayout>
                      <Grid>
                        <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                          <TextField
                            name="merchantEmail"
                            label="Your Contact Email"
                            value={contactEmail}
                            onChange={setContactEmail}
                            placeholder="Enter your contact email address (e.g. merchant@yourstore.com)"
                            autoComplete="email"
                            helpText="Replies will be sent to this email address."
                          />
                        </Grid.Cell>
                        <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                          <Select
                            name="subject"
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

                      {supportCategory === CUSTOM_SUBJECT_OPTION && (
                        <TextField
                          name="customSubject"
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
                        name="message"
                        label="Detailed Message / Issue Description"
                        value={supportMessage}
                        onChange={(val) => {
                          setSupportMessage(val);
                          if (validationError) setValidationError("");
                        }}
                        multiline={4}
                        placeholder="Please describe your question or issue in detail..."
                        autoComplete="off"
                      />
                      <InlineStack align="end">
                        <Button
                          submit
                          variant="primary"
                          size="large"
                          icon={SendIcon}
                          loading={isSupportSubmitting}
                        >
                          Submit Support Ticket
                        </Button>
                      </InlineStack>
                    </FormLayout>
                  </Form>
                </BlockStack>
              </Box>
            </div>

            {/* Support Ticket History */}
            {supportTickets.length > 0 && (
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingSm" as="h4">
                    Your Support Ticket History ({supportTickets.length})
                  </Text>
                  {isAdmin && (
                    <Button url="/app/admin" size="micro" variant="primary">
                      Reply as Admin in Admin Portal →
                    </Button>
                  )}
                </InlineStack>

                {supportTickets.map((ticket) => (
                  <Card key={ticket.id} padding="300">
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="start">
                        <BlockStack gap="100">
                          <Text variant="bodyMd" fontWeight="bold">
                            {ticket.subject}
                          </Text>
                          <Text variant="bodySm" tone="subdued">
                            {`Opened ${new Date(ticket.createdAt).toLocaleString()}`}
                            {ticket.repliedAt
                              ? ` · answered ${new Date(ticket.repliedAt).toLocaleString()}`
                              : ""}
                          </Text>
                        </BlockStack>

                        <Badge
                          tone={
                            ticket.status === "OPEN"
                              ? "attention"
                              : ticket.status === "ANSWERED"
                              ? "info"
                              : "success"
                          }
                        >
                          {ticket.status}
                        </Badge>
                      </InlineStack>

                      {(ticket.messages || []).map((msg) => {
                        const isAdminMsg = msg.sender === "ADMIN";
                        return (
                          <Box
                            key={msg.id}
                            padding="300"
                            borderRadius="150"
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
                                      : `You (${msg.authorEmail || ticket.merchantEmail})`}
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

                      {ticket.status !== "RESOLVED" && (
                        <Form method="post">
                          <input type="hidden" name="actionType" value="REPLY_SUPPORT_TICKET" />
                          <input type="hidden" name="ticketId" value={ticket.id} />
                          <InlineStack gap="200" blockAlign="end" wrap={false}>
                            <div style={{ flex: 1 }}>
                              <TextField
                                name="replyText"
                                label="Reply to support"
                                labelHidden
                                value={ticketReplies[ticket.id] || ""}
                                onChange={(val) =>
                                  setTicketReplies((prev) => ({ ...prev, [ticket.id]: val }))
                                }
                                placeholder="Add more detail or answer support's question..."
                                multiline={2}
                                autoComplete="off"
                              />
                            </div>
                            <Button submit icon={SendIcon} loading={isSupportSubmitting}>
                              Send Reply
                            </Button>
                          </InlineStack>
                        </Form>
                      )}
                    </BlockStack>
                  </Card>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
