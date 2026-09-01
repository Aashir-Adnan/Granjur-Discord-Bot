-- Add externalId + meetingId to task for meeting-sourced tasks.
-- externalId is "csaas:<meeting_task_id>"; meetingId is the bot meeting.id.
-- Guarded via information_schema so re-running is safe (MySQL lacks ADD COLUMN IF NOT EXISTS).

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND COLUMN_NAME = 'externalId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE task ADD COLUMN externalId VARCHAR(128) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND COLUMN_NAME = 'meetingId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE task ADD COLUMN meetingId VARCHAR(36) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND INDEX_NAME = 'idx_task_externalId');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE task ADD KEY idx_task_externalId (externalId)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND INDEX_NAME = 'idx_task_meetingId');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE task ADD KEY idx_task_meetingId (meetingId)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
