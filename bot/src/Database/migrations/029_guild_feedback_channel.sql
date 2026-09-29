-- guildconfig.feedbackChannelId: the #feedback channel /feedback posts into
-- (roadmap sub-project 3, 2026-09-29; spec docs/superpowers/specs/2026-09-29-
-- global-channel-layout-design.md). Stored so a renamed or moved #feedback is
-- still found; the name inside the Feedback category is only the fallback.
-- Guarded so the file can run twice.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'feedbackChannelId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN feedbackChannelId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
