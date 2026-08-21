-- Multi-location stock mirror (Plus Enterprise: Multi-Location Catalog Sync).
CREATE TABLE `InventoryLevel` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(64) NOT NULL,
    `variantId` VARCHAR(64) NOT NULL,
    `shopifyLocationId` VARCHAR(191) NOT NULL,
    `locationName` VARCHAR(255) NOT NULL DEFAULT '',
    `available` INTEGER NOT NULL DEFAULT 0,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `InventoryLevel_storeId_shopifyLocationId_idx`(`storeId`, `shopifyLocationId`),
    UNIQUE INDEX `InventoryLevel_variantId_shopifyLocationId_key`(`variantId`, `shopifyLocationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `InventoryLevel` ADD CONSTRAINT `InventoryLevel_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `Store`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `InventoryLevel` ADD CONSTRAINT `InventoryLevel_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `Variant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Opt-in multi-location stock check on a validation rule.
ALTER TABLE `ValidationRule` ADD COLUMN `checkInventory` BOOLEAN NOT NULL DEFAULT false;

-- Records that a scan stopped at the plan's product limit.
ALTER TABLE `CatalogScan` ADD COLUMN `planLimited` BOOLEAN NOT NULL DEFAULT false;

-- Address a notification was raised for.
ALTER TABLE `Notification` ADD COLUMN `recipient` VARCHAR(191) NULL;

-- Data fix: earlier UIs wrote plan display names into Store.plan, and any value
-- outside (free|growth|pro|enterprise) was silently treated as the free tier,
-- so paying stores lost every gated feature. Map the known spellings.
UPDATE `Store` SET `plan` = 'enterprise'
 WHERE LOWER(TRIM(`plan`)) IN ('pro enterprise', 'plus enterprise', 'enterprise plus', 'plus');
UPDATE `Store` SET `plan` = 'pro'
 WHERE LOWER(TRIM(`plan`)) IN ('pro advanced', 'advanced');
UPDATE `Store` SET `plan` = 'growth'
 WHERE LOWER(TRIM(`plan`)) IN ('growth plan');
UPDATE `Store` SET `plan` = 'free'
 WHERE LOWER(TRIM(`plan`)) IN ('', 'starter', 'starter free', 'basic');
