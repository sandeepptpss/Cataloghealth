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
} from "@shopify/polaris";
import {
  EmailIcon,
  ClockIcon,
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
  const { ticketSlaLabel } = await import("../services/supportEngine.server.js");

  const adminEmailEnv = process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com";

  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);

  return {
    store,
    supportSla: ticketSlaLabel(store.plan),
    currentPlanId: store.plan || "free",
    adminEmail: adminEmailEnv,
  };
};

export const action = async ({ request }) => {
  const { authenticate } = await import("../shopify.server.js");
  const { ensureStoreRecord } = await import("../services/syncEngine.server.js");
  const { createTicket, ticketSlaLabel } = await import("../services/supportEngine.server.js");

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
        error: "Please write a detailed message for your query.",
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
          error: result.error || "Failed to send merchant query.",
        };
      }

      return {
        scope: "support",
        success: true,
        savedId: result.ticket.id,
        message: `Your query notification has been sent to our support team (${process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com"}). We will reply directly to your contact email (${emailToSave}). Target Response: ${ticketSlaLabel(store.plan)}.`,
      };
    } catch (err) {
      return {
        scope: "support",
        success: false,
        error: err.message || "Failed to send merchant query.",
      };
    }
  }

  return { success: false };
};

export default function HelpAndSupport() {
  const { store, supportSla, currentPlanId, adminEmail } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const isSubmitting = navigation.state !== "idle";

  const [topic, setTopic] = useState("Technical Support Query");
  const [customSubject, setCustomSubject] = useState("");
  const [contactEmail, setContactEmail] = useState(
    store.adminEmail || `merchant@${store.shopDomain}`
  );
  const [message, setMessage] = useState("");

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

  return (
    <Page
      fullWidth
      title="Merchant Support & Chat Inquiry"
      subtitle="Send a direct query notification to support. All responses are sent and managed via email."
      primaryAction={{
        content: "Send Query",
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
          <Banner tone="success" title="Query Sent via Email Notification">
            <p>{supportResult?.message}</p>
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

        {/* Query Form */}
        <div ref={supportFormRef}>
          <Card padding="500">
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingMd" as="h2" fontWeight="bold">
                    Send Merchant Query
                  </Text>
                  <Text variant="bodySm" tone="subdued">
                    Your inquiry will generate an instant email notification to support. Replies are delivered directly to your contact email.
                  </Text>
                </BlockStack>
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
                      helpText="Replies to your query will be sent to this email address"
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
                    label="Query Message"
                    name="message"
                    value={message}
                    onChange={(v) => setMessage(v)}
                    multiline={5}
                    placeholder="Write your merchant query or message here..."
                    autoComplete="off"
                  />

                  <InlineStack align="start">
                    <Button
                      submit
                      variant="primary"
                      size="large"
                      loading={isSubmitting}
                    >
                      Send Query Message
                    </Button>
                  </InlineStack>
                </FormLayout>
              </Form>
            </BlockStack>
          </Card>
        </div>
      </BlockStack>
    </Page>
  );
}

