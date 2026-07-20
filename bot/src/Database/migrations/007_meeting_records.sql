-- Migration: Create meeting record tables for audio recording storage
-- Purpose: Store individual user recordings from voice channels and meeting recording status

CREATE TABLE IF NOT EXISTS `meetingrecording` (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) COLLATE utf8mb4_general_ci NOT NULL,
  meetingId VARCHAR(36) NOT NULL,
  memberId VARCHAR(64) NOT NULL,
  filePath VARCHAR(512),
  fileName VARCHAR(255),
  audioFormat VARCHAR(32) DEFAULT 'opus',
  startedAt DATETIME(3),
  endedAt DATETIME(3),
  durationSeconds INT DEFAULT 0,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY (guildConfigId),
  KEY (meetingId),
  KEY (memberId),
  KEY (createdAt),
  CONSTRAINT fk_meetingrecording_guildconfig FOREIGN KEY (guildConfigId) REFERENCES guildconfig(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS `meetingrecordingstatus` (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) COLLATE utf8mb4_general_ci NOT NULL,
  meetingId VARCHAR(36) NOT NULL,
  status VARCHAR(32) DEFAULT 'idle',
  voiceChannelId VARCHAR(64),
  startedAt DATETIME(3),
  endedAt DATETIME(3),
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY (meetingId),
  KEY (guildConfigId),
  KEY (status),
  CONSTRAINT fk_meetingrecordingstatus_guildconfig FOREIGN KEY (guildConfigId) REFERENCES guildconfig(id) ON DELETE CASCADE
);