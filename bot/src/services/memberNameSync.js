// Keeps guildmember.displayName / username in step with Discord so anything
// that cannot ask Discord (the UBS-Doc site) can show people instead of ids.
//
// Runs at startup, every six hours, and on GuildMemberUpdate for one member.
// A member with no row gets one with status 'pending' — the same state
// memberAdd.js gives every joiner, so nothing new is invented.

import db, { getOrCreateGuildConfig } from '../db/index.js'

export const NAME_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
const clip = (s, n) => (s == null ? null : String(s).slice(0, n))

/** Pure diff between Discord's members and the stored rows. */
export function toNameUpdates(discordMembers = [], dbRows = []) {
  const byDiscordId = new Map(dbRows.map((r) => [String(r.discordId), r]))
  const updates = []
  const inserts = []
  for (const member of discordMembers) {
    if (member?.user?.bot) continue
    const displayName = clip(member.displayName ?? member.user?.username, 100)
    const username = clip(member.user?.username, 64)
    const row = byDiscordId.get(String(member.id))
    if (!row) {
      inserts.push({ discordId: String(member.id), displayName, username })
      continue
    }
    if (row.displayName !== displayName || row.username !== username) {
      updates.push({ id: row.id, displayName, username })
    }
  }
  return { updates, inserts }
}

/** Writes an updates/inserts diff through the db seam. Returns the row count written. */
async function applyNameWrites(guildId, { updates, inserts }, dbArg) {
  for (const u of updates) {
    await dbArg.guildMember.update({ where: { id: u.id }, data: { displayName: u.displayName, username: u.username } })
  }
  for (const i of inserts) {
    await dbArg.guildMember.upsert({
      where: { guildId_discordId: { guildId, discordId: i.discordId } },
      create: { guildId, discordId: i.discordId, status: 'pending', displayName: i.displayName, username: i.username },
      update: { displayName: i.displayName, username: i.username },
    })
  }
  return updates.length + inserts.length
}

/** Sync every non-bot member of one guild. Returns the number of rows written. */
export async function syncGuildMemberNames(guild, { db: dbArg = db, cfg = null } = {}) {
  const config = cfg ?? (await getOrCreateGuildConfig(guild.id))
  const collection = await guild.members.fetch()
  const discordMembers = Array.from(collection.values())
  const rows = await dbArg.guildMember.findMany({ where: { guildConfigId: config.id, all: true } })
  const diff = toNameUpdates(discordMembers, rows)
  return applyNameWrites(guild.id, diff, dbArg)
}

/** GuildMemberUpdate handler: one member, one row. */
export async function syncOneMember(member, { db: dbArg = db } = {}) {
  try {
    if (!member?.guild || member.user?.bot) return
    const row = await dbArg.guildMember.findUnique({ where: { guildId_discordId: { guildId: member.guild.id, discordId: member.id } } })
    const diff = toNameUpdates([member], row ? [row] : [])
    await applyNameWrites(member.guild.id, diff, dbArg)
  } catch (e) {
    console.warn('[memberNameSync] one member:', e?.message ?? e)
  }
}

async function syncAll(client, dbArg) {
  for (const [, guild] of client.guilds.cache) {
    try {
      const n = await syncGuildMemberNames(guild, { db: dbArg })
      if (n) console.log(`[memberNameSync] ${guild.name}: ${n} row(s) updated`)
    } catch (e) {
      console.warn(`[memberNameSync] ${guild?.name ?? guild?.id}:`, e?.message ?? e)
    }
  }
}

export function startMemberNameSync(client, { db: dbArg = db, intervalMs = NAME_SYNC_INTERVAL_MS } = {}) {
  if (!client?.guilds) return
  syncAll(client, dbArg).catch(() => {})
  setInterval(() => syncAll(client, dbArg).catch(() => {}), intervalMs)
}
