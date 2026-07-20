-- Fix script to clean up failed migration
-- Run this in MySQL to remove the failed migration record and drop the problematic tables

DELETE FROM schema_migrations WHERE name = '007_meeting_records.sql';

DROP TABLE IF EXISTS `meetingrecordingstatus`;
DROP TABLE IF EXISTS `meetingrecording`;
