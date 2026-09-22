-- Task time tracking. Every column is nullable or defaulted, so existing shift
-- rows (no task) stay valid and read as general work. No foreign key on taskId:
-- deleting a task must never delete the hours somebody worked.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clockentry' AND COLUMN_NAME = 'taskId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE clockentry ADD COLUMN taskId VARCHAR(36) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clockentry' AND COLUMN_NAME = 'minutes');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE clockentry ADD COLUMN minutes INT DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clockentry' AND COLUMN_NAME = 'note');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE clockentry ADD COLUMN note VARCHAR(500) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clockentry' AND COLUMN_NAME = 'source');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE clockentry ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT ''timer''', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clockentry' AND COLUMN_NAME = 'remindedAt');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE clockentry ADD COLUMN remindedAt DATETIME(3) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND COLUMN_NAME = 'estimateMinutes');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE task ADD COLUMN estimateMinutes INT DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'clockReminderHours');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN clockReminderHours INT DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'clockCapHours');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN clockCapHours INT DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clockentry' AND INDEX_NAME = 'idx_clockentry_task');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE clockentry ADD KEY idx_clockentry_task (guildConfigId, taskId)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clockentry' AND INDEX_NAME = 'idx_clockentry_person');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE clockentry ADD KEY idx_clockentry_person (guildConfigId, discordId, clockInAt)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill: legacy rows closed before this migration have clockOutAt but no
-- minutes (every read path treats minutes IS NULL as "still open" or "not
-- really closed" — see isClosed()/closed()/sumByTask's own NULL filter).
-- ROUND(...SECOND.../60), not TIMESTAMPDIFF(MINUTE,...), to match
-- entryMinutes()'s own rounding exactly (spec: minutes === entryMinutes(...)
-- for every entry, backfilled ones included).
UPDATE clockentry
SET minutes = ROUND(TIMESTAMPDIFF(SECOND, clockInAt, clockOutAt) / 60)
WHERE minutes IS NULL AND clockOutAt IS NOT NULL;

-- Legacy rows that were never closed at all (same root cause) must not be
-- left for the watcher's first pass to auto-stop at a fabricated 12h each,
-- with a DM to every owner. An unknown historical duration is recorded as 0
-- (source 'legacy'), never guessed — guessing 12h for a row that could be
-- months old would be worse than showing nothing. Fix by hand via /my-time
-- edit if the true duration is known out of band.
UPDATE clockentry
SET clockOutAt = clockInAt, minutes = 0, source = 'legacy'
WHERE clockOutAt IS NULL;
