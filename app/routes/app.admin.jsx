import { useState } from "react";
import { useLoaderData, useSubmit, useNavigation } from "react-router";
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
  Modal,
  TextField,
  FormLayout,
} from "@shopify/polaris";
import { CheckCircleIcon, EmailIcon, RefreshIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord } from "../services/syncEngine.server.js";

const ADMIN_EMAIL = "sandeepptpss@gmail.com";
const ADMIN_SHOP = "quickstart-749ac396.myshopify.com";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const currentStore = await ensureStoreRecord(session.shop);

  // Grant admin access for sandeepptpss@gmail.com and quickstart-749ac396.myshopify.com
  const isAdmin =
    session.shop.toLowerCase().includes("quickstart-749ac396") ||
    currentStore.adminEmail === ADMIN_EMAIL ||
    session.shop.toLowerCase() === ADMIN_SHOP.toLowerCase();

  // Fetch all stores overview for admin dashboard
  const stores = await prisma.store.findMany({
    include: {
      _count: {
        select: {
          products: true,
          issues: { where: { status: "OPEN" } },
          supportTickets: { where: { status: "OPEN" } },
        },
      },
    },
    orderBy: { installedAt: "desc" },
  });

  // Calculate plan distribution & metrics
  let freeCount = 0;
  let growthCount = 0;
  let proCount = 0;

  stores.forEach((st) => {
    const p = (st.plan || "free").toLowerCase();
    if (p === "growth") growthCount++;
    else if (p === "pro") proCount++;
    else freeCount++;
  });

  const estimatedMRR = growthCount * 19 + proCount * 49;

  // Support Tickets
  const supportTickets = await prisma.supportTicket.findMany({
    include: {
      store: { select: { shopDomain: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return {
    isAdmin,
    currentStore,
    stores,
    freeCount,
    growthCount,
    proCount,
    estimatedMRR,
    supportTickets,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "TOGGLE_TICKET_STATUS") {
    const ticketId = formData.get("ticketId");
    if (ticketId) {
      const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
      if (ticket) {
        await prisma.supportTicket.update({
          where: { id: ticketId },
          data: { status: ticket.status === "OPEN" ? "RESOLVED" : "OPEN" },
        });
      }
    }
    return { success: true };
  }

  if (actionType === "UPDATE_MERCHANT_PLAN") {
    const storeId = formData.get("storeId");
    const newPlan = formData.get("newPlan");
    if (storeId && newPlan) {
      await prisma.store.update({
        where: { id: storeId },
        data: { plan: newPlan.toLowerCase() },
      });
    }
    return { success: true };
  }

  return { success: false };
};

export default function AdminDashboard() {
  const {
    isAdmin,
    currentStore,
    stores,
    freeCount,
    growthCount,
    proCount,
    estimatedMRR,
    supportTickets,
  } = useLoaderData();

  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const [selectedTicket, setSelectedTicket] = useState(null);

  const handleToggleTicketStatus = (ticketId) => {
    submit({ actionType: "TOGGLE_TICKET_STATUS", ticketId }, { method: "post" });
  };

  const handleUpdateStorePlan = (storeId, newPlan) => {
    submit({ actionType: "UPDATE_MERCHANT_PLAN", storeId, newPlan }, { method: "post" });
  };

  // Merchant Subscription Table Rows
  const merchantRows = stores.map((st) => [
    <BlockStack key={`domain-${st.id}`} gap="1">
      <Text variant="bodyMd" fontWeight="bold">
        {st.shopDomain}
      </Text>
      <Text variant="bodySm" tone="subdued">
        ID: {st.id.substring(0, 8)}...
      </Text>
    </BlockStack>,
    <Badge
      key={`plan-${st.id}`}
      tone={
        st.plan.toLowerCase() === "pro"
          ? "success"
          : st.plan.toLowerCase() === "growth"
          ? "highlight"
          : "subdued"
      }
    >
      {st.plan.toUpperCase()}
    </Badge>,
    <Text key={`score-${st.id}`} variant="bodyMd" fontWeight="bold">
      {st.healthScore.toFixed(1)}%
    </Text>,
    <Text key={`prods-${st.id}`} variant="bodyMd">
      {st._count.products}
    </Text>,
    <Text
      key={`issues-${st.id}`}
      variant="bodyMd"
      tone={st._count.issues > 0 ? "critical" : "success"}
    >
      {st._count.issues}
    </Text>,
    <Text key={`date-${st.id}`} variant="bodySm">
      {new Date(st.installedAt).toLocaleDateString()}
    </Text>,
    <InlineStack key={`act-${st.id}`} gap="2">
      {st.plan.toLowerCase() !== "pro" ? (
        <Button
          size="micro"
          tone="success"
          onClick={() => handleUpdateStorePlan(st.id, "pro")}
        >
          Upgrade Pro
        </Button>
      ) : (
        <Button
          size="micro"
          onClick={() => handleUpdateStorePlan(st.id, "free")}
        >
          Set Free
        </Button>
      )}
    </InlineStack>,
  ]);

  // Support Ticket Rows
  const ticketRows = supportTickets.map((t) => [
    <Badge
      key={`stat-${t.id}`}
      tone={t.status === "OPEN" ? "attention" : "success"}
    >
      {t.status}
    </Badge>,
    <Text key={`shop-${t.id}`} variant="bodySm" fontWeight="bold">
      {t.store?.shopDomain || "Unknown Store"}
    </Text>,
    <BlockStack key={`sub-${t.id}`} gap="1">
      <Text variant="bodyMd" fontWeight="bold">
        {t.subject}
      </Text>
      <Text variant="bodySm" tone="subdued">
        {t.message}
      </Text>
    </BlockStack>,
    <Text key={`email-${t.id}`} variant="bodySm">
      {t.merchantEmail}
    </Text>,
    <Text key={`time-${t.id}`} variant="bodySm">
      {new Date(t.createdAt).toLocaleString()}
    </Text>,
    <InlineStack key={`act-${t.id}`} gap="2">
      <Button size="micro" onClick={() => handleToggleTicketStatus(t.id)}>
        {t.status === "OPEN" ? "Mark Resolved" : "Reopen"}
      </Button>
      <Button
        size="micro"
        icon={EmailIcon}
        url={`mailto:${t.merchantEmail}?subject=Re: ${encodeURIComponent(t.subject)}`}
      >
        Reply Email
      </Button>
    </InlineStack>,
  ]);

  return (
    <Page
      title="App Admin Overview & Subscription Portal"
      subtitle={`Admin Access Granted to ${ADMIN_EMAIL} for ${ADMIN_SHOP}`}
    >
      <BlockStack gap="5">
        {/* Admin Access Status Banner */}
        <Banner title="Admin Access Verification & Permissions" tone="info">
          <p>
            Admin access privileges are active for <strong>{ADMIN_EMAIL}</strong> and store <strong>{ADMIN_SHOP}</strong>. You have complete visibility over merchant subscriptions, plan distributions, pricing models, and merchant support tickets.
          </p>
        </Banner>

        {/* Plan Breakdown Stat Cards */}
        <Grid>
          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="2">
                <Text variant="bodySm" tone="subdued">
                  Total Installed Merchants
                </Text>
                <Text variant="heading2xl" as="p" fontWeight="bold">
                  {stores.length}
                </Text>
                <Text variant="bodySm" tone="success">
                  Active Stores
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="2">
                <Text variant="bodySm" tone="subdued">
                  Free Tier Merchants
                </Text>
                <Text variant="heading2xl" as="p" fontWeight="bold">
                  {freeCount}
                </Text>
                <Text variant="bodySm" tone="subdued">
                  $0/month subscribers
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="2">
                <Text variant="bodySm" tone="subdued">
                  Growth & Pro Merchants
                </Text>
                <Text variant="heading2xl" as="p" fontWeight="bold" tone="highlight">
                  {growthCount + proCount}
                </Text>
                <Text variant="bodySm" tone="subdued">
                  {growthCount} Growth | {proCount} Pro
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="2">
                <Text variant="bodySm" tone="subdued">
                  Estimated Monthly Revenue
                </Text>
                <Text variant="heading2xl" as="p" fontWeight="bold" tone="success">
                  ${estimatedMRR}
                </Text>
                <Text variant="bodySm" tone="subdued">
                  Recurring MRR
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>
        </Grid>

        {/* Pricing Plans Overview Table */}
        <Card padding="0">
          <Box padding="400">
            <Text variant="headingMd" as="h3">
              Available Plans Details & Pricing Matrix
            </Text>
          </Box>
          <Divider />
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text"]}
            headings={["Plan Name", "Pricing", "Product Audit Limit", "Active Subscribers", "Key Features"]}
            rows={[
              [
                <Text key="f1" fontWeight="bold">Free Tier</Text>,
                "$0 / month",
                "Up to 250 Products",
                `${freeCount} Merchants`,
                "Basic image & SKU validation, weekly manual scan",
              ],
              [
                <Text key="f2" fontWeight="bold">Growth Plan</Text>,
                "$19 / month",
                "Up to 2,500 Products",
                `${growthCount} Merchants`,
                "Daily auto scans, metafield checks, priority email support",
              ],
              [
                <Text key="f3" fontWeight="bold">Pro Enterprise</Text>,
                "$49 / month",
                "Unlimited Products",
                `${proCount} Merchants`,
                "Custom priority builder, auto-fix safety layer, 24/7 support",
              ],
            ]}
          />
        </Card>

        {/* Merchant Subscriptions Table */}
        <Card padding="0">
          <Box padding="400">
            <InlineStack align="space-between">
              <Text variant="headingMd" as="h3">
                Merchant Subscription Directory ({stores.length})
              </Text>
              <Text variant="bodySm" tone="subdued">
                Manage merchant plan allocations & status
              </Text>
            </InlineStack>
          </Box>
          <Divider />
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
            headings={["Store Domain", "Active Plan", "Health Score", "Products", "Open Issues", "Installed Date", "Actions"]}
            rows={merchantRows}
          />
        </Card>

        {/* Merchant Support Inbox */}
        <Card padding="0">
          <Box padding="400">
            <InlineStack align="space-between">
              <Text variant="headingMd" as="h3">
                Merchant Support Inbox & Ticket Queue ({supportTickets.length})
              </Text>
              <Button size="micro" icon={EmailIcon} url={`mailto:${ADMIN_EMAIL}`}>
                Open Inbox ({ADMIN_EMAIL})
              </Button>
            </InlineStack>
          </Box>
          <Divider />
          {supportTickets.length === 0 ? (
            <Box padding="600" align="center">
              <BlockStack align="center" inlineAlign="center" gap="2">
                <CheckCircleIcon tone="success" />
                <Text variant="headingSm">No open support tickets!</Text>
                <Text variant="bodySm" tone="subdued">
                  All merchant support inquiries have been handled.
                </Text>
              </BlockStack>
            </Box>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text", "text"]}
              headings={["Status", "Store Domain", "Subject & Message", "Merchant Email", "Created At", "Actions"]}
              rows={ticketRows}
            />
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
