// Who may see and use what in time tracking. Shared by /clock-in, /log-time and
// /my-time so the rule cannot drift between them.

import { ensureStringArray } from '../db/index.js'
import { memberPassesRoleGate, LEADERSHIP_ROLE_NAMES } from './roleGate.js'

/** True when `member` is CEO / Server Manager / an administrator for this server. */
export function isLeadershipFor(guild, member, cfg) {
  return memberPassesRoleGate(
    guild,
    member,
    ensureStringArray(cfg.dashboardRoleIds),
    LEADERSHIP_ROLE_NAMES,
  )
}

/** The ids of the projects `discordId` belongs to in this server. */
export async function memberProjectIdsOf(dbArg, cfg, discordId) {
  const rows = await dbArg.projectMember.findByMember({ where: { guildConfigId: cfg.id, discordId } })
  return (rows || []).map((r) => r.projectId)
}
