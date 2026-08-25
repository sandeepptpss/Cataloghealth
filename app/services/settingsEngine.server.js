import prisma from "../db.server.js";

const SETTING_KEYS = {
  YEARLY_DISCOUNT_PERCENTAGE: "YEARLY_DISCOUNT_PERCENTAGE",
};

export const DEFAULT_YEARLY_DISCOUNT_PERCENT = 20;

/**
 * Get the global yearly discount percentage configured by admin.
 * @returns {Promise<number>} Discount percentage e.g. 20 for 20%
 */
export async function getYearlyDiscountPercentage() {
  try {
    const record = await prisma.globalSetting.findUnique({
      where: { key: SETTING_KEYS.YEARLY_DISCOUNT_PERCENTAGE },
    });

    if (!record || record.value === undefined || record.value === null) {
      return DEFAULT_YEARLY_DISCOUNT_PERCENT;
    }

    const parsed = parseFloat(record.value);
    if (isNaN(parsed) || parsed < 0 || parsed > 100) {
      return DEFAULT_YEARLY_DISCOUNT_PERCENT;
    }

    return parsed;
  } catch (error) {
    console.error("[settingsEngine] Failed to read yearly discount:", error);
    return DEFAULT_YEARLY_DISCOUNT_PERCENT;
  }
}

/**
 * Update the global yearly discount percentage in database.
 * @param {number|string} percentage - e.g. 25
 * @returns {Promise<{success: boolean, percentage: number, message?: string, error?: string}>}
 */
export async function setYearlyDiscountPercentage(percentage) {
  try {
    const parsed = parseFloat(percentage);
    if (isNaN(parsed) || parsed < 0 || parsed > 100) {
      return {
        success: false,
        error: "Discount percentage must be a valid number between 0% and 100%.",
      };
    }

    // Round to 2 decimal places max
    const rounded = Math.round(parsed * 100) / 100;

    await prisma.globalSetting.upsert({
      where: { key: SETTING_KEYS.YEARLY_DISCOUNT_PERCENTAGE },
      update: { value: String(rounded) },
      create: {
        key: SETTING_KEYS.YEARLY_DISCOUNT_PERCENTAGE,
        value: String(rounded),
      },
    });

    return {
      success: true,
      percentage: rounded,
      message: `Yearly subscription discount updated to ${rounded}%.`,
    };
  } catch (error) {
    console.error("[settingsEngine] Failed to save yearly discount:", error);
    return {
      success: false,
      error: `Could not save discount setting: ${error.message}`,
    };
  }
}

/**
 * Get all merchant-specific promotional offers from database.
 * @returns {Promise<Record<string, string>>} Mapping of storeId -> offerTag
 */
export async function getMerchantOffers() {
  try {
    const records = await prisma.globalSetting.findMany({
      where: {
        key: {
          startsWith: "MERCHANT_OFFER_",
        },
      },
    });

    const offers = {};
    records.forEach((rec) => {
      const storeId = rec.key.replace("MERCHANT_OFFER_", "");
      offers[storeId] = rec.value;
    });

    return offers;
  } catch (error) {
    console.error("[settingsEngine] Failed to read merchant offers:", error);
    return {};
  }
}

/**
 * Set or clear a merchant-specific promotional offer.
 * @param {string} storeId
 * @param {string} offerTag - e.g. "2 Months Free Pro", "3 Months Free Access", or "" to clear
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export async function setMerchantOffer(storeId, offerTag) {
  try {
    const settingKey = `MERCHANT_OFFER_${storeId}`;

    if (!offerTag || offerTag.trim() === "") {
      await prisma.globalSetting.deleteMany({
        where: { key: settingKey },
      });
      return {
        success: true,
        message: "Merchant promotional offer cleared.",
      };
    }

    const cleanTag = offerTag.trim();
    await prisma.globalSetting.upsert({
      where: { key: settingKey },
      update: { value: cleanTag },
      create: {
        key: settingKey,
        value: cleanTag,
      },
    });

    return {
      success: true,
      offerTag: cleanTag,
      message: `Merchant special offer "${cleanTag}" saved.`,
    };
  } catch (error) {
    console.error("[settingsEngine] Failed to save merchant offer:", error);
    return {
      success: false,
      error: `Could not save merchant offer: ${error.message}`,
    };
  }
}

