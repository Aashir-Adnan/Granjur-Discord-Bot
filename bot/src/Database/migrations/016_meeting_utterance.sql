-- One row per transcribed speaker turn in a meeting, in capture order.
-- Mirrors CSAAS `meeting_utterances`; this copy is what makes the pipeline
-- handoff restart-safe and lets a partial transcript survive a bot restart.

CREATE TABLE IF NOT EXISTS `meetingutterance` (
  `id`            VARCHAR(36) NOT NULL,
  `guildConfigId` VARCHAR(36) NOT NULL,
  `meetingId`     VARCHAR(36) NOT NULL,
  `sequence`      INT NOT NULL,
  `speakerRef`    VARCHAR(64) DEFAULT NULL,
  `speakerName`   VARCHAR(190) DEFAULT NULL,
  `startedAt`     DATETIME NOT NULL,
  `durationMs`    INT NOT NULL DEFAULT 0,
  `text`          TEXT DEFAULT NULL,
  `createdAt`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_meetingutterance_seq` (`meetingId`, `sequence`),
  KEY `idx_meetingutterance_meeting` (`meetingId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The CSAAS meeting is now created when recording starts, not when the pipeline
-- runs, so the live feed has a meeting_id to post utterances against.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meeting' AND COLUMN_NAME = 'csaasMeetingId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `meeting` ADD COLUMN csaasMeetingId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
