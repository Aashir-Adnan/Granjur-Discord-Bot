// Channel names for task tickets. `feature-0145e3` told nobody anything; the
// title does. The id lives in the channel topic, and nothing resolves a task by
// channel name (/close-feature and /resolve-bug look the row up by channel id).
import { slugify } from './docPath.js'

export const MAX_CHANNEL_NAME = 100

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
