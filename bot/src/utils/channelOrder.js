// The one reorder primitive behind the archive divider. A leaf: no Discord
// writes except the single `setPositions` in `applyOrder`, no database, no
// clock — so every caller (the ticket creator, the live mover, /project-setup)
// can be tested against a plain fake guild.
import { ChannelType } from 'discord.js'

/** A discord.js Collection or a plain Map, read the same way. */
const valuesOf = (cache) => (cache?.values ? [...cache.values()] : [])

/**
 * Discord sorts siblings by position and then by id, and an id is a snowflake
 * — a decimal number in a string. Comparing those as strings puts `11` before
 * `9`, so length decides first.
 */
function byId(a, b) {
  const x = String(a ?? '')
  const y = String(b ?? '')
  if (x.length !== y.length) return x.length - y.length
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * The text channels of one category in Discord's display order.
 *
 * `rawPosition` is the raw gateway value — non-contiguous, but the thing
 * Discord actually sorts on, together with the id as the tie-break. Voice
 * channels render below every text channel in a category no matter what their
 * position says, and categories are not children at all, so both are excluded:
 * a reorder must only ever speak about the channels it can actually order.
 *
 * @param {{channels?: {cache?: object}}|null} guild
 * @param {string|null} categoryId
 * @returns {object[]} the channel objects, sorted
 */
export function textChannelsOf(guild, categoryId) {
  if (!categoryId) return []
  return valuesOf(guild?.channels?.cache)
    .filter((c) => c?.type === ChannelType.GuildText && (c.parentId ?? null) === categoryId)
    .sort((a, b) => Number(a?.rawPosition ?? 0) - Number(b?.rawPosition ?? 0) || byId(a?.id, b?.id))
}

const idOf = (c) => (c && typeof c === 'object' ? c.id : c)
const setOf = (v) => (v instanceof Set ? v : new Set(v ?? []))

/**
 * The order a category's text channels should sit in: everything that is
 * neither a ticket nor the divider first, then the live tickets, then the
 * divider, then the archived tickets. Relative order is kept inside each
 * group, so a caller that wants one channel at the bottom of its group passes
 * it last in `channels`.
 *
 * `dividerId` may be null (no line, but the live/archived split still holds),
 * and a `dividerId` that is not among `channels` is never invented — ordering
 * a channel that is not in this category would tip it out of its own.
 *
 * @param {Array<object|string>} channels the category's text channels, in their current order
 * @param {{dividerId?: string|null, archivedIds?: Set<string>|string[], ticketIds?: Set<string>|string[]}} [opts]
 * @returns {string[]} channel ids
 */
export function desiredOrder(channels, { dividerId = null, archivedIds, ticketIds } = {}) {
  const archived = setOf(archivedIds)
  const tickets = setOf(ticketIds)
  const others = []
  const live = []
  const below = []
  let hasDivider = false
  for (const channel of channels ?? []) {
    const id = idOf(channel)
    if (!id) continue
    if (dividerId && id === dividerId) {
      hasDivider = true
      continue
    }
    if (!tickets.has(id)) others.push(id)
    else if (archived.has(id)) below.push(id)
    else live.push(id)
  }
  return [...others, ...live, ...(hasDivider ? [dividerId] : []), ...below]
}

/**
 * Apply `order` to the guild with ONE call, and only when it differs from
 * `current`.
 *
 * Discord's `PATCH /guilds/:id/channels` takes the whole list at once, so a
 * reorder of a category costs one request however many channels moved.
 * Positions are re-numbered 0..n-1: siblings sort by position then id, so only
 * the relative order carries meaning.
 *
 * A throw propagates — every caller decides for itself whether a refused
 * reorder is a warning or a `reason: 'error'`.
 *
 * @returns {Promise<{changed: boolean}>}
 */
export async function applyOrder(guild, current, order) {
  const now = (current ?? []).map(idOf)
  const want = (order ?? []).map(idOf)
  if (now.length === want.length && now.every((id, i) => id === want[i])) return { changed: false }
  await guild.channels.setPositions(want.map((channel, position) => ({ channel, position })))
  return { changed: true }
}
