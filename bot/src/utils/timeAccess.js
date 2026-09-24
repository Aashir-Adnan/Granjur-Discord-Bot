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

/**
 * The ids of the projects `discordId` belongs to in this server, as a STAFF
 * member. A `role: 'client'` membership is dropped: it exists to open that
 * project's two support channels, never to put the project's task list into a
 * time-tracking picker.
 */
export async function memberProjectIdsOf(dbArg, cfg, discordId) {
  const rows = await dbArg.projectMember.findByMember({ where: { guildConfigId: cfg.id, discordId } })
  return (rows || []).filter((r) => r?.role !== 'client').map((r) => r.projectId)
}
