/** In-memory step state for multi-step flows. Key: userId:guildId:command */
const state = new Map()
const TTL_MS = 30 * 60 * 1000

function key(userId, guildId, command) {
  return `${userId}:${guildId}:${command}`
}

export function get(userId, guildId, command) {
  const k = key(userId, guildId, command)
  const v = state.get(k)
  if (!v) return null
  if (Date.now() > v.exp) {
    state.delete(k)
    return null
  }
  return v.data
}

export function set(userId, guildId, command, data) {
  const k = key(userId, guildId, command)
  state.set(k, { data, exp: Date.now() + TTL_MS })
}

export function clear(userId, guildId, command) {
  state.delete(key(userId, guildId, command))
}
