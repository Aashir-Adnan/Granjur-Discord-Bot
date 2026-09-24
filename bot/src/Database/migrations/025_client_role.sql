-- The Client role: who is a client, which role and channels are theirs, and
-- which tasks they raised. Every ALTER is guarded so the file can run twice.
--
-- guildmember.kind is what the bot's own logic consults (the daily time report
-- lists "approved members" and must skip clients); the Discord role is what
-- Discord enforces. pendinginvite.kind is what /invite recorded, copied onto
-- the member row at join. task.requestedBy non-null means "a client raised it".

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'clientRoleId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN clientRoleId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'supportChannelId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN supportChannelId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'supportVoiceChannelId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN supportVoiceChannelId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildmember' AND COLUMN_NAME = 'kind');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildmember ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT ''staff''', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pendinginvite' AND COLUMN_NAME = 'kind');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE pendinginvite ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT ''staff''', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND COLUMN_NAME = 'requestedBy');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE task ADD COLUMN requestedBy VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND INDEX_NAME = 'idx_task_requestedBy');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE task ADD INDEX idx_task_requestedBy (requestedBy)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
