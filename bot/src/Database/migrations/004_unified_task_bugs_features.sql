-- Consolidate Feature and BugTicket into Task. Task holds both with is_bug / is_feature flags.
-- Run after 001, 002, 003. Requires Feature, BugTicket, Task, ticketdoc, feature_repositories,
-- feature_project_schemas, bugticketcomment to exist.

-- 1) Add merged columns to Task
ALTER TABLE task
  ADD COLUMN is_bug TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN is_feature TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN title TEXT,
  ADD COLUMN description TEXT,
  ADD COLUMN status VARCHAR(32) DEFAULT 'open',
  ADD COLUMN createdBy VARCHAR(64),
  ADD COLUMN assigneeIds JSON DEFAULT ('[]'),
  ADD COLUMN taggedMemberIds JSON DEFAULT ('[]'),
  ADD COLUMN repositoryId VARCHAR(36),
  ADD COLUMN projectId VARCHAR(255),
  ADD COLUMN projectName VARCHAR(255),
  ADD COLUMN discordChannelId VARCHAR(64),
  ADD COLUMN discordThreadId VARCHAR(64),
  ADD COLUMN externalIssueUrl VARCHAR(512),
  ADD COLUMN externalIssueNumber INT;

-- 2) Backfill Task from Feature (tasks that reference a feature)
UPDATE Task t
INNER JOIN Feature f ON t.featureId = f.id
SET
  t.type = 'feature',
  t.is_feature = 1,
  t.is_bug = 0,
  t.title = f.title,
  t.description = f.description,
  t.status = IFNULL(f.status, 'open'),
  t.createdBy = f.createdBy,
  t.assigneeIds = IFNULL(f.assigneeIds, '[]'),
  t.repositoryId = f.repositoryId,
  t.projectId = f.projectId,
  t.projectName = f.projectName,
  t.discordChannelId = f.discordChannelId;

-- 3) Backfill Task from BugTicket (tasks that reference a bug)
UPDATE Task t
INNER JOIN BugTicket b ON t.bugTicketId = b.id
SET
  t.type = 'bug',
  t.is_bug = 1,
  t.is_feature = 0,
  t.title = b.title,
  t.description = b.description,
  t.status = IFNULL(b.status, 'pending'),
  t.createdBy = b.createdBy,
  t.taggedMemberIds = IFNULL(b.taggedMemberIds, '[]'),
  t.repositoryId = b.repositoryId,
  t.discordChannelId = b.discordChannelId,
  t.discordThreadId = b.discordThreadId,
  t.externalIssueUrl = b.externalIssueUrl,
  t.externalIssueNumber = b.externalIssueNumber;

-- 4) ticketdoc: add taskId and backfill
ALTER TABLE ticketdoc ADD COLUMN taskId VARCHAR(36) NULL;
UPDATE ticketdoc td
INNER JOIN Task t ON (t.featureId = td.featureId AND td.featureId IS NOT NULL)
SET td.taskId = t.id;
UPDATE ticketdoc td
INNER JOIN Task t ON (t.bugTicketId = td.bugTicketId AND td.bugTicketId IS NOT NULL)
SET td.taskId = t.id;
-- Drop FKs and columns (constraint names from REFERENTIAL_CONSTRAINTS)
SET @fk = (SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ticketdoc' AND REFERENCED_TABLE_NAME = 'Feature' LIMIT 1);
SET @sql = IF(@fk IS NOT NULL, CONCAT('ALTER TABLE ticketdoc DROP FOREIGN KEY ', @fk), 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @fk = (SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ticketdoc' AND REFERENCED_TABLE_NAME = 'BugTicket' LIMIT 1);
SET @sql = IF(@fk IS NOT NULL, CONCAT('ALTER TABLE ticketdoc DROP FOREIGN KEY ', @fk), 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
ALTER TABLE ticketdoc DROP COLUMN featureId, DROP COLUMN bugTicketId;
ALTER TABLE ticketdoc ADD KEY (taskId);
ALTER TABLE ticketdoc ADD CONSTRAINT ticketdoc_taskId_fk FOREIGN KEY (taskId) REFERENCES Task(id) ON DELETE SET NULL;

-- 5) feature_repositories: add task_id and backfill
ALTER TABLE feature_repositories ADD COLUMN task_id VARCHAR(36) NULL;
UPDATE feature_repositories fr
INNER JOIN Task t ON t.featureId = fr.feature_id
SET fr.task_id = t.id;
SET @fk = (SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'feature_repositories' AND REFERENCED_TABLE_NAME = 'Feature' LIMIT 1);
SET @sql = IF(@fk IS NOT NULL, CONCAT('ALTER TABLE feature_repositories DROP FOREIGN KEY ', @fk), 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
ALTER TABLE feature_repositories DROP PRIMARY KEY;
ALTER TABLE feature_repositories DROP COLUMN feature_id;
ALTER TABLE feature_repositories ADD PRIMARY KEY (task_id, repository_id);
ALTER TABLE feature_repositories ADD CONSTRAINT feature_repositories_task_fk FOREIGN KEY (task_id) REFERENCES Task(id) ON DELETE CASCADE;

-- 6) feature_project_schemas: add task_id and backfill
ALTER TABLE feature_project_schemas ADD COLUMN task_id VARCHAR(36) NULL;
UPDATE feature_project_schemas fps
INNER JOIN Task t ON t.featureId = fps.feature_id
SET fps.task_id = t.id;
SET @fk = (SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'feature_project_schemas' AND REFERENCED_TABLE_NAME = 'Feature' LIMIT 1);
SET @sql = IF(@fk IS NOT NULL, CONCAT('ALTER TABLE feature_project_schemas DROP FOREIGN KEY ', @fk), 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
ALTER TABLE feature_project_schemas DROP PRIMARY KEY;
ALTER TABLE feature_project_schemas DROP COLUMN feature_id;
ALTER TABLE feature_project_schemas ADD PRIMARY KEY (task_id, project_schema_id);
ALTER TABLE feature_project_schemas ADD CONSTRAINT feature_project_schemas_task_fk FOREIGN KEY (task_id) REFERENCES Task(id) ON DELETE CASCADE;

-- 7) bugticketcomment: add taskId and backfill
ALTER TABLE bugticketcomment ADD COLUMN taskId VARCHAR(36) NULL;
UPDATE bugticketcomment bc
INNER JOIN Task t ON t.bugTicketId = bc.bugTicketId
SET bc.taskId = t.id;
SET @fk = (SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'bugticketcomment' AND REFERENCED_TABLE_NAME = 'BugTicket' LIMIT 1);
SET @sql = IF(@fk IS NOT NULL, CONCAT('ALTER TABLE bugticketcomment DROP FOREIGN KEY ', @fk), 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
ALTER TABLE bugticketcomment DROP COLUMN bugTicketId;
ALTER TABLE bugticketcomment ADD KEY (taskId);
ALTER TABLE bugticketcomment ADD CONSTRAINT bugticketcomment_taskId_fk FOREIGN KEY (taskId) REFERENCES Task(id) ON DELETE CASCADE;

-- 8) Task: drop FKs and columns pointing to Feature/BugTicket
SET @fk = (SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'Task' AND REFERENCED_TABLE_NAME = 'Feature' LIMIT 1);
SET @sql = IF(@fk IS NOT NULL, CONCAT('ALTER TABLE task DROP FOREIGN KEY ', @fk), 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @fk = (SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'Task' AND REFERENCED_TABLE_NAME = 'BugTicket' LIMIT 1);
SET @sql = IF(@fk IS NOT NULL, CONCAT('ALTER TABLE task DROP FOREIGN KEY ', @fk), 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
ALTER TABLE task DROP COLUMN featureId, DROP COLUMN bugTicketId;

-- 9) Drop Feature and BugTicket
DROP TABLE IF EXISTS Feature;
DROP TABLE IF EXISTS BugTicket;
