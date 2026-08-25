/**
 * Plan Feature & Limit Configuration Engine
 *
 * Centralized feature gating and product audit limits per subscription tier.
 * Every gate in the app reads from here, so a feature advertised on the Plans
 * page has exactly one definition of who gets it.
 *
 * `Store.plan` holds the canonical id (free | growth | pro | enterprise). Older
 * builds of the Plans/Admin pages wrote display names ("Pro Enterprise") into
 * that column, and an unrecognised value used to fall through to the free tier
 * silently - a paying merchant losing every gated feature with no error. Reads
 * now go through `normalizePlanId`, which resolves those legacy spellings and
 * logs anything it still cannot place.
 */

export const PLAN_IDS = ["free", "growth", "pro", "enterprise"];

export const PLAN_CONFIG = {
  free: {
    id: "free",
    name: "Starter Free",
    price: "$0",
    priceAmount: 0,
    maxProducts: 50,
    maxProductsLabel: "50 products",
    manualScansPerWeek: 1,
    dailyScan: false,
    webhookScan: false,
    duplicateSku: false,
    customRules: false,
    requiredMetafields: false,
    barcodeAudit: true,
    autoFix: false,
    emailAlerts: false,
    instantCriticalAlerts: false,
    multiLocation: false,
    supportSla: "48 Hours (Community Support)",
  },
  growth: {
    id: "growth",
    name: "Growth Plan",
    price: "$9.99",
    priceAmount: 9.99,
    maxProducts: 1000,
    maxProductsLabel: "1,000 products",
    manualScansPerWeek: 7,
    dailyScan: true,
    webhookScan: false,
    duplicateSku: true,
    customRules: false,
    requiredMetafields: false,
    barcodeAudit: true,
    autoFix: false,
    emailAlerts: true,
    instantCriticalAlerts: false,
    multiLocation: false,
    supportSla: "24 Hours (Priority Email Support)",
  },
  pro: {
    id: "pro",
    name: "Pro Advanced",
    price: "$24.99",
    priceAmount: 24.99,
    maxProducts: 10000,
    maxProductsLabel: "10,000 products",
    manualScansPerWeek: 30,
    dailyScan: true,
    webhookScan: true,
    duplicateSku: true,
    customRules: true,
    requiredMetafields: true,
    barcodeAudit: true,
    autoFix: false,
    emailAlerts: true,
    instantCriticalAlerts: true,
    multiLocation: false,
    supportSla: "4 Hours (Express Priority Support)",
  },
  enterprise: {
    id: "enterprise",
    name: "Plus Enterprise",
    price: "$49.99",
    priceAmount: 49.99,
    maxProducts: Infinity,
    maxProductsLabel: "Unlimited products",
    manualScansPerWeek: Infinity,
    dailyScan: true,
    webhookScan: true,
    duplicateSku: true,
    customRules: true,
    requiredMetafields: true,
    barcodeAudit: true,
    autoFix: true,
    emailAlerts: true,
    instantCriticalAlerts: true,
    multiLocation: true,
    supportSla: "1 Hour (VIP 1-on-1 Admin Support)",
  },
};

/**
 * Spellings that have reached `Store.plan` from earlier UIs, plus the display
 * names shown on the Plans page. Keys are lowercased and whitespace-collapsed.
 */
const PLAN_ALIASES = {
  "": "free",
  starter: "free",
  "starter free": "free",
  basic: "free",
  "growth plan": "growth",
  "pro advanced": "pro",
  advanced: "pro",
  plus: "enterprise",
  "plus enterprise": "enterprise",
  // The $49 tier was called "Pro Enterprise" (unlimited products + auto-fix)
  // before the four-tier split, so it maps to today's enterprise plan.
  "pro enterprise": "enterprise",
  "enterprise plus": "enterprise",
};

/** Feature key -> what it is called and the cheapest plan that includes it. */
export const FEATURE_REQUIREMENTS = {
  dailyScan: { label: "Automated daily catalog scans", minPlan: "growth" },
  duplicateSku: { label: "Duplicate SKU detection engine", minPlan: "growth" },
  emailAlerts: { label: "Email alert notifications", minPlan: "growth" },
  webhookScan: { label: "Real-time webhook instant scans", minPlan: "pro" },
  customRules: { label: "Custom validation rule builder", minPlan: "pro" },
  requiredMetafields: { label: "Required metafield audit & smart default config", minPlan: "pro" },
  barcodeAudit: { label: "Barcode audit", minPlan: "pro" },
  instantCriticalAlerts: { label: "Instant critical email alerts", minPlan: "pro" },
  autoFix: { label: "Smart & Custom Metafield Auto-Fix Resolution Engine", minPlan: "enterprise" },
  multiLocation: { label: "Multi-location catalog sync", minPlan: "enterprise" },
};

const warnedPlanValues = new Set();

/**
 * Resolve any stored/submitted plan value to a canonical plan id.
 * Returns null when the value cannot be placed, so callers can reject a bad
 * write instead of persisting it.
 */
export function normalizePlanId(plan) {
  if (plan === null || plan === undefined) return null;

  const cleaned = String(plan).trim().toLowerCase().replace(/[\s_-]+/g, " ");

  if (PLAN_CONFIG[cleaned]) return cleaned;
  if (PLAN_ALIASES[cleaned]) return PLAN_ALIASES[cleaned];

  return null;
}

export function getPlanConfig(plan) {
  const normalized = normalizePlanId(plan);

  if (!normalized) {
    // Falling back silently is what hid a mis-stored plan value; say so once
    // per distinct value so the store can be corrected.
    const key = String(plan);
    if (!warnedPlanValues.has(key)) {
      warnedPlanValues.add(key);
      console.warn(
        `[planEngine] unknown plan value ${JSON.stringify(plan)}; treating this store as the free tier`,
      );
    }
    return PLAN_CONFIG.free;
  }

  return PLAN_CONFIG[normalized];
}

export function canUseFeature(plan, featureKey) {
  const config = getPlanConfig(plan);
  return Boolean(config[featureKey]);
}

/** Merchant-facing "this needs a bigger plan" copy for a gated feature. */
export function featureUpgradeMessage(featureKey) {
  const requirement = FEATURE_REQUIREMENTS[featureKey];
  if (!requirement) return "This feature is not included in your current plan.";

  const required = PLAN_CONFIG[requirement.minPlan];
  const higher = PLAN_IDS.slice(PLAN_IDS.indexOf(requirement.minPlan) + 1).map(
    (id) => PLAN_CONFIG[id].name,
  );

  const plans = [`${required.name} (${required.price}/mo)`, ...higher].join(" or ");
  return `${requirement.label} requires the ${plans} plan.`;
}

/** Plan metadata that is safe to hand to the browser (no Infinity). */
export function serializablePlanConfig(plan) {
  const config = getPlanConfig(plan);
  return {
    ...config,
    maxProducts: Number.isFinite(config.maxProducts) ? config.maxProducts : null,
    manualScansPerWeek: Number.isFinite(config.manualScansPerWeek)
      ? config.manualScansPerWeek
      : null,
  };
}

/**
 * Calculates annual pricing, monthly equivalent cost, and total annual savings
 * dynamically based on the monthly price and a custom discount percentage.
 *
 * @param {number} monthlyPriceAmount - Base monthly cost in USD e.g. 19.99
 * @param {number} [discountPercent=20] - Admin configured discount e.g. 20 (20%)
 */
export function calculateYearlyPricing(monthlyPriceAmount, discountPercent = 20) {
  const discount = Math.max(0, Math.min(100, Number(discountPercent) || 0));
  if (monthlyPriceAmount <= 0) {
    return {
      discountPercent: discount,
      yearlyTotalAmount: 0,
      yearlyTotalFormatted: "$0",
      monthlyEquivalentAmount: 0,
      monthlyEquivalentFormatted: "$0",
      savingsAmount: 0,
      savingsFormatted: "$0",
      savingsLabel: "Free Tier",
    };
  }

  const annualWithoutDiscount = monthlyPriceAmount * 12;
  const annualWithDiscount = annualWithoutDiscount * (1 - discount / 100);
  const monthlyEquivalent = annualWithDiscount / 12;
  const savings = annualWithoutDiscount - annualWithDiscount;

  return {
    discountPercent: discount,
    yearlyTotalAmount: Math.round(annualWithDiscount * 100) / 100,
    yearlyTotalFormatted: `$${(Math.round(annualWithDiscount * 100) / 100).toFixed(2)}`,
    monthlyEquivalentAmount: Math.round(monthlyEquivalent * 100) / 100,
    monthlyEquivalentFormatted: `$${(Math.round(monthlyEquivalent * 100) / 100).toFixed(2)}`,
    savingsAmount: Math.round(savings * 100) / 100,
    savingsFormatted: `$${(Math.round(savings * 100) / 100).toFixed(2)}`,
    savingsLabel: discount > 0 ? `Save $${savings.toFixed(2)}/yr (${discount}% OFF)` : "No discount",
  };
}

/**
 * Returns dynamic plan definitions for UI rendering with monthly & yearly pricing.
 * @param {number} [discountPercent=20]
 */
export function getPlanTiersWithDiscount(discountPercent = 20) {
  return PLAN_IDS.map((id) => {
    const baseConfig = PLAN_CONFIG[id];
    const yearlyInfo = calculateYearlyPricing(baseConfig.priceAmount, discountPercent);

    return {
      ...baseConfig,
      yearly: yearlyInfo,
    };
  });
}

