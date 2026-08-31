-- Add a cancelled flag to scheduledmeeting so /meetings can cancel without deleting,
-- and so the reminder / auto-channel loops skip cancelled meetings.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scheduledmeeting' AND COLUMN_NAME = 'cancelled');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE scheduledmeeting ADD COLUMN cancelled BOOLEAN NOT NULL DEFAULT FALSE', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
