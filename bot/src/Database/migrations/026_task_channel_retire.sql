-- Status buckets: when a finished ticket's channel is to be deleted.
-- NULL means "not scheduled": the task is not in its project's Done bucket, or
-- was never filed there. Written when a task enters Done (14 days out), cleared
-- when it leaves; the hourly sweep deletes channels whose stamp has passed.
-- Guarded so the file can run twice.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND COLUMN_NAME = 'channelRetireAt');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE task ADD COLUMN channelRetireAt DATETIME DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND INDEX_NAME = 'idx_task_channelRetireAt');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE task ADD INDEX idx_task_channelRetireAt (channelRetireAt)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
