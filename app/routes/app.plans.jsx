import { useState } from "react";
import { useLoaderData, useSubmit, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  InlineStack,
  BlockStack,
  Badge,
  Box,
  Divider,
  Modal,
  FormLayout,
  TextField,
  Banner,
  Icon,
  Grid,
} from "@shopify/polaris";
import { CheckIcon, EmailIcon, ClockIcon, CheckCircleIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord } from "../services/syncEngine.server.js";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);

  const supportTickets = await prisma.supportTicket.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return { store, supportTickets };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "SELECT_PLAN") {
    const selectedPlan = formData.get("plan");
    if (selectedPlan) {
      await prisma.store.update({
        where: { id: store.id },
        data: { plan: selectedPlan.toLowerCase() },
      });
      return { success: true, message: `Successfully updated to ${selectedPlan} plan!` };
    }
  }

  if (actionType === "SUBMIT_SUPPORT_TICKET") {
    const subject = formData.get("subject");
    const message = formData.get("message");
    const merchantEmail = formData.get("merchantEmail") || ADMIN_EMAIL;

    if (subject && message) {
      await prisma.supportTicket.create({
        data: {
          storeId: store.id,
          subject,
          message,
          merchantEmail,
          status: "OPEN",
        },
      });

      await prisma.store.update({
        where: { id: store.id },
        data: { adminEmail: merchantEmail },
      });

      return { success: true, message: "Support ticket sent successfully!" };
    }
  }

  return { success: false };
};

export default function Plans() {
  const { store, supportTickets } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const [supportModalOpen, setSupportModalOpen] = useState(false);
  const [supportSubject, setSupportSubject] = useState("");
  const [supportMessage, setSupportMessage] = useState("");
  const [contactEmail, setContactEmail] = useState(store.adminEmail || ADMIN_EMAIL);
  const [feedbackBanner, setFeedbackBanner] = useState("");

  const currentPlanId = (store.plan || "free").toLowerCase();

  const handleSelectPlan = (planId, planName) => {
    submit({ actionType: "SELECT_PLAN", plan: planId }, { method: "post" });
    setFeedbackBanner(`Switched to ${planName}!`);
  };

  const handleSendSupportTicket = () => {
    if (!supportSubject.trim() || !supportMessage.trim()) return;
    submit(
      {
        actionType: "SUBMIT_SUPPORT_TICKET",
        subject: supportSubject,
        message: supportMessage,
        merchantEmail: contactEmail,
      },
      { method: "post" }
    );
    setSupportModalOpen(false);
    setSupportSubject("");
    setSupportMessage("");
    setFeedbackBanner(`Support ticket submitted to ${ADMIN_EMAIL}. We will respond shortly.`);
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
      description: "Essential health checks for boutique Shopify catalogs.",
      features: [
        "Audit up to 100 products",
        "Basic Missing SKU & Price checks",
        "Weekly manual catalog scan",
        "Standard Dashboard Metrics",
        "Community Support",
      ],
    },
    {
      id: "growth",
      name: "Growth Plan",
      price: "$29",
      period: "/month",
      badge: "Growing Stores",
      badgeTone: "info",
      isPopular: false,
      description: "Automated daily catalog audits & duplicate SKU detection.",
      features: [
        "Audit up to 1,000 products",
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
      price: "$79",
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
      price: "$199",
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
        "VIP 1-on-1 Admin Support",
      ],
    },
  ];

  return (
    <Page
      fullWidth
      title="Plans & Merchant Support"
      subtitle="Select the ideal monitoring tier for your Shopify store catalog size and feature needs"
      primaryAction={{
        content: "Submit Support Ticket",
        icon: EmailIcon,
        onClick: () => setSupportModalOpen(true),
      }}
    >
      <BlockStack gap="500">
        {feedbackBanner && (
          <Banner tone="success" onDismiss={() => setFeedbackBanner("")}>
            <p>{feedbackBanner}</p>
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
                      <Button
                        fullWidth
                        size="large"
                        variant={plan.isPopular && !isCurrent ? "primary" : "secondary"}
                        disabled={isCurrent || isLoading}
                        onClick={() => handleSelectPlan(plan.id, plan.name)}
                      >
                        {isCurrent ? "Current Active Plan" : `Select ${plan.name}`}
                      </Button>
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
                onClick={() => setSupportModalOpen(true)}
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
                        Guaranteed SLA Response
                      </Text>
                    </InlineStack>
                    <Text variant="bodySm">
                      Pro & Growth Subscribers: <strong>2 - 4 hours response SLA</strong>
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Free Tier Subscribers: Within 24 hours
                    </Text>
                  </BlockStack>
                </Card>
              </Grid.Cell>
            </Grid>

            {/* Support Ticket History */}
            {supportTickets.length > 0 && (
              <BlockStack gap="300">
                <Text variant="headingSm" as="h4">
                  Your Support Ticket History ({supportTickets.length})
                </Text>
                {supportTickets.map((ticket) => (
                  <Card key={ticket.id} padding="300">
                    <InlineStack align="space-between" blockAlign="start">
                      <BlockStack gap="100">
                        <Text variant="bodyMd" fontWeight="bold">
                          {ticket.subject}
                        </Text>
                        <Text variant="bodySm" tone="subdued">
                          {ticket.message}
                        </Text>
                        <Text variant="bodySm" tone="subdued">
                          Submitted on: {new Date(ticket.createdAt).toLocaleString()}
                        </Text>
                      </BlockStack>

                      <Badge tone={ticket.status === "OPEN" ? "attention" : "success"}>
                        {ticket.status}
                      </Badge>
                    </InlineStack>
                  </Card>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>

      {/* Support Ticket Modal */}
      <Modal
        open={supportModalOpen}
        onClose={() => setSupportModalOpen(false)}
        title="Submit Merchant Support Inquiry"
        primaryAction={{
          content: "Send Support Ticket",
          onClick: handleSendSupportTicket,
          loading: isLoading,
          disabled: !supportSubject.trim() || !supportMessage.trim(),
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onClick: () => setSupportModalOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <Banner tone="info">
              <p>Your support ticket will be sent directly to administrator <strong>{ADMIN_EMAIL}</strong>.</p>
            </Banner>
            <TextField
              label="Contact Email"
              value={contactEmail}
              onChange={setContactEmail}
              autoComplete="email"
            />
            <TextField
              label="Subject / Inquiry Topic"
              value={supportSubject}
              onChange={setSupportSubject}
              placeholder="e.g. Need assistance setting up custom metafield audit rules"
              autoComplete="off"
            />
            <TextField
              label="Detailed Message"
              value={supportMessage}
              onChange={setSupportMessage}
              multiline={4}
              placeholder="Please explain your question or issue in detail..."
              autoComplete="off"
            />
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
