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
import { CheckIcon, EmailIcon, CheckCircleIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord } from "../services/syncEngine.server.js";

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
    const merchantEmail = formData.get("merchantEmail") || "merchant@store.com";

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

      // Save admin email reference to store if provided
      await prisma.store.update({
        where: { id: store.id },
        data: { adminEmail: merchantEmail },
      });

      return { success: true, message: "Support ticket sent to sandeepptpss@gmail.com successfully!" };
    }
  }

  return { success: false };
};

export default function PricingPlans() {
  const { store, supportTickets } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const [supportModalOpen, setSupportModalOpen] = useState(false);
  const [supportSubject, setSupportSubject] = useState("");
  const [supportMessage, setSupportMessage] = useState("");
  const [contactEmail, setContactEmail] = useState(store.adminEmail || "sandeepptpss@gmail.com");
  const [feedbackBanner, setFeedbackBanner] = useState("");

  const handleSelectPlan = (planName) => {
    submit({ actionType: "SELECT_PLAN", plan: planName }, { method: "post" });
    setFeedbackBanner(`Switched to ${planName} Plan!`);
  };

  const handleSendSupportTicket = () => {
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
    setFeedbackBanner("Support ticket submitted! Support team (sandeepptpss@gmail.com) will get back to you shortly.");
  };

  const plans = [
    {
      id: "free",
      name: "Free Tier",
      price: "$0",
      period: "/month",
      badge: "Starter",
      badgeTone: "subdued",
      description: "Essential catalog quality checks for growing Shopify stores.",
      features: [
        "Audit up to 250 products",
        "Basic Missing Image & SKU checks",
        "Price & Barcode validation",
        "Weekly manual catalog scan",
        "Standard Email Support",
      ],
    },
    {
      id: "growth",
      name: "Growth Plan",
      price: "$19",
      period: "/month",
      badge: "Most Popular",
      badgeTone: "highlight",
      description: "Automated daily catalog monitoring and metafield compliance.",
      features: [
        "Audit up to 2,500 products",
        "Daily automated catalog audits",
        "Required Metafield validation",
        "Duplicate SKU detection engine",
        "Priority Email Support (24h response)",
      ],
    },
    {
      id: "pro",
      name: "Pro Enterprise",
      price: "$49",
      period: "/month",
      badge: "Advanced",
      badgeTone: "success",
      description: "Unlimited product audits, custom priorities & auto-fix rules.",
      features: [
        "Unlimited product audits",
        "Real-time webhook sync & scans",
        "Custom rule priority builder",
        "Auto-fix safety layer",
        "Dedicated Support (sandeepptpss@gmail.com)",
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
        onClick: () => setSupportModalOpen(true),
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
                columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}
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
                onClick={() => setSupportModalOpen(true)}
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
                      App Lead: sandeepptpss@gmail.com
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Dedicated Admin Access: Granted for quickstart-749ac396 store
                    </Text>
                  </BlockStack>
                </Card>
              </Grid.Cell>
              <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                <Card padding="400">
                  <BlockStack gap="2">
                    <Text variant="headingSm" as="h4">
                      Support SLA & Response Time
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Pro & Growth Plan merchants receive responses within 2-4 hours.
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Free plan support queries answered within 24 hours.
                    </Text>
                  </BlockStack>
                </Card>
              </Grid.Cell>
            </Grid>

            {/* Recent Merchant Support Tickets */}
            {supportTickets.length > 0 && (
              <BlockStack gap="3">
                <Text variant="headingSm" as="h4">
                  Your Recent Support Tickets ({supportTickets.length})
                </Text>
                {supportTickets.map((ticket) => (
                  <Card key={ticket.id} padding="300">
                    <InlineStack align="space-between">
                      <BlockStack gap="1">
                        <Text variant="bodyMd" fontWeight="bold">
                          {ticket.subject}
                        </Text>
                        <Text variant="bodySm" tone="subdued">
                          {ticket.message}
                        </Text>
                        <Text variant="bodySm" tone="subdued">
                          Sent on: {new Date(ticket.createdAt).toLocaleString()}
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
        title="Contact App Administrator Support"
        primaryAction={{
          content: "Submit Ticket to sandeepptpss@gmail.com",
          onClick: handleSendSupportTicket,
          loading: isLoading,
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
            <TextField
              label="Your Contact Email"
              value={contactEmail}
              onChange={setContactEmail}
              autoComplete="email"
              placeholder="sandeepptpss@gmail.com"
            />
            <TextField
              label="Support Subject"
              value={supportSubject}
              onChange={setSupportSubject}
              placeholder="e.g. Requesting custom metafield validation rule setup"
              autoComplete="off"
            />
            <TextField
              label="Detailed Message / Issue Description"
              value={supportMessage}
              onChange={setSupportMessage}
              multiline={4}
              placeholder="Describe your inquiry or request for the catalog health team..."
              autoComplete="off"
            />
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
