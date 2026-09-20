-- Who did what to a task: one row per update, written by the bot's shared task
-- update path (/update-task and the site's board drag both go through it).
-- `changes` is a short JSON list such as [{"field":"status","from":"open","to":"done"}];
-- text bodies (a description) are never stored, only that they changed.

CREATE TABLE IF NOT EXISTS `taskactivity` (
  `id`             VARCHAR(36) NOT NULL,
  `guildConfigId`  VARCHAR(36) NOT NULL,
  `taskId`         VARCHAR(36) NOT NULL,
  `actorDiscordId` VARCHAR(64) DEFAULT NULL,
  `actorLabel`     VARCHAR(100) DEFAULT NULL,
  `changes`        JSON DEFAULT NULL,
  `createdAt`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_taskactivity_task` (`taskId`, `createdAt`),
  KEY `idx_taskactivity_guild` (`guildConfigId`),
  CONSTRAINT `fk_taskactivity_guild` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_taskactivity_task` FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
