-- Migration: feature multi-repos/projects + guild scopes/modules
-- Run against existing DB: mysql -u user -p database < bot/src/Database/migrations/001_feature_multi_repos_scopes_modules.sql
-- Idempotent: uses CREATE TABLE IF NOT EXISTS.

-- Feature <-> Repository (many-to-many)
CREATE TABLE IF NOT EXISTS feature_repositories (
  feature_id VARCHAR(36) NOT NULL,
  repository_id VARCHAR(36) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (feature_id, repository_id),
  FOREIGN KEY (feature_id) REFERENCES Feature(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES Repository(id) ON DELETE CASCADE
);

-- Feature <-> ProjectSchema (many-to-many)
CREATE TABLE IF NOT EXISTS feature_project_schemas (
  feature_id VARCHAR(36) NOT NULL,
  project_schema_id VARCHAR(36) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (feature_id, project_schema_id),
  FOREIGN KEY (feature_id) REFERENCES Feature(id) ON DELETE CASCADE,
  FOREIGN KEY (project_schema_id) REFERENCES ProjectSchema(id) ON DELETE CASCADE
);

-- Guild-defined scope list (for feature Task.scope)
CREATE TABLE IF NOT EXISTS guild_scopes (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY (guildConfigId, name),
  KEY (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

-- Guild-defined module list (for feature Task.modules)
CREATE TABLE IF NOT EXISTS guild_modules (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY (guildConfigId, name),
  KEY (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);
