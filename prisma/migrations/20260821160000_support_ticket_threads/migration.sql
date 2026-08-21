-- SupportTicket.reply was added to some databases outside the migration history
-- (so `prisma migrate deploy` on a fresh database never created it). Add it only
-- where it is missing, which is what makes this migration safe on both.
SET @needsReply := (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SupportTicket' AND COLUMN_NAME = 'reply'
);
SET @sql := IF(@needsReply, 'ALTER TABLE `SupportTicket` ADD COLUMN `reply` TEXT NULL', 'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Conversation bookkeeping.
ALTER TABLE `SupportTicket`
  ADD COLUMN `planAtSubmission` VARCHAR(50) NULL,
  ADD COLUMN `repliedAt` DATETIME(3) NULL,
  ADD COLUMN `lastMessageAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

CREATE INDEX `SupportTicket_status_lastMessageAt_idx` ON `SupportTicket`(`status`, `lastMessageAt`);

-- Threaded messages so merchant and support can go back and forth.
CREATE TABLE `SupportMessage` (
    `id` VARCHAR(64) NOT NULL,
    `ticketId` VARCHAR(64) NOT NULL,
    `sender` ENUM('MERCHANT', 'ADMIN') NOT NULL,
    `body` TEXT NOT NULL,
    `authorEmail` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SupportMessage_ticketId_createdAt_idx`(`ticketId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SupportMessage` ADD CONSTRAINT `SupportMessage_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `SupportTicket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: existing tickets become the first message of their own thread, and
-- any stored admin reply becomes the second, so no history is lost.
INSERT INTO `SupportMessage` (`id`, `ticketId`, `sender`, `body`, `authorEmail`, `createdAt`)
SELECT UUID(), `id`, 'MERCHANT', `message`, `merchantEmail`, `createdAt` FROM `SupportTicket`;

INSERT INTO `SupportMessage` (`id`, `ticketId`, `sender`, `body`, `authorEmail`, `createdAt`)
SELECT UUID(), `id`, 'ADMIN', `reply`, NULL, `updatedAt`
  FROM `SupportTicket` WHERE `reply` IS NOT NULL AND TRIM(`reply`) <> '';

UPDATE `SupportTicket` SET `lastMessageAt` = `updatedAt`;
UPDATE `SupportTicket` SET `repliedAt` = `updatedAt` WHERE `reply` IS NOT NULL AND TRIM(`reply`) <> '';
