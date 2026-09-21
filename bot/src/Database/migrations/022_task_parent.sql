-- Task hierarchy: a task may have subtasks. `parentTaskId` points a subtask at its
-- parent (one level only: a subtask never has subtasks of its own). NULL for every
-- existing task, so nothing changes for them. No foreign key on purpose: a
-- missing parent row simply makes the task top-level again.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND COLUMN_NAME = 'parentTaskId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE task ADD COLUMN parentTaskId VARCHAR(36) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND INDEX_NAME = 'idx_task_parent');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE task ADD KEY idx_task_parent (parentTaskId)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
