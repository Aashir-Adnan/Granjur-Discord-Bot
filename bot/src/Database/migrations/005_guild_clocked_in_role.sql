-- Add clockedInRoleId to GuildConfig (role assigned when member clocks in; members online = clocked-in only when using this role)
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GuildConfig' AND COLUMN_NAME = 'clockedInRoleId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE GuildConfig ADD COLUMN clockedInRoleId VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
