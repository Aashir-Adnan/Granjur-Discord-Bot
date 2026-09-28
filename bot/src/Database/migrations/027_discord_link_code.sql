-- One-time codes that link a Discord member to a UBS-Doc account.
-- /link writes a row; CSAAS redeems it (reads it and stamps usedAt) when the
-- member types the code on the site. expiresAt is computed by MySQL's NOW()
-- on insert and compared with NOW() on redeem, so no host timezone matters.
-- Same table-level collation as the other bot tables.
CREATE TABLE IF NOT EXISTS discordlinkcode (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  discordId VARCHAR(64) NOT NULL,
  code CHAR(6) NOT NULL,
  expiresAt DATETIME NOT NULL,
  usedAt DATETIME DEFAULT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_discordlinkcode_code (code),
  KEY idx_discordlinkcode_member (guildConfigId, discordId)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
