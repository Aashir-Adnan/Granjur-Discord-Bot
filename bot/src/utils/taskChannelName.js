// Channel names for task tickets. `feature-0145e3` told nobody anything; the
// title does. The id lives in the channel topic, and nothing resolves a task by
// channel name (/close-feature and /resolve-bug look the row up by channel id).
import { slugify } from './docPath.js'

export const MAX_CHANNEL_NAME = 100

/**
 * A task channel's topic: 'Feature: Add booking rules — Task <id>'.
 *
 * The `Task <id>` tail is what identifies the channel once its name is the
 * title rather than six hex characters, so it is built in one place. Both the
 * helper that opens a new task channel and the section applier that renames an
 * existing one use it: a rename that left the old topic behind would leave the
 * channel describing a task it no longer matches, and the bot would open a
 * duplicate beside it on the next update.
 */
export function taskChannelTopic({ type, title, taskId }) {
  const label = type === 'bug' ? 'Bug' : 'Feature'
  return `${label}: ${String(title || '').slice(0, 100)} — Task ${taskId}`
}

/** Every task channel the bot has ever opened carries one of these. */
const TICKET_NAME = /^(feature|bug)-/
const TICKET_TOPIC = /^(Feature|Bug):/

/**
 * Whether a channel is shaped like a task ticket: a `feature-`/`bug-` name or
 * a `Feature:`/`Bug:` topic. Every channel the bot has opened for a task has
 * one — `/create-task`, `/feature`, `/bug`, the meeting mirror, and the
 * renames `/project-setup` makes. A meeting's review channel has neither, and
 * an unassigned meeting task's row points at it, so a row naming a channel is
 * not by itself proof the channel is that task's. One definition, shared by
 * `ownsChannel` and the section observer. Pure.
 *
 * @param {{name?: string|null, topic?: string|null}|string|null} channel
 *   a channel-like object, or a bare channel name
 */
export function isTicketChannel(channel) {
  const name = String((typeof channel === 'string' ? channel : channel?.name) ?? '')
  const topic = typeof channel === 'string' ? '' : String(channel?.topic ?? '')
  return TICKET_NAME.test(name) || TICKET_TOPIC.test(topic)
}

/** Only the name half, for the old `<prefix>-<last six of the id>` check. */
export function hasTicketName(name) {
  return TICKET_NAME.test(String(name ?? ''))
}

export function taskChannelName({ type, title, taskId, taken = new Set() }) {
  const prefix = type === 'bug' ? 'bug' : 'feature'
  const id = String(taskId ?? '')
  const slug = slugify(title)
  let base = slug ? `${prefix}-${slug}` : `${prefix}-${id.slice(-6)}`
  if (base.length > MAX_CHANNEL_NAME) base = base.slice(0, MAX_CHANNEL_NAME).replace(/-+$/, '')
  if (!taken.has(base)) return base
  // Deterministic: a repair run must land on the same name it chose before.
  for (const n of [4, 8, 12, id.length]) {
    const suffix = `-${id.slice(0, n)}`
    const room = MAX_CHANNEL_NAME - suffix.length
    const candidate = `${base.slice(0, room).replace(/-+$/, '')}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return `${prefix}-${id.slice(-6)}`
}
