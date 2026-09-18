-- Discord role names per member, kept fresh by memberNameSync, so the UBS-Doc
-- Team page can show roles without asking Discord.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildmember' AND COLUMN_NAME = 'roleNames');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `guildmember` ADD COLUMN roleNames JSON DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
