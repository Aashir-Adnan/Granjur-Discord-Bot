-- Migration: Create meeting record tables for audio recording storage
-- Purpose: Store individual user recordings from voice channels and meeting recording status
-- Note: These tables are also defined in schema.sql; this migration adds them if creating from existing DB

CREATE TABLE IF NOT EXISTS `MeetingRecordingStatus` (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  meetingId VARCHAR(36) NOT NULL UNIQUE,
  status VARCHAR(32) NOT NULL DEFAULT 'idle',
  voiceChannelId VARCHAR(64),
  startedAt DATETIME(3),
  endedAt DATETIME(3),
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY (guildConfigId),
  KEY (meetingId),
  FOREIGN KEY (guildConfigId) REFERENCES guildconfig(id) ON DELETE CASCADE,
  FOREIGN KEY (meetingId) REFERENCES meeting(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS `MeetingRecording` (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  meetingId VARCHAR(36) NOT NULL,
  memberId VARCHAR(64) NOT NULL,
  filePath VARCHAR(1024) NOT NULL,
  fileName VARCHAR(255) NOT NULL,
  audioFormat VARCHAR(32) NOT NULL DEFAULT 'opus',
  startedAt DATETIME(3),
  endedAt DATETIME(3),
  durationSeconds INT DEFAULT 0,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  KEY (guildConfigId),
  KEY (meetingId),
  KEY (memberId),
  FOREIGN KEY (guildConfigId) REFERENCES guildconfig(id) ON DELETE CASCADE,
  FOREIGN KEY (meetingId) REFERENCES meeting(id) ON DELETE CASCADE
);