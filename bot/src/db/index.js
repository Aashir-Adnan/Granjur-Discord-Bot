/**
 * DB layer: re-exports from Database (MySQL via mysql2).
 * Use bot/src/Database/ for all DB access; this file keeps existing imports working.
 */
export { getGuildConfig, getGuildConfigById, getOrCreateGuildConfig, updateGuildConfig, ensureStringArray, guildMemberFindByEmail } from '../Database/index.js'
import { db } from '../Database/index.js'
export default db
