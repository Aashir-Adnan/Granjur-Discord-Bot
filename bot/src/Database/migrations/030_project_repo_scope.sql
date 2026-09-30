-- project_repos.scope: which scope (backend/frontend/mobile/qa/design) a linked
-- repository serves in its project (roadmap sub-project 4, 2026-09-30; spec
-- docs/superpowers/specs/2026-09-30-repositories-per-scope-design.md). At most
-- one repository per scope per project; NULL (untagged) is unrestricted, and
-- existing links stay untagged. Guarded so the file can run twice.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_repos' AND COLUMN_NAME = 'scope');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE project_repos ADD COLUMN scope VARCHAR(16) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_repos' AND INDEX_NAME = 'uq_project_repos_scope');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE project_repos ADD UNIQUE KEY uq_project_repos_scope (project_id, scope)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
