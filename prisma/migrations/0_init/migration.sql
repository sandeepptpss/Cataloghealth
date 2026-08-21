-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(255) NOT NULL,
    `shop` VARCHAR(255) NOT NULL,
    `state` VARCHAR(255) NOT NULL,
    `isOnline` BOOLEAN NOT NULL DEFAULT false,
    `scope` TEXT NULL,
    `expires` DATETIME(3) NULL,
    `accessToken` TEXT NOT NULL,
    `userId` BIGINT NULL,
    `firstName` VARCHAR(255) NULL,
    `lastName` VARCHAR(255) NULL,
    `email` VARCHAR(255) NULL,
    `accountOwner` BOOLEAN NOT NULL DEFAULT false,
    `locale` VARCHAR(100) NULL,
    `collaborator` BOOLEAN NULL DEFAULT false,
    `emailVerified` BOOLEAN NULL DEFAULT false,
    `refreshToken` TEXT NULL,
    `refreshTokenExpires` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Store` (
    `id` VARCHAR(64) NOT NULL,
    `shopDomain` VARCHAR(191) NOT NULL,
    `shopifyStoreId` VARCHAR(191) NULL,
    `plan` VARCHAR(100) NOT NULL DEFAULT 'free',
    `status` VARCHAR(50) NOT NULL DEFAULT 'active',
    `healthScore` DOUBLE NOT NULL DEFAULT 100.0,
    `installedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Store_shopDomain_key`(`shopDomain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Product` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(64) NOT NULL,
    `shopifyProductId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `handle` VARCHAR(255) NOT NULL,
    `bodyHtml` TEXT NULL,
    `vendor` VARCHAR(255) NULL,
    `productType` VARCHAR(255) NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    `imagesCount` INTEGER NOT NULL DEFAULT 0,
    `healthScore` DOUBLE NOT NULL DEFAULT 100.0,
    `hasIssues` BOOLEAN NOT NULL DEFAULT false,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Product_storeId_status_idx`(`storeId`, `status`),
    UNIQUE INDEX `Product_storeId_shopifyProductId_key`(`storeId`, `shopifyProductId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Variant` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `shopifyVariantId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `sku` VARCHAR(191) NULL,
    `normalizedSku` VARCHAR(191) NULL,
    `barcode` VARCHAR(191) NULL,
    `price` DOUBLE NOT NULL DEFAULT 0.0,
    `compareAtPrice` DOUBLE NULL,
    `inventoryQuantity` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Variant_storeId_normalizedSku_idx`(`storeId`, `normalizedSku`),
    UNIQUE INDEX `Variant_storeId_shopifyVariantId_key`(`storeId`, `shopifyVariantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Metafield` (
    `id` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `namespace` VARCHAR(64) NOT NULL,
    `key` VARCHAR(64) NOT NULL,
    `value` TEXT NULL,
    `valueType` VARCHAR(50) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Metafield_productId_namespace_key_key`(`productId`, `namespace`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ValidationRule` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `isEnabled` BOOLEAN NOT NULL DEFAULT true,
    `scopeType` VARCHAR(50) NOT NULL DEFAULT 'ALL',
    `scopeValue` VARCHAR(255) NULL,
    `requiredMetafields` TEXT NULL,
    `minImages` INTEGER NOT NULL DEFAULT 1,
    `checkPrices` BOOLEAN NOT NULL DEFAULT true,
    `checkSku` BOOLEAN NOT NULL DEFAULT true,
    `checkBarcode` BOOLEAN NOT NULL DEFAULT false,
    `checkDescription` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Issue` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `variantId` VARCHAR(64) NULL,
    `ruleId` VARCHAR(64) NULL,
    `issueType` VARCHAR(64) NOT NULL,
    `fieldName` VARCHAR(64) NOT NULL DEFAULT '',
    `severity` ENUM('CRITICAL', 'WARNING', 'INFO') NOT NULL DEFAULT 'WARNING',
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NOT NULL,
    `status` ENUM('OPEN', 'RESOLVED', 'IGNORED') NOT NULL DEFAULT 'OPEN',
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt` DATETIME(3) NULL,
    `ignoredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Issue_storeId_status_idx`(`storeId`, `status`),
    INDEX `Issue_storeId_severity_idx`(`storeId`, `severity`),
    UNIQUE INDEX `Issue_storeId_productId_issueType_fieldName_variantId_key`(`storeId`, `productId`, `issueType`, `fieldName`, `variantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IssueHistory` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(64) NOT NULL,
    `issueId` VARCHAR(64) NOT NULL,
    `previousStatus` ENUM('OPEN', 'RESOLVED', 'IGNORED') NOT NULL,
    `newStatus` ENUM('OPEN', 'RESOLVED', 'IGNORED') NOT NULL,
    `changeReason` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CatalogScan` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(64) NOT NULL,
    `scanType` ENUM('INITIAL', 'FULL', 'SCHEDULED', 'WEBHOOK', 'MANUAL') NOT NULL DEFAULT 'MANUAL',
    `status` ENUM('QUEUED', 'IN_PROGRESS', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `totalProducts` INTEGER NOT NULL DEFAULT 0,
    `processedProducts` INTEGER NOT NULL DEFAULT 0,
    `failedProducts` INTEGER NOT NULL DEFAULT 0,
    `lastCursor` VARCHAR(255) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SkuIndex` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(64) NOT NULL,
    `normalizedSku` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `variantId` VARCHAR(64) NOT NULL,
    `shopifyVariantId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SkuIndex_storeId_normalizedSku_idx`(`storeId`, `normalizedSku`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebhookEvent` (
    `id` VARCHAR(64) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `topic` VARCHAR(100) NOT NULL,
    `storeId` VARCHAR(64) NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'RECEIVED',
    `payload` TEXT NULL,
    `processedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `WebhookEvent_eventId_key`(`eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ScanJob` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(64) NOT NULL,
    `jobType` VARCHAR(50) NOT NULL,
    `scanType` ENUM('INITIAL', 'FULL', 'SCHEDULED', 'WEBHOOK', 'MANUAL') NOT NULL DEFAULT 'WEBHOOK',
    `priority` INTEGER NOT NULL DEFAULT 4,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `shopifyProductId` VARCHAR(191) NULL,
    `runAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `lastError` TEXT NULL,
    `lockToken` VARCHAR(64) NULL,
    `lockedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ScanJob_status_runAt_priority_idx`(`status`, `runAt`, `priority`),
    INDEX `ScanJob_storeId_jobType_status_idx`(`storeId`, `jobType`, `status`),
    INDEX `ScanJob_lockToken_idx`(`lockToken`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Product` ADD CONSTRAINT `Product_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `Store`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Variant` ADD CONSTRAINT `Variant_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `Store`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Variant` ADD CONSTRAINT `Variant_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Metafield` ADD CONSTRAINT `Metafield_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ValidationRule` ADD CONSTRAINT `ValidationRule_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `Store`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Issue` ADD CONSTRAINT `Issue_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `Store`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Issue` ADD CONSTRAINT `Issue_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Issue` ADD CONSTRAINT `Issue_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `Variant`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Issue` ADD CONSTRAINT `Issue_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `ValidationRule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `IssueHistory` ADD CONSTRAINT `IssueHistory_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `Store`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `IssueHistory` ADD CONSTRAINT `IssueHistory_issueId_fkey` FOREIGN KEY (`issueId`) REFERENCES `Issue`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CatalogScan` ADD CONSTRAINT `CatalogScan_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `Store`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SkuIndex` ADD CONSTRAINT `SkuIndex_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `Store`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SkuIndex` ADD CONSTRAINT `SkuIndex_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SkuIndex` ADD CONSTRAINT `SkuIndex_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `Variant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WebhookEvent` ADD CONSTRAINT `WebhookEvent_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `Store`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ScanJob` ADD CONSTRAINT `ScanJob_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `Store`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

