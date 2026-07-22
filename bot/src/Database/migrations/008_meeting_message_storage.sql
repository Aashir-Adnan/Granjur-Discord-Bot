-- Migration: Add explicit meeting message storage for dedicated meeting text channels
-- Run on existing databases that already have the earlier meeting tables

CREATE TABLE IF NOT EXISTS `meetingmessage` (
  `id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `guildConfigId` varchar(36) COLLATE utf8mb4_general_ci NOT NULL,
  `meetingId` varchar(36) COLLATE utf8mb4_general_ci NOT NULL,
  `channelId` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `authorId` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `authorTag` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `content` text COLLATE utf8mb4_general_ci,
  `attachmentUrls` json DEFAULT ('[]'),
  `createdAt` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `guildConfigId` (`guildConfigId`),
  KEY `meetingId` (`meetingId`),
  KEY `channelId` (`channelId`),
  KEY `authorId` (`authorId`),
  CONSTRAINT `meetingmessage_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE,
  CONSTRAINT `meetingmessage_ibfk_2` FOREIGN KEY (`meetingId`) REFERENCES `meeting` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
