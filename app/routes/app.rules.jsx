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
  DataTable,
  Modal,
  FormLayout,
  TextField,
  Select,
  Checkbox,
  Banner,
} from "@shopify/polaris";
import { PlusIcon, DeleteIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { ensureStoreRecord } from "../services/syncEngine.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);

  const rules = await prisma.validationRule.findMany({
    where: { storeId: store.id },
    orderBy: { priority: "asc" },
  });

  return { store, rules };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStoreRecord(session.shop);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "TOGGLE_RULE") {
    const ruleId = formData.get("ruleId");
    // Scoped by storeId so one shop cannot toggle another shop's rule.
    const rule = await prisma.validationRule.findFirst({
      where: { id: ruleId, storeId: store.id },
    });
    if (rule) {
      await prisma.validationRule.update({
        where: { id: rule.id },
        data: { isEnabled: !rule.isEnabled },
      });
    }
    return { success: true };
  }

  if (actionType === "CREATE_RULE") {
    const name = (formData.get("name") || "").toString().trim();
    if (!name) {
      return { success: false, error: "Rule name is required." };
    }
    const description = formData.get("description") || "";
    const rawPriority = parseInt(formData.get("priority"), 10);
    const priority = Number.isFinite(rawPriority) ? Math.min(100, Math.max(1, rawPriority)) : 50;
    const scopeType = formData.get("scopeType") || "ALL";
    const scopeValue = (formData.get("scopeValue") || "").toString().trim();

    // A scoped rule with no target would silently match nothing.
    if (scopeType !== "ALL" && !scopeValue) {
      return { success: false, error: `A ${scopeType} rule needs a target value.` };
    }
    const rawMinImages = parseInt(formData.get("minImages"), 10);
    const minImages = Number.isFinite(rawMinImages) ? Math.max(0, rawMinImages) : 1;
    const requiredMetafields = formData.get("requiredMetafields") || "";

    const checkPrices = formData.get("checkPrices") === "true";
    const checkSku = formData.get("checkSku") === "true";
    const checkBarcode = formData.get("checkBarcode") === "true";
    const checkDescription = formData.get("checkDescription") === "true";

    await prisma.validationRule.create({
      data: {
        storeId: store.id,
        name,
        description,
        priority,
        scopeType,
        scopeValue,
        minImages,
        requiredMetafields,
        checkPrices,
        checkSku,
        checkBarcode,
        checkDescription,
        isEnabled: true,
      },
    });
    return { success: true };
  }

  if (actionType === "DELETE_RULE") {
    const ruleId = formData.get("ruleId");
    if (ruleId) {
      // deleteMany with a storeId filter is a no-op on someone else's rule.
      await prisma.validationRule.deleteMany({
        where: { id: ruleId, storeId: store.id },
      });
    }
    return { success: true };
  }

  return { success: false };
};

export default function ValidationRules() {
  const { rules } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const [modalActive, setModalActive] = useState(false);
  const [ruleName, setRuleName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("50");
  const [scopeType, setScopeType] = useState("ALL");
  const [scopeValue, setScopeValue] = useState("");
  const [minImages, setMinImages] = useState("1");
  const [requiredMetafields, setRequiredMetafields] = useState("");

  const [checkPrices, setCheckPrices] = useState(true);
  const [checkSku, setCheckSku] = useState(true);
  const [checkBarcode, setCheckBarcode] = useState(false);
  const [checkDescription, setCheckDescription] = useState(true);

  const handleToggleRule = (ruleId) => {
    submit({ actionType: "TOGGLE_RULE", ruleId }, { method: "post" });
  };

  const handleDeleteRule = (ruleId) => {
    submit({ actionType: "DELETE_RULE", ruleId }, { method: "post" });
  };

  const handleSaveRule = () => {
    submit(
      {
        actionType: "CREATE_RULE",
        name: ruleName,
        description,
        priority,
        scopeType,
        scopeValue,
        minImages,
        requiredMetafields,
        checkPrices: String(checkPrices),
        checkSku: String(checkSku),
        checkBarcode: String(checkBarcode),
        checkDescription: String(checkDescription),
      },
      { method: "post" }
    );
    setModalActive(false);
    resetForm();
  };

  const resetForm = () => {
    setRuleName("");
    setDescription("");
    setPriority("50");
    setScopeType("ALL");
    setScopeValue("");
    setMinImages("1");
    setRequiredMetafields("");
    setCheckPrices(true);
    setCheckSku(true);
    setCheckBarcode(false);
    setCheckDescription(true);
  };

  const rows = rules.map((rule) => [
    <Text key={`prio-${rule.id}`} variant="bodyMd" fontWeight="bold">
      #{rule.priority}
    </Text>,
    <BlockStack key={`name-${rule.id}`} gap="100">
      <Text variant="bodyMd" fontWeight="bold">
        {rule.name}
      </Text>
      <Text variant="bodySm" tone="subdued">
        {rule.description || "No description"}
      </Text>
    </BlockStack>,
    <Badge key={`scope-${rule.id}`} tone="info">
      {rule.scopeType} {rule.scopeValue ? `(${rule.scopeValue})` : ""}
    </Badge>,
    <Text key={`checks-${rule.id}`} variant="bodySm">
      Min Images: {rule.minImages} | Price: {rule.checkPrices ? "Yes" : "No"} | SKU:{" "}
      {rule.checkSku ? "Yes" : "No"} | Metafields: {rule.requiredMetafields || "None"}
    </Text>,
    <Badge key={`stat-${rule.id}`} tone={rule.isEnabled ? "success" : undefined}>
      {rule.isEnabled ? "Active" : "Disabled"}
    </Badge>,
    <InlineStack key={`act-${rule.id}`} gap="200">
      <Button size="micro" onClick={() => handleToggleRule(rule.id)}>
        {rule.isEnabled ? "Disable" : "Enable"}
      </Button>
      <Button
        size="micro"
        tone="critical"
        icon={DeleteIcon}
        accessibilityLabel={`Delete rule ${rule.name}`}
        onClick={() => handleDeleteRule(rule.id)}
      />
    </InlineStack>,
  ]);

  return (
    <Page
      fullWidth
      title="Validation Rules Engine"
      subtitle="Configure audit rules, priorities, and custom required fields"
      primaryAction={{
        content: "Add New Audit Rule",
        icon: PlusIcon,
        onClick: () => setModalActive(true),
      }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              <p>
                Validation rules are evaluated by priority (lower number = higher priority). Specific collection or vendor rules override global rules.
              </p>
            </Banner>

            <Card padding="0">
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                headings={["Priority", "Rule Name", "Scope", "Requirements", "Status", "Actions"]}
                rows={rows}
              />
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Modal for adding rule */}
      <Modal
        open={modalActive}
        onClose={() => setModalActive(false)}
        title="Create Custom Validation Rule"
        primaryAction={{
          content: "Save Rule",
          onClick: handleSaveRule,
          loading: isLoading,
          disabled: !ruleName.trim() || (scopeType !== "ALL" && !scopeValue.trim()),
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onClick: () => setModalActive(false),
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField
              label="Rule Name"
              value={ruleName}
              onChange={setRuleName}
              placeholder="e.g. Electronics Mandatory Metafields Rule"
              autoComplete="off"
            />
            <TextField
              label="Description"
              value={description}
              onChange={setDescription}
              placeholder="Explain the purpose of this audit rule"
              autoComplete="off"
            />
            <TextField
              label="Priority Number (Lower = Higher Priority)"
              type="number"
              value={priority}
              onChange={setPriority}
              autoComplete="off"
            />
            <Select
              label="Scope"
              options={[
                { label: "All Products (Global)", value: "ALL" },
                { label: "Collection Specific", value: "COLLECTION" },
                { label: "Vendor Specific", value: "VENDOR" },
                { label: "Product Type Specific", value: "PRODUCT_TYPE" },
              ]}
              value={scopeType}
              onChange={setScopeType}
            />
            {scopeType !== "ALL" && (
              <TextField
                label="Scope Target Value"
                value={scopeValue}
                onChange={setScopeValue}
                placeholder={
                  scopeType === "VENDOR"
                    ? "e.g. Apple"
                    : scopeType === "COLLECTION"
                    ? "Collection name or handle, e.g. Electronics"
                    : "e.g. Electronics"
                }
                helpText={
                  scopeType === "COLLECTION"
                    ? "Matches either the collection title or its handle."
                    : undefined
                }
                autoComplete="off"
              />
            )}
            <TextField
              label="Minimum Required Product Images"
              type="number"
              value={minImages}
              onChange={setMinImages}
              autoComplete="off"
            />
            <TextField
              label="Required Metafields (comma-separated namespace.key)"
              value={requiredMetafields}
              onChange={setRequiredMetafields}
              placeholder="e.g. global.gtin, specs.warranty"
              autoComplete="off"
            />
            <Text variant="headingSm" as="h4">
              Enabled Checks
            </Text>
            <Checkbox
              label="Validate Price (> 0)"
              checked={checkPrices}
              onChange={setCheckPrices}
            />
            <Checkbox
              label="Validate Variant SKU presence & uniqueness"
              checked={checkSku}
              onChange={setCheckSku}
            />
            <Checkbox
              label="Validate Product Description"
              checked={checkDescription}
              onChange={setCheckDescription}
            />
            <Checkbox
              label="Validate Variant Barcode"
              checked={checkBarcode}
              onChange={setCheckBarcode}
            />
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
