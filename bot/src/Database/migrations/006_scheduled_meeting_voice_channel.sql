-- Add voice channel and recording fields to scheduledmeeting table
ALTER TABLE `scheduledmeeting` ADD COLUMN `voiceChannelId` VARCHAR(64) DEFAULT NULL;
ALTER TABLE `scheduledmeeting` ADD COLUMN `recordingEnabled` BOOLEAN DEFAULT FALSE;
ALTER TABLE `scheduledmeeting` ADD COLUMN `autoChannelId` VARCHAR(64) DEFAULT NULL;
ALTER TABLE `scheduledmeeting` ADD COLUMN `channelCreatedAt` DATETIME(3) DEFAULT NULL;
