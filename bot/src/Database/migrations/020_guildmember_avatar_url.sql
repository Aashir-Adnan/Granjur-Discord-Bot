-- Discord avatar URL per member, kept fresh by memberNameSync, so the UBS-Doc
-- Team page can show profile pictures without asking Discord.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildmember' AND COLUMN_NAME = 'avatarUrl');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `guildmember` ADD COLUMN avatarUrl VARCHAR(255) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
