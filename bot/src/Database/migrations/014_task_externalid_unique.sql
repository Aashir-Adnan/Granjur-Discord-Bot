-- Promote task.externalId from a plain index to a UNIQUE key so the meeting
-- pipeline's mirror step is idempotent at the DB level (one bot task per
-- csaas:<meeting_task_id>).
--
-- Best-effort + guarded:
--   * only runs when the plain idx_task_externalId KEY exists and the UNIQUE
--     key does not yet exist
--   * only runs when there are NO duplicate non-null externalId values
--     (otherwise the ADD UNIQUE would fail — we leave the plain key in place)
-- Re-running is safe.

SET @dupes = (
  SELECT COUNT(*) FROM (
    SELECT externalId FROM task
    WHERE externalId IS NOT NULL
    GROUP BY externalId HAVING COUNT(*) > 1
  ) d
);

SET @has_plain = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND INDEX_NAME = 'idx_task_externalId');

SET @has_unique = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND INDEX_NAME = 'uq_task_externalId');

SET @sql = IF(@dupes = 0 AND @has_plain > 0 AND @has_unique = 0,
  'ALTER TABLE task DROP KEY idx_task_externalId, ADD UNIQUE KEY uq_task_externalId (externalId)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
