-- Per-project Discord section: the category, the role that sees it, and the
-- channels the bot created. Stored as ids so a channel renamed by hand is still
-- recognised on repair. scheduledmeeting.projectId records the project a meeting
-- was started in.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND COLUMN_NAME = 'discordCategoryId');
SET @sql = IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN discordCategoryId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND COLUMN_NAME = 'discordRoleId');
SET @sql = IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN discordRoleId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND COLUMN_NAME = 'discordChannels');
SET @sql = IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN discordChannels JSON DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scheduledmeeting' AND COLUMN_NAME = 'projectId');
SET @sql = IF(@col = 0, 'ALTER TABLE `scheduledmeeting` ADD COLUMN projectId VARCHAR(36) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
