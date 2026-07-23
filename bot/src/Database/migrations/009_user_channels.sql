-- Migration: Track user-created channels (from /create-channel) so /cleanup skips them

CREATE TABLE IF NOT EXISTS `userchannel` (
  `id` varchar(36) COLLATE utf8mb4_general_ci NOT NULL,
  `guildConfigId` varchar(36) COLLATE utf8mb4_general_ci NOT NULL,
  `voiceChannelId` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `textChannelId` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `name` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `createdBy` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `memberIds` json DEFAULT ('[]'),
  `createdAt` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `guildConfigId` (`guildConfigId`),
  KEY `createdBy` (`createdBy`),
  CONSTRAINT `userchannel_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
