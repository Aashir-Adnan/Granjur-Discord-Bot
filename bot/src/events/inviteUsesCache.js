/** In-memory cache of invite code -> uses per guild. Used to detect which invite was used when a member joins. */
const cache = new Map() // guildId -> Map(code -> uses)

export function setInviteUses(guildId, code, uses) {
  if (!cache.has(guildId)) cache.set(guildId, new Map())
  cache.get(guildId).set(code, uses)
}

export function getInviteUses(guildId, code) {
  return cache.get(guildId)?.get(code) ?? 0
}

export function updateInviteUses(guildId, code, uses) {
  setInviteUses(guildId, code, uses)
}
