-- Schema for a BLANK database. Run once: mysql -u user -p database < bot/src/Database/schema.sql
-- Or: node bot/scripts/init-db.js (with DATABASE_URL set)
-- Then run migrations: npm run db:migrate
--
-- Design: guildId (Discord snowflake) is stored ONLY in GuildConfig. All other tables reference
-- the guild via guildConfigId FK to GuildConfig(id). No guildId column in any other table.

-- Tracks which migrations have been applied (used by run-migrations.js)
CREATE TABLE IF NOT EXISTS schema_migrations (
  name VARCHAR(255) PRIMARY KEY,
  run_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS GuildConfig (
  id VARCHAR(36) PRIMARY KEY,
  guildId VARCHAR(64) NOT NULL UNIQUE,
  onboardingChannelId VARCHAR(64),
  holdingRoleId VARCHAR(64),
  verifiedRoleId VARCHAR(64),
  adminChannelId VARCHAR(64),
  allowedDomains JSON DEFAULT ('["granjur.com"]'),
  dashboardRoleIds JSON DEFAULT ('[]'),
  seniorRoleIds JSON DEFAULT ('[]'),
  clockedInRoleId VARCHAR(64),
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS GuildMember (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  discordId VARCHAR(64) NOT NULL,
  email VARCHAR(255),
  verifiedAt DATETIME(3),
  status VARCHAR(32) DEFAULT 'pending',
  roleIds JSON DEFAULT ('[]'),
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY (guildConfigId, discordId),
  KEY (guildConfigId),
  KEY (email),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Repository (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  url VARCHAR(512) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY (guildConfigId, url),
  KEY (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

-- Task: unified bugs and features (is_bug / is_feature). No separate Feature/BugTicket tables.
CREATE TABLE IF NOT EXISTS Task (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  type VARCHAR(32) NOT NULL DEFAULT 'feature',
  is_bug TINYINT(1) NOT NULL DEFAULT 0,
  is_feature TINYINT(1) NOT NULL DEFAULT 0,
  title TEXT,
  description TEXT,
  status VARCHAR(32) DEFAULT 'open',
  createdBy VARCHAR(64),
  assigneeIds JSON DEFAULT ('[]'),
  taggedMemberIds JSON DEFAULT ('[]'),
  repositoryId VARCHAR(36),
  projectId VARCHAR(255),
  projectName VARCHAR(255),
  discordChannelId VARCHAR(64),
  discordThreadId VARCHAR(64),
  externalIssueUrl VARCHAR(512),
  externalIssueNumber INT,
  modules JSON DEFAULT ('[]'),
  handlerId VARCHAR(64),
  scope TEXT,
  implementationStatus VARCHAR(32),
  passedApiTests TINYINT(1),
  passedQaTests TINYINT(1),
  passedAcceptanceCriteria TINYINT(1),
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY (guildConfigId),
  KEY (type),
  KEY (is_bug),
  KEY (is_feature),
  KEY (status),
  KEY (discordChannelId),
  KEY (createdAt),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE,
  FOREIGN KEY (repositoryId) REFERENCES Repository(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS TicketDoc (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  ticketType VARCHAR(32) NOT NULL,
  taskId VARCHAR(36),
  title VARCHAR(512) NOT NULL,
  content TEXT,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY (guildConfigId),
  KEY (taskId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE,
  FOREIGN KEY (taskId) REFERENCES Task(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS BugTicketComment (
  id VARCHAR(36) PRIMARY KEY,
  taskId VARCHAR(36) NOT NULL,
  authorId VARCHAR(64) NOT NULL,
  authorTag VARCHAR(255),
  content TEXT NOT NULL,
  attachmentUrls JSON DEFAULT ('[]'),
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  KEY (taskId),
  FOREIGN KEY (taskId) REFERENCES Task(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS feature_repositories (
  task_id VARCHAR(36) NOT NULL,
  repository_id VARCHAR(36) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (task_id, repository_id),
  FOREIGN KEY (task_id) REFERENCES Task(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES Repository(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS feature_project_schemas (
  task_id VARCHAR(36) NOT NULL,
  project_schema_id VARCHAR(36) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (task_id, project_schema_id),
  FOREIGN KEY (task_id) REFERENCES Task(id) ON DELETE CASCADE,
  FOREIGN KEY (project_schema_id) REFERENCES ProjectSchema(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS guild_scopes (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY (guildConfigId, name),
  KEY (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS guild_modules (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY (guildConfigId, name),
  KEY (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

-- Assignable role names for backlog approval (per-guild; can add more)
CREATE TABLE IF NOT EXISTS guild_assignable_roles (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY (guildConfigId, name),
  KEY (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Meeting (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  channelId VARCHAR(64) NOT NULL,
  externalId VARCHAR(255),
  transcript TEXT,
  notes TEXT,
  projectId VARCHAR(255),
  repositoryUrl VARCHAR(512),
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS MeetingChannel (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  voiceChannelId VARCHAR(64) NOT NULL,
  textChannelId VARCHAR(64),
  meetingId VARCHAR(36) UNIQUE,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE,
  FOREIGN KEY (meetingId) REFERENCES Meeting(id)
);

CREATE TABLE IF NOT EXISTS ScheduledMeeting (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  topic TEXT NOT NULL,
  scheduledAt DATETIME(3) NOT NULL,
  memberIds JSON DEFAULT ('[]'),
  createdBy VARCHAR(64) NOT NULL,
  reminderSentAt DATETIME(3),
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY (guildConfigId),
  KEY (createdBy),
  KEY (scheduledAt),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ProjectSchema (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  projectId VARCHAR(255) NOT NULL,
  projectName VARCHAR(255),
  schemaContent TEXT NOT NULL,
  readme TEXT,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY (guildConfigId, projectId),
  KEY (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Faq (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  repositoryId VARCHAR(36),
  question TEXT NOT NULL,
  answer TEXT,
  askedBy VARCHAR(64) NOT NULL,
  answeredBy VARCHAR(64),
  answeredAt DATETIME(3),
  status VARCHAR(32) DEFAULT 'open',
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY (guildConfigId),
  KEY (repositoryId),
  KEY (status),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE,
  FOREIGN KEY (repositoryId) REFERENCES Repository(id)
);

CREATE TABLE IF NOT EXISTS VerificationToken (
  id VARCHAR(36) PRIMARY KEY,
  token VARCHAR(255) NOT NULL UNIQUE,
  guildConfigId VARCHAR(36) NOT NULL,
  discordId VARCHAR(64) NOT NULL,
  email VARCHAR(255) NOT NULL,
  expiresAt DATETIME(3) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  KEY (token),
  KEY (guildConfigId, discordId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS VerificationOtp (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  discordId VARCHAR(64) NOT NULL,
  email VARCHAR(255) NOT NULL,
  code VARCHAR(8) NOT NULL,
  expiresAt DATETIME(3) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  KEY (guildConfigId, discordId),
  KEY (email, code),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

-- Invites sent via /invite: used to set GuildMember.email when the user joins via that invite
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

CREATE TABLE IF NOT EXISTS email_log (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36),
  recipient_email VARCHAR(255) NOT NULL,
  subject VARCHAR(512),
  content TEXT,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  KEY (recipient_email),
  KEY (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS Project (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  readme TEXT,
  owner_emails JSON DEFAULT ('[]'),
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY (guildConfigId, name),
  KEY (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_schemas (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  latest_dump_id VARCHAR(36),
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY (project_id, name),
  KEY (project_id),
  FOREIGN KEY (project_id) REFERENCES Project(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dump_versions (
  id VARCHAR(36) PRIMARY KEY,
  project_schema_id VARCHAR(36) NOT NULL,
  content LONGTEXT NOT NULL,
  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  created_by VARCHAR(255),
  KEY (project_schema_id),
  FOREIGN KEY (project_schema_id) REFERENCES project_schemas(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_repos (
  project_id VARCHAR(36) NOT NULL,
  repository_id VARCHAR(36) NOT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (project_id, repository_id),
  FOREIGN KEY (project_id) REFERENCES Project(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES Repository(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ClockEntry (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  discordId VARCHAR(64) NOT NULL,
  clockInAt DATETIME(3) NOT NULL,
  clockOutAt DATETIME(3),
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  KEY (guildConfigId, discordId),
  KEY (clockInAt),
  FOREIGN KEY (guildConfigId) REFERENCES GuildConfig(id) ON DELETE CASCADE
);

-- Note: project_schemas.latest_dump_id logically references dump_versions(id). No FK to keep schema idempotent (re-runnable).
