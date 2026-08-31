-- Add server timezone to guildconfig (IANA name, e.g. "America/New_York").
-- Used by /schedule to interpret and display meeting times. NULL = bot host local zone.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'timezone');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN timezone VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
