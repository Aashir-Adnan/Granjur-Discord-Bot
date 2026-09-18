-- meeting.projectId records the project a /meeting-channel meeting belongs to.
-- The column has been in schema.sql since the initial commit (VARCHAR(255)),
-- and the production dump has it, so on those databases this is a no-op. The
-- guard adds it, with the same type, to any database built before it existed.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meeting' AND COLUMN_NAME = 'projectId');
SET @sql = IF(@col = 0, 'ALTER TABLE `meeting` ADD COLUMN projectId VARCHAR(255) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
