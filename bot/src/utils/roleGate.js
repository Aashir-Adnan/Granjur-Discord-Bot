// Role gates that survive the guild's roles being recreated.
//
// `guildconfig.dashboardRoleIds` / `seniorRoleIds` hold Discord role IDs, which
// are minted fresh whenever the roles are recreated (a /scrap + /init cycle, or
// by hand). Nothing repoints the config at the new IDs, so the stored list goes
// on naming roles that no longer exist — and the gate then fails closed for
// everyone but an Administrator, with a message saying they are not a CEO or
// Server Manager when they plainly are. That is exactly what locked a Server
// Manager out of /dashboard, /backlog and /evaluate on 2026-09-04.
//
// So treat the ID list as the configured answer when it can still match, and
// fall back to role NAMES — which survive recreation — only when it cannot:
// the list is empty, or not one ID in it belongs to a role this guild still
// has. A deliberate configuration (someone removed CEO from the list) keeps
// working, because those IDs are live and the fallback never runs.

/** Names that stand in for a stale dashboard/backlog list. */
export const LEADERSHIP_ROLE_NAMES = ['CEO', 'Server Manager']
/** Names that stand in for a stale senior list. */
export const SENIOR_ROLE_NAMES = ['CEO', 'Server Manager', 'Senior Dev']

/**
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember|null} member
 * @param {string[]} roleIds - the configured IDs
 * @param {string[]} fallbackNames - role names to accept when roleIds is unusable
 */
export function memberPassesRoleGate(guild, member, roleIds, fallbackNames = []) {
  if (!member) return false
  if (member.permissions?.has?.('Administrator')) return true

  const ids = Array.isArray(roleIds) ? roleIds : []
  if (ids.length && member.roles?.cache?.some?.((r) => ids.includes(r.id))) return true

  const anyIdIsLive = ids.some((id) => Boolean(guild?.roles?.cache?.has?.(id)))
  if (anyIdIsLive || fallbackNames.length === 0) return false

  return Boolean(member.roles?.cache?.some?.((r) => fallbackNames.includes(r.name)))
}

/**
 * True when the configured IDs name no role this guild still has — the state
 * that silently locks people out. Callers log it so it is discoverable.
 */
export function roleIdsAreStale(guild, roleIds) {
  const ids = Array.isArray(roleIds) ? roleIds : []
  if (ids.length === 0) return false
  return !ids.some((id) => Boolean(guild?.roles?.cache?.has?.(id)))
}
