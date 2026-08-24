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
  Grid,
  Icon,
  Collapsible,
} from "@shopify/polaris";
import {
  EmailIcon,
  ClockIcon,
  QuestionCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from "@shopify/polaris-icons";

export const CUSTOM_SUBJECT_OPTION = "Other / Custom Topic";

const PLAN_LABELS = {
  free: "Starter Free",
  growth: "Growth",
  pro: "Pro Advanced",
  enterprise: "Plus Enterprise",
};

export const loader = async ({ request }) => {
  const { authenticate } = await import("../shopify.server.js");
  const { ensureStoreRecord } = await import("../services/syncEngine.server.js");
  const { listStoreTickets, ticketSlaLabel } = await import("../services/supportEngine.server.js");

  const adminEmailEnv = process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com";
  const adminShopPrefix = process.env.ADMIN_STORE_NAME || "quickstart-749ac396";

  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);

  const shopDomain = session.shop.toLowerCase();
  const adminEmail = (store.adminEmail || "").toLowerCase();
  const isAdmin =
    shopDomain.includes(adminShopPrefix.toLowerCase()) ||
    adminEmail === adminEmailEnv.toLowerCase();

  const supportTickets = await listStoreTickets(store.id);

  return {
    store,
    supportTickets,
    supportSla: ticketSlaLabel(store.plan),
    currentPlanId: store.plan || "free",
    isAdmin,
    adminEmail: adminEmailEnv,
  };
};

export const action = async ({ request }) => {
  const { authenticate } = await import("../shopify.server.js");
  const { ensureStoreRecord } = await import("../services/syncEngine.server.js");
  const { createTicket, addMerchantReply, ticketSlaLabel } = await import("../services/supportEngine.server.js");

  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "CREATE_TICKET") {
    const rawEmail = (formData.get("contactEmail") || "").toString().trim();
    const topic = (formData.get("topic") || "").toString().trim();
    const customSubject = (formData.get("customSubject") || "").toString().trim();
    const message = (formData.get("message") || "").toString().trim();

    const subject =
      topic === CUSTOM_SUBJECT_OPTION
        ? customSubject || "Merchant Query"
        : topic || "Merchant Query";

    if (!message) {
      return {
        scope: "support",
        success: false,
        error: "Please write a detailed message for your ticket.",
      };
    }

    const emailToSave = rawEmail || store.adminEmail || `merchant@${store.shopDomain}`;

    try {
      const result = await createTicket({
        storeId: store.id,
        merchantEmail: emailToSave,
        subject,
        message,
        plan: store.plan,
      });

      if (!result.success) {
        return {
          scope: "support",
          success: false,
          error: result.error || "Failed to create support ticket.",
        };
      }

      const ticket = result.ticket;
      return {
        scope: "support",
        success: true,
        savedId: ticket.id,
        message: `Ticket #${ticket.id.slice(0, 8)} submitted successfully. SLA Target: ${ticketSlaLabel(ticket.planAtSubmission)}.`,
      };
    } catch (err) {
      return {
        scope: "support",
        success: false,
        error: err.message || "Failed to create support ticket.",
      };
    }
  }

  if (actionType === "REPLY_TICKET") {
    const ticketId = (formData.get("ticketId") || "").toString().trim();
    const message = (formData.get("message") || "").toString().trim();

    if (!message) {
      return {
        scope: "support",
        success: false,
        error: "Reply message cannot be empty.",
      };
    }

    try {
      await addMerchantReply({
        ticketId,
        storeId: store.id,
        body: message,
      });

      return {
        scope: "support",
        success: true,
        message: "Your reply has been added to the conversation history.",
      };
    } catch (err) {
      return {
        scope: "support",
        success: false,
        error: err.message || "Failed to send reply.",
      };
    }
  }

  return { success: false };
};

export default function HelpAndSupport() {
  const { store, supportTickets, supportSla, currentPlanId, isAdmin, adminEmail } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const isSubmitting = navigation.state !== "idle";

  const [topic, setTopic] = useState("Technical Support Query");
  const [customSubject, setCustomSubject] = useState("");
  const [contactEmail, setContactEmail] = useState(
    store.adminEmail || `merchant@${store.shopDomain}`
  );
  const [message, setMessage] = useState("");
  const [replyMessages, setReplyMessages] = useState({});

  const supportFormRef = useRef(null);

  const supportResult = actionData?.scope === "support" ? actionData : null;
  const supportSavedId = supportResult?.success ? supportResult?.savedId : null;

  useEffect(() => {
    if (supportResult?.success && supportSavedId) {
      setMessage("");
      setCustomSubject("");
    }
  }, [supportResult, supportSavedId]);

  const handleScrollToForm = () => {
    if (supportFormRef.current) {
      supportFormRef.current.scrollIntoView({ behavior: "smooth" });
    }
  };

  const topicOptions = [
    { label: "Technical Support Query", value: "Technical Support Query" },
    { label: "Validation Rule Customization Request", value: "Validation Rule Customization Request" },
    { label: "Metafield Enforcement Setup", value: "Metafield Enforcement Setup" },
    { label: "Plan & Billing Inquiry", value: "Plan & Billing Inquiry" },
    { label: "Feature Request / Enhancement", value: "Feature Request / Enhancement" },
    { label: CUSTOM_SUBJECT_OPTION, value: CUSTOM_SUBJECT_OPTION },
  ];

  const [openFaq, setOpenFaq] = useState(null);

  const toggleFaq = (index) => {
    setOpenFaq(openFaq === index ? null : index);
  };

  const faqItems = [
    {
      question: "How is the Store Catalog Health Score calculated?",
      answer:
        "Your Health Score evaluates all active products against enabled validation rules. Missing images, missing SKUs, zero prices, and missing required metafields subtract from the total score. Resolving or ignoring valid exceptions restores your overall percentage.",
    },
    {
      question: "How does the Auto-Fix Engine work?",
      answer:
        "Available on Plus Enterprise plans, the Auto-Fix Engine automatically updates products with standard fallback descriptions, auto-generated unique SKUs, or inventory sync corrections directly via Shopify API.",
    },
    {
      question: "How often do automated catalog scans run?",
      answer:
        "Automated daily scans run every 24 hours on Growth, Pro, and Enterprise plans. On Pro and Enterprise, real-time webhooks also trigger instant scans whenever products are created or modified.",
    },
    {
      question: "Can I customize validation rules for specific collections or vendors?",
      answer:
        "Yes! Navigate to the Validation Rules Engine page to create custom rules scoped specifically to particular Collections, Vendors, or Product Types.",
    },
  ];

  return (
    <Page
      fullWidth
      title="Merchant Support"
      subtitle="Contact support for audit rule setup, catalog diagnostics, or technical assistance"
      primaryAction={{
        content: "New Ticket",
        onClick: handleScrollToForm,
      }}
    >
      <BlockStack gap="500">
        {supportResult?.error && (
          <Banner tone="critical" title="Submission Error">
            <p>{supportResult.error}</p>
          </Banner>
        )}

        {supportSavedId && (
          <Banner tone="success" title="Ticket Submitted">
            <p>{supportResult?.message}</p>
          </Banner>
        )}

        {isAdmin && (
          <Banner
            tone="info"
            title="Admin Mode Active"
            action={{ content: "Open Admin Portal", url: "/app/admin" }}
          >
            <p>
              To manage merchant tickets across all stores, access the <strong>Admin Portal</strong>.
            </p>
          </Banner>
        )}

        {/* Top Info Cards */}
        <Grid>
          <Grid.Cell columnSpan={{ xs: 12, sm: 6, md: 6, lg: 6, xl: 6 }}>
            <Card padding="500">
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                    <Icon source={EmailIcon} tone="primary" />
                  </Box>
                  <Text variant="headingSm" as="h3" fontWeight="bold">
                    Direct Support Email
                  </Text>
                </InlineStack>
                <Text variant="bodyMd">
                  Contact: <strong>{adminEmail}</strong>
                </Text>
                <Text variant="bodySm" tone="subdued">
                  Store Domain: {store.shopDomain}
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 12, sm: 6, md: 6, lg: 6, xl: 6 }}>
            <Card padding="500">
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Box padding="200" background="bg-surface-success-subdued" borderRadius="200">
                      <Icon source={ClockIcon} tone="success" />
                    </Box>
                    <Text variant="headingSm" as="h3" fontWeight="bold">
                      Response SLA Targets
                    </Text>
                  </InlineStack>
                  <Badge tone="success">{PLAN_LABELS[currentPlanId] || currentPlanId}</Badge>
                </InlineStack>
                <Text variant="bodySm">
                  Guaranteed Response Time: <strong>{supportSla}</strong>
                </Text>
                <Text variant="bodySm" tone="subdued">
                  SLA targets are defined by your active subscription plan tier.
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>
        </Grid>

        {/* Frequently Asked Questions */}
        <Card padding="500">
          <BlockStack gap="400">
            <InlineStack gap="200" blockAlign="center">
              <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                <Icon source={QuestionCircleIcon} tone="base" />
              </Box>
              <Text variant="headingMd" as="h2" fontWeight="bold">
                Frequently Asked Questions & Quick Help
              </Text>
            </InlineStack>
            <Divider />
            <BlockStack gap="200">
              {faqItems.map((item, idx) => (
                <Box
                  key={idx}
                  padding="300"
                  borderRadius="200"
                  background="bg-surface-secondary"
                >
                  <BlockStack gap="200">
                    <Button
                      fullWidth
                      textAlign="left"
                      variant="plain"
                      icon={openFaq === idx ? ChevronUpIcon : ChevronDownIcon}
                      onClick={() => toggleFaq(idx)}
                    >
                      <Text variant="bodyMd" fontWeight="bold" as="span">
                        {item.question}
                      </Text>
                    </Button>
                    <Collapsible
                      open={openFaq === idx}
                      id={`faq-collapse-${idx}`}
                      transition={{ duration: "200ms", timingFunction: "ease-in-out" }}
                    >
                      <Box paddingBlockStart="200">
                        <Text variant="bodySm" tone="subdued">
                          {item.answer}
                        </Text>
                      </Box>
                    </Collapsible>
                  </BlockStack>
                </Box>
              ))}
            </BlockStack>
          </BlockStack>
        </Card>

        {/* Ticket Submission Form */}
        <div ref={supportFormRef}>
          <Card padding="500">
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2" fontWeight="bold">
                  Submit Support Request
                </Text>
                <Text variant="bodySm" tone="subdued">
                  Target Response: {supportSla}
                </Text>
              </InlineStack>

              <Divider />

              <Form method="post">
                <input type="hidden" name="actionType" value="CREATE_TICKET" />
                <FormLayout>
                  <FormLayout.Group>
                    <TextField
                      label="Contact Email"
                      name="contactEmail"
                      type="email"
                      value={contactEmail}
                      onChange={(v) => setContactEmail(v)}
                      autoComplete="email"
                    />
                    <Select
                      label="Inquiry Topic"
                      name="topic"
                      options={topicOptions}
                      value={topic}
                      onChange={(v) => setTopic(v)}
                    />
                  </FormLayout.Group>

                  {topic === CUSTOM_SUBJECT_OPTION && (
                    <TextField
                      label="Subject"
                      name="customSubject"
                      value={customSubject}
                      onChange={(v) => setCustomSubject(v)}
                      placeholder="Specify subject"
                      autoComplete="off"
                    />
                  )}

                  <TextField
                    label="Description"
                    name="message"
                    value={message}
                    onChange={(v) => setMessage(v)}
                    multiline={5}
                    placeholder="Describe your request or technical query..."
                    autoComplete="off"
                  />

                  <InlineStack align="start">
                    <Button
                      submit
                      variant="primary"
                      size="large"
                      loading={isSubmitting}
                    >
                      Submit Ticket
                    </Button>
                  </InlineStack>
                </FormLayout>
              </Form>
            </BlockStack>
          </Card>
        </div>

        {/* Support Ticket History */}
        {(supportTickets || []).length > 0 && (
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2" fontWeight="bold">
                Ticket History ({(supportTickets || []).length})
              </Text>
              {isAdmin && (
                <Button size="micro" url="/app/admin">
                  Open Admin Portal
                </Button>
              )}
            </InlineStack>

            {(supportTickets || []).map((t) => (
              <Card key={t.id} padding="500">
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="050">
                      <Text variant="headingSm" as="h3" fontWeight="bold">
                        {t.subject}
                      </Text>
                      <Text variant="bodyXs" tone="subdued">
                        ID: #{t.id.slice(0, 8)} · Created {new Date(t.createdAt).toLocaleString()}
                      </Text>
                    </BlockStack>

                    <Badge
                      tone={
                        t.status === "OPEN"
                          ? "attention"
                          : t.status === "RESOLVED"
                          ? "success"
                          : "info"
                      }
                    >
                      {t.status}
                    </Badge>
                  </InlineStack>

                  <Divider />

                  <BlockStack gap="300">
                    {(t.messages || []).map((msg) => {
                      const isMerchant = msg.sender === "MERCHANT";
                      return (
                        <Box
                          key={msg.id}
                          padding="300"
                          borderRadius="200"
                          background={isMerchant ? "bg-surface-secondary" : "bg-surface-info"}
                        >
                          <BlockStack gap="100">
                            <InlineStack align="space-between" blockAlign="center">
                              <Text variant="bodySm" fontWeight="bold">
                                {isMerchant ? "You" : "Support Representative"}
                              </Text>
                              <Text variant="bodyXs" tone="subdued">
                                {new Date(msg.createdAt).toLocaleString()}
                              </Text>
                            </InlineStack>
                            <Text variant="bodySm">{msg.body}</Text>
                          </BlockStack>
                        </Box>
                      );
                    })}
                  </BlockStack>

                  {t.status !== "RESOLVED" && (
                    <Box paddingBlockStart="200">
                      <Form method="post">
                        <input type="hidden" name="actionType" value="REPLY_TICKET" />
                        <input type="hidden" name="ticketId" value={t.id} />
                        <InlineStack gap="200" align="space-between" blockAlign="center">
                          <div style={{ flex: 1 }}>
                            <TextField
                              labelHidden
                              label="Reply message"
                              name="message"
                              value={replyMessages[t.id] || ""}
                              onChange={(v) =>
                                setReplyMessages((prev) => ({ ...prev, [t.id]: v }))
                              }
                              placeholder="Write a reply..."
                              autoComplete="off"
                            />
                          </div>
                          <Button submit variant="secondary">
                            Send Reply
                          </Button>
                        </InlineStack>
                      </Form>
                    </Box>
                  )}
                </BlockStack>
              </Card>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Page>
  );
}
