-- Migration: guild_assignable_roles for backlog role multiselect + add role
-- Idempotent: uses CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS guild_assignable_roles (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY (guildConfigId, name),
  KEY (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);
