// Two small helpers that used to live in services/projectSection.js and moved
// here unchanged. The archive helpers (utils/ticketArchive.js) need them, and
// they are imported by services/taskTicketChannel.js, which must stay a leaf:
// importing the planner drags projectMembersPanel → db/index.js → the production
// .env into a module whose tests touch no database. projectSection.js re-exports
// both, so every existing importer is unchanged.

/**
 * Cut to `max` UTF-16 units without leaving half of a surrogate pair behind.
 */
export function cut(text, max) {
  if (text.length <= max) return text
  const sliced = text.slice(0, max)
  const last = sliced.charCodeAt(sliced.length - 1)
  // A lone high surrogate would render as a replacement character.
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced
}

/**
 * The key a deleted project's `discordChannels` JSON keeps the ids of the
 * non-task channels its delete moved into the archive under (a meeting pair, a
 * hand-made channel, an unstored legacy section channel). An array, not a
 * channel id: `storedChannels` leaves it out, `archivedChannelIds` reads it.
 */
export const ARCHIVED_STORE_KEY = 'archived'

/** The raw `discordChannels` map, whether MySQL handed back an object or a string. */
function channelMap(project) {
  const raw = project?.discordChannels
  if (!raw) return {}
  if (typeof raw === 'object') return { ...raw }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? { ...parsed } : {}
  } catch {
    return {}
  }
}

/**
 * The project's stored channel-id map, whether MySQL handed back an object or a
 * string. Section channel ids only: the `archived` list is not one of them.
 */
export function storedChannels(project) {
  const map = channelMap(project)
  delete map[ARCHIVED_STORE_KEY]
  return map
}

/** The ids a project delete archived beyond its task channels; empty when none. */
export function archivedChannelIds(project) {
  const list = channelMap(project)[ARCHIVED_STORE_KEY]
  return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id) : []
}
