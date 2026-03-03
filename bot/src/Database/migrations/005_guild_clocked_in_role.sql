-- Add clockedInRoleId to GuildConfig (role assigned when member clocks in; members online = clocked-in only when using this role)
ALTER TABLE GuildConfig ADD COLUMN clockedInRoleId VARCHAR(64) NULL;
