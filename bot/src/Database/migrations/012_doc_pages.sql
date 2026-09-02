-- Docs mirrored from the UBS-Doc repository, plus per-guild sync state.
-- Re-runnable: every statement is guarded on information_schema.

CREATE TABLE IF NOT EXISTS docpage (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  path VARCHAR(512) NOT NULL,
  docId VARCHAR(512) NOT NULL,
  section VARCHAR(128) NOT NULL,
  projectId VARCHAR(36) NULL,
  title VARCHAR(512) NOT NULL,
  content MEDIUMTEXT,
  source VARCHAR(16) NOT NULL DEFAULT 'repo',
  blobSha VARCHAR(64) NULL,
  size INT NOT NULL DEFAULT 0,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_docpage_path (guildConfigId, path),
  KEY idx_docpage_project (guildConfigId, projectId),
  KEY idx_docpage_section (guildConfigId, section),
  FULLTEXT KEY ft_docpage (title, content),
  FOREIGN KEY (guildConfigId) REFERENCES guildconfig(id) ON DELETE CASCADE,
  FOREIGN KEY (projectId) REFERENCES project(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS docsource (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  owner VARCHAR(255) NOT NULL,
  repo VARCHAR(255) NOT NULL,
  branch VARCHAR(255) NOT NULL DEFAULT 'main',
  siteUrl VARCHAR(512) NOT NULL,
  lastCommitSha VARCHAR(64) NULL,
  lastSyncedAt DATETIME(3) NULL,
  lastError TEXT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_docsource_guild (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES guildconfig(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

SET @c1 = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND COLUMN_NAME = 'docsSlug');
SET @s1 = IF(@c1 = 0, 'ALTER TABLE project ADD COLUMN docsSlug VARCHAR(128) NULL', 'SELECT 1');
PREPARE st1 FROM @s1;
EXECUTE st1;
DEALLOCATE PREPARE st1;

SET @c2 = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND COLUMN_NAME = 'docsPaths');
SET @s2 = IF(@c2 = 0, 'ALTER TABLE project ADD COLUMN docsPaths JSON NULL', 'SELECT 1');
PREPARE st2 FROM @s2;
EXECUTE st2;
DEALLOCATE PREPARE st2;

-- Default every project's docsSlug from its name, then attach the HMS
-- engineering tree to Badar HMS. Both are no-ops if the rows are absent.
UPDATE project
SET docsSlug = LOWER(REPLACE(TRIM(name), ' ', '-'))
WHERE docsSlug IS NULL;

UPDATE project
SET docsPaths = JSON_ARRAY('hms-documentation')
WHERE name = 'Badar HMS' AND (docsPaths IS NULL OR JSON_LENGTH(docsPaths) = 0);
