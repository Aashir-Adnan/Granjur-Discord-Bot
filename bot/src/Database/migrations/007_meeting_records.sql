-- Migration: Create meeting record tables for audio recording storage
-- Purpose: Store individual user recordings from voice channels and meeting recording status
-- Note: These tables are also defined in schema.sql; this migration adds them if creating from existing DB

CREATE TABLE IF NOT EXISTS `MeetingRecordingStatus` (
  `id` varchar(36) COLLATE utf8mb4_general_ci NOT NULL,
  `guildConfigId` varchar(36) COLLATE utf8mb4_general_ci NOT NULL,
  `meetingId` varchar(36) COLLATE utf8mb4_general_ci NOT NULL,
  `status` varchar(32) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'idle',
  `voiceChannelId` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `startedAt` datetime(3) DEFAULT NULL,
  `endedAt` datetime(3) DEFAULT NULL,
  `createdAt` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `meetingId` (`meetingId`),
  KEY `guildConfigId` (`guildConfigId`),
  CONSTRAINT `meetingrecordingstatus_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE,
  CONSTRAINT `meetingrecordingstatus_ibfk_2` FOREIGN KEY (`meetingId`) REFERENCES `meeting` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `MeetingRecording` (
  `id` varchar(36) COLLATE utf8mb4_general_ci NOT NULL,
  `guildConfigId` varchar(36) COLLATE utf8mb4_general_ci NOT NULL,
  `meetingId` varchar(36) COLLATE utf8mb4_general_ci NOT NULL,
  `memberId` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `filePath` varchar(1024) COLLATE utf8mb4_general_ci NOT NULL,
  `fileName` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `audioFormat` varchar(32) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'opus',
  `startedAt` datetime(3) DEFAULT NULL,
  `endedAt` datetime(3) DEFAULT NULL,
  `durationSeconds` int DEFAULT 0,
  `createdAt` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `guildConfigId` (`guildConfigId`),
  KEY `meetingId` (`meetingId`),
  KEY `memberId` (`memberId`),
  CONSTRAINT `meetingrecording_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE,
  CONSTRAINT `meetingrecording_ibfk_2` FOREIGN KEY (`meetingId`) REFERENCES `meeting` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;