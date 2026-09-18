-- Task dependencies ("A is blocked by B"), explicit project membership, and
-- Discord names on guildmember so the UBS-Doc site can show people, not ids.
-- Blocked state is never stored: a task is blocked while any blocker's status
-- is outside closed / done / resolved.

CREATE TABLE IF NOT EXISTS `taskdependency` (
  `id`              VARCHAR(36) NOT NULL,
  `guildConfigId`   VARCHAR(36) NOT NULL,
  `taskId`          VARCHAR(36) NOT NULL,
  `blockedByTaskId` VARCHAR(36) NOT NULL,
  `createdBy`       VARCHAR(64) DEFAULT NULL,
  `createdAt`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_taskdependency_pair` (`taskId`, `blockedByTaskId`),
  KEY `idx_taskdependency_guild` (`guildConfigId`),
  KEY `idx_taskdependency_blocker` (`blockedByTaskId`),
  CONSTRAINT `fk_taskdependency_guild` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_taskdependency_task` FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_taskdependency_blocker` FOREIGN KEY (`blockedByTaskId`) REFERENCES `task`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `projectmember` (
  `id`            VARCHAR(36) NOT NULL,
  `guildConfigId` VARCHAR(36) NOT NULL,
  `projectId`     VARCHAR(36) NOT NULL,
  `discordId`     VARCHAR(64) NOT NULL,
  `role`          VARCHAR(32) NOT NULL DEFAULT 'developer',
  `addedBy`       VARCHAR(64) DEFAULT NULL,
  `createdAt`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_projectmember_pair` (`projectId`, `discordId`),
  KEY `idx_projectmember_guild` (`guildConfigId`),
  CONSTRAINT `fk_projectmember_guild` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_projectmember_project` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildmember' AND COLUMN_NAME = 'displayName');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `guildmember` ADD COLUMN displayName VARCHAR(100) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildmember' AND COLUMN_NAME = 'username');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `guildmember` ADD COLUMN username VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
