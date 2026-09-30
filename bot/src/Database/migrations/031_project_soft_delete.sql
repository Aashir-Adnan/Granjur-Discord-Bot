-- project.deletedAt / deletedBy: a soft-delete marker (2026-10-01; spec
-- docs/superpowers/specs/ soft-deleting and reactivating a project). A deleted
-- project and its tasks are hidden by default; no row is ever removed. NULL
-- deletedAt means active, so every existing project stays active. Guarded so the
-- file can run twice.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND COLUMN_NAME = 'deletedAt');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE project ADD COLUMN deletedAt DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND COLUMN_NAME = 'deletedBy');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE project ADD COLUMN deletedBy VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND INDEX_NAME = 'idx_project_guild_deleted');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE project ADD KEY idx_project_guild_deleted (guildConfigId, deletedAt)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
