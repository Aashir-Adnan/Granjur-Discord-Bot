-- Migration: PendingInvite table (link invite code to email for /invite; used on member join to set GuildMember.email)
-- Run against existing DB. Idempotent: uses CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS PendingInvite (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  inviteCode VARCHAR(32) NOT NULL,
  email VARCHAR(255) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  KEY (guildConfigId),
  KEY (guildConfigId, inviteCode),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);
