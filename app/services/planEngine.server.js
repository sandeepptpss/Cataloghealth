/**
 * Plan Feature & Limit Configuration Engine
 * 
 * Centralized feature gating and product audit limits per subscription tier.
 */

export const PLAN_CONFIG = {
  free: {
    id: "free",
    name: "Starter Free",
    price: "$0",
    maxProducts: 250,
    dailyScan: false,
    webhookScan: false,
    customRules: false,
    requiredMetafields: false,
    barcodeAudit: false,
    autoFix: false,
  },
  growth: {
    id: "growth",
    name: "Growth Plan",
    price: "$9",
    maxProducts: 2500,
    dailyScan: true,
    webhookScan: false,
    customRules: false,
    requiredMetafields: false,
    barcodeAudit: false,
    autoFix: false,
  },
  pro: {
    id: "pro",
    name: "Pro Advanced",
    price: "$29",
    maxProducts: 10000,
    dailyScan: true,
    webhookScan: true,
    customRules: true,
    requiredMetafields: true,
    barcodeAudit: true,
    autoFix: false,
  },
  enterprise: {
    id: "enterprise",
    name: "Plus Enterprise",
    price: "$49",
    maxProducts: Infinity,
    dailyScan: true,
    webhookScan: true,
    customRules: true,
    requiredMetafields: true,
    barcodeAudit: true,
    autoFix: true,
  },
};

export function getPlanConfig(plan) {
  const normalized = (plan || "free").toLowerCase();
  return PLAN_CONFIG[normalized] || PLAN_CONFIG.free;
}

export function canUseFeature(plan, featureKey) {
  const config = getPlanConfig(plan);
  return Boolean(config[featureKey]);
}
