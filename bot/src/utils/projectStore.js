// Two small helpers that used to live in services/projectSection.js and moved
// here unchanged. The bucket helpers (statusBuckets.js) need both, and they are
// imported by services/taskTicketChannel.js, which must stay a leaf: importing
// the planner drags projectMembersPanel → db/index.js → the production .env into
// a module whose tests touch no database. projectSection.js re-exports both, so
// every existing importer is unchanged.

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

/** The project's stored channel-id map, whether MySQL handed back an object or a string. */
export function storedChannels(project) {
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
