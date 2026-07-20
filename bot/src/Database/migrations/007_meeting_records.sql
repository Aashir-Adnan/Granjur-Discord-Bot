-- Migration: Create meeting record tables for audio recording storage
-- Purpose: Store individual user recordings from voice channels and meeting recording status

CREATE TABLE IF NOT EXISTS `meetingrecording` (
  `id` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
  `guildConfigId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `meetingId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `memberId` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `filePath` VARCHAR(512),
  `fileName` VARCHAR(255),
  `audioFormat` VARCHAR(32) DEFAULT 'opus',
  `startedAt` DATETIME(3),
  `endedAt` DATETIME(3),
  `durationSeconds` INT DEFAULT 0,
  `createdAt` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY `idx_guildConfigId` (`guildConfigId`),
  KEY `idx_meetingId` (`meetingId`),
  KEY `idx_memberId` (`memberId`),
  KEY `idx_createdAt` (`createdAt`),
  CONSTRAINT `meetingrecording_fk_guild` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `meetingrecordingstatus` (
  `id` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
  `guildConfigId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `meetingId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL UNIQUE,
  `status` VARCHAR(32) DEFAULT 'idle',
  `voiceChannelId` VARCHAR(64),
  `startedAt` DATETIME(3),
  `endedAt` DATETIME(3),
  `createdAt` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY `idx_guildConfigId` (`guildConfigId`),
  KEY `idx_status` (`status`),
  CONSTRAINT `meetingrecordingstatus_fk_guild` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
