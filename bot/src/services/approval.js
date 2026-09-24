// The one approval routine /approve and /backlog share, so the two cannot
// drift — which matters most for the one rule this file exists to hold: a
// client never receives Verified.
import db, { ensureStringArray, updateGuildConfig } from '../db/index.js'
import { ensureSupportChannels } from './clientAccess.js'
import { ROLE_CLIENT } from '../constants.js'

/** The select value both role pickers use for "approve as a client". */
export const CLIENT_VALUE = '__client__'

export async function approveMember({
  guild, member, dbMember, cfg,
  roleNames = [], asClient = false,
  db: dbArg = db, update = updateGuildConfig, ensureClient = ensureSupportChannels,
}) {
  if (asClient) {
    // Role and support pair on demand: the live server was never re-inited.
    const { role, text } = await ensureClient(guild, cfg, { update, botUserId: guild.client?.user?.id ?? null })
    await member.roles.add(role.id)
    if (cfg.holdingRoleId) await member.roles.remove(cfg.holdingRoleId).catch((e) => console.warn('[approval] Could not remove holding role:', e.message))
    await dbArg.guildMember.update({ where: { id: dbMember.id }, data: { status: 'approved', kind: 'client' } })
    return { asClient: true, assigned: [ROLE_CLIENT], supportChannelId: text?.id ?? null }
  }

  const assigned = []
  for (const name of roleNames || []) {
    if (name === CLIENT_VALUE) continue
    let role = null
    for (const r of guild.roles.cache.values()) if (r.name.toLowerCase() === String(name).toLowerCase()) { role = r; break }
    if (!role) continue
    try {
      await member.roles.add(role)
      assigned.push(role.name)
    } catch (_) {}
  }
  if (cfg.holdingRoleId) await member.roles.remove(cfg.holdingRoleId).catch((e) => console.warn('[approval] Could not remove holding role:', e.message))
  if (cfg.verifiedRoleId) {
    await member.roles.add(cfg.verifiedRoleId).catch((e) => console.error('[approval] Could not add verified role:', e.message))
  } else {
    console.warn('[approval] No verifiedRoleId configured — user will not see channels')
  }
  const existingRoleIds = ensureStringArray(dbMember.roleIds)
  await dbArg.guildMember.update({
    where: { id: dbMember.id },
    data: { status: 'approved', kind: 'staff', roleIds: [...new Set([...existingRoleIds, ...assigned])] },
  })
  return { asClient: false, assigned, supportChannelId: null }
}
