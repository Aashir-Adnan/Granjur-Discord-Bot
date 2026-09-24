// Channel names for task tickets. `feature-0145e3` told nobody anything; the
// title does. The id lives in the channel topic, and nothing resolves a task by
// channel name (/close-feature and /resolve-bug look the row up by channel id).
import { ChannelType } from 'discord.js'
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
  const label = type === 'bug' ? 'Bug' : type === 'task' ? 'Task' : 'Feature'
  return `${label}: ${String(title || '').slice(0, 100)} — Task ${taskId}`
}

/** The bot's own signature: every ticket channel it has ever opened has this topic. */
const TICKET_TOPIC = /^(Feature|Bug|Task):/
/** Only for a channel with NO topic at all — a name is anyone's to choose. */
const TICKET_NAME = /^(feature|bug|task)-/

/**
 * Whether a channel is a task ticket channel the bot opened.
 *
 * The TOPIC decides. Every ticket channel the bot has ever created carries a
 * `Feature:`/`Bug:` topic — `/create-task`, `/feature`, `/bug`, the meeting
 * mirror, and the renames `/project-setup` makes — so the topic is the bot's
 * own signature. A name is not: `/meeting-channel name:"Bug triage"` creates
 * `bug-triage-<ts>-text`, a meeting review channel whose topic is
 * `Meeting chat is stored…`. The name counts only when there is no topic at
 * all, and only a text channel qualifies — `/create-channel` accepts any voice
 * name, and a voice channel has no topic.
 *
 * A row naming a channel is never by itself proof the channel is that task's:
 * an unassigned meeting task's row names the meeting's review channel. One
 * definition, shared by `ownsChannel` and the section observer. Pure.
 *
 * @param {{type?: number, name?: string|null, topic?: string|null}|null} channel
 *   a channel-like object. A bare name is never enough: without a type and a
 *   topic there is nothing to tell a ticket from a channel that merely shares
 *   its prefix.
 */
export function isTicketChannel(channel) {
  if (!channel || typeof channel !== 'object') return false
  if (channel.type !== ChannelType.GuildText) return false
  const topic = String(channel.topic ?? '')
  if (topic) return TICKET_TOPIC.test(topic)
  return TICKET_NAME.test(String(channel.name ?? ''))
}

export function taskChannelName({ type, title, taskId, taken = new Set() }) {
  // A client's support task (`type: 'task'`) is neither a bug nor a feature.
  const prefix = type === 'bug' ? 'bug' : type === 'task' ? 'task' : 'feature'
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
