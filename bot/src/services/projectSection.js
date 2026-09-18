/**
 * The section planner: given a project and a plain snapshot of what the guild
 * already has, decide what to create, rename or move so the project owns a
 * category of its own.
 *
 * Pure on purpose. Nothing here touches Discord, the database, the clock or
 * randomness, so the whole decision is testable without a guild. The applier
 * (`applyProjectSection`) performs the plan; it lives elsewhere.
 *
 * The plan, per spec §7:
 *   role:     { action: 'create' | 'reuse' | 'refuse', name, id?, reason? }
 *   category: { action: 'create' | 'reuse' | 'rename', id?, name }
 *   channels: [{ key, action: 'create' | 'reuse' | 'rename' | 'move', id?, name, type }]
 *   tasks:    [{ taskId, channelId, action: 'rename' | 'move' | 'both' | 'none', name }]
 *   warnings: string[]
 *
 * Every non-`reuse` channel entry carries the FINAL desired `name`, so the
 * applier can send `{ name, parent }` in a single `edit()` whatever the action
 * is — Discord allows only two channel edits per ten minutes, so a rename plus
 * a separate move would burn the whole budget on one channel.
 */
import { slugify } from '../utils/docPath.js'
import { taskChannelName, MAX_CHANNEL_NAME } from '../utils/taskChannelName.js'
import { MANAGED_ROLES } from '../utils/roleSync.js'

/** Discord allows 50 channels per category; stop one short so a repair run never wedges. */
export const CATEGORY_SOFT_CAP = 49

/** Discord's cap on a category name, the same 100 as a channel name. */
const MAX_CATEGORY_NAME = 100

/** The ten section channels, in creation order. */
export const SECTIONS = [
  { key: 'members', suffix: 'members', type: 'text' },
  { key: 'documentation', suffix: 'documentation', type: 'text' },
  { key: 'meetings', suffix: 'meetings', type: 'text' },
  { key: 'meetingVoice', suffix: 'meeting-voice', type: 'voice' },
  { key: 'frontendChat', suffix: 'frontend-chat', type: 'text' },
  { key: 'frontendVoice', suffix: 'frontend-voice', type: 'voice' },
  { key: 'backendChat', suffix: 'backend-chat', type: 'text' },
  { key: 'backendVoice', suffix: 'backend-voice', type: 'voice' },
  { key: 'databaseChat', suffix: 'database-chat', type: 'text' },
  { key: 'databaseVoice', suffix: 'database-voice', type: 'voice' },
]

const fold = (s) => String(s ?? '').trim().toLowerCase()
const MANAGED_FOLDED = new Set(MANAGED_ROLES.map(fold))

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair behind. */
function cut(text, max) {
  if (text.length <= max) return text
  const sliced = text.slice(0, max)
  const last = sliced.charCodeAt(sliced.length - 1)
  // A lone high surrogate would render as a replacement character.
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced
}

/** The project's channel-name slug: its stored docsSlug, else one from its name. */
function projectSlug(project) {
  return project?.docsSlug || slugify(project?.name)
}

/** '📂 FRAMEWORK'. The project name upper-cased behind the folder emoji. */
export function categoryNameFor(project) {
  return cut(`📂 ${String(project?.name ?? '').trim().toUpperCase()}`, MAX_CATEGORY_NAME)
}

/**
 * '<slug>-<suffix>', e.g. 'framework-frontend-chat'. A slug long enough to push
 * the name past Discord's 100 characters is truncated — the suffix never is,
 * because it is what tells the channels apart.
 */
export function channelNameFor(project, suffix) {
  const slug = projectSlug(project)
  const full = `${slug}-${suffix}`
  if (full.length <= MAX_CHANNEL_NAME) return full
  const room = MAX_CHANNEL_NAME - suffix.length - 1
  if (room <= 0) return cut(suffix, MAX_CHANNEL_NAME)
  return `${slug.slice(0, room).replace(/-+$/, '')}-${suffix}`
}

/**
 * The project a channel belongs to: the one whose category is the channel's
 * parent, or the category itself. Null-safe, and null when nothing matches.
 * Shared here because several commands need the same answer.
 *
 * @param {Array<{discordCategoryId?: string|null}>} projects
 * @param {{id?: string|null, parentId?: string|null}|null} channel
 */
export function projectFromChannel(projects, channel) {
  if (!channel) return null
  const list = Array.isArray(projects) ? projects : []
  const parentId = channel.parentId ?? null
  const ownId = channel.id ?? null
  return (
    list.find(
      (p) =>
        p &&
        p.discordCategoryId &&
        (p.discordCategoryId === parentId || p.discordCategoryId === ownId)
    ) ?? null
  )
}

function planRole(project, observed, warnings) {
  const name = String(project?.name ?? '').trim()
  if (MANAGED_FOLDED.has(fold(name))) {
    const reason = `"${name}" is a managed role — one of the job roles the bot assigns — so it cannot also be a project role.`
    warnings.push(
      `Project "${name}" shares its name with a managed role, so no project role was planned. Rename the project to give it its own access.`
    )
    return { action: 'refuse', name, reason }
  }
  if (observed?.roleId) return { action: 'reuse', id: observed.roleId, name }
  const existing = observed?.roleNames?.get?.(name)
  if (existing) return { action: 'reuse', id: existing, name }
  return { action: 'create', name }
}

function planCategory(project, observed) {
  const name = categoryNameFor(project)
  const id = observed?.categoryId ?? null
  if (!id) return { action: 'create', name }
  // Found by id, never by name, so a category renamed by hand is still ours.
  if (observed.categoryName === name) return { action: 'reuse', id, name }
  return { action: 'rename', id, name }
}

function planChannels(project, observed) {
  const parentId = observed?.categoryId ?? null
  const seen = observed?.channels ?? {}
  return SECTIONS.map(({ key, suffix, type }) => {
    const name = channelNameFor(project, suffix)
    const channel = seen[key]
    if (!channel?.id) return { key, action: 'create', name, type }
    const nameOk = channel.name === name
    // With no category yet there is nothing to sit under, so the channel moves.
    const parentOk = Boolean(parentId) && channel.parentId === parentId
    if (nameOk && parentOk) return { key, action: 'reuse', id: channel.id, name, type }
    if (parentOk) return { key, action: 'rename', id: channel.id, name, type }
    return { key, action: 'move', id: channel.id, name, type }
  })
}

function planTasks(project, observed, channels, warnings) {
  const parentId = observed?.categoryId ?? null
  const tasks = Array.isArray(observed?.tasks) ? observed.tasks : []
  const creating = channels.filter((c) => c.action === 'create').length
  // What is left of the category once this plan's own channels are in it.
  let room = Math.max(
    0,
    CATEGORY_SOFT_CAP - Number(observed?.categoryChannelCount ?? 0) - creating
  )

  const taken = new Set(observed?.takenNames ?? [])
  const planned = []
  let leftBehind = 0

  for (const task of tasks) {
    if (!task?.channelId) continue
    // A channel does not collide with the name it already carries.
    if (task.channelName) taken.delete(task.channelName)
    const name = taskChannelName({
      type: task.type,
      title: task.title,
      taskId: task.id,
      taken,
    })
    taken.add(name)

    const nameOk = task.channelName === name
    const parentOk = Boolean(parentId) && task.parentId === parentId
    let action = nameOk ? (parentOk ? 'none' : 'move') : parentOk ? 'rename' : 'both'

    if (action === 'move' || action === 'both') {
      if (room > 0) room -= 1
      else {
        // No room: leave it where it is, but still give it a readable name.
        action = action === 'both' ? 'rename' : 'none'
        leftBehind += 1
      }
    }
    planned.push({ taskId: task.id, channelId: task.channelId, action, name })
  }

  if (leftBehind > 0) {
    warnings.push(
      `Project "${project?.name}" is at Discord's category cap (${CATEGORY_SOFT_CAP} channels), so ${leftBehind} task channel${leftBehind === 1 ? '' : 's'} stayed where ${leftBehind === 1 ? 'it is' : 'they are'} — the category is full.`
    )
  }
  return planned
}

/**
 * Decide the whole section for one project.
 *
 * @param {{id: string, name: string, docsSlug?: string|null}} project
 * @param {{
 *   roleId?: string|null,
 *   roleNames?: Map<string,string>,
 *   categoryId?: string|null,
 *   categoryName?: string|null,
 *   categoryChannelCount?: number,
 *   channels?: Object<string, {id: string, name: string, parentId: string|null}>,
 *   tasks?: Array<{id: string, title: string, type: string, channelId: string, channelName: string, parentId: string|null}>,
 *   takenNames?: Set<string>,
 * }} observed a plain snapshot the caller gathers — no Discord objects
 */
export function planProjectSection(project, observed = {}) {
  const warnings = []
  const role = planRole(project, observed, warnings)
  const category = planCategory(project, observed)
  const channels = planChannels(project, observed)
  const tasks = planTasks(project, observed, channels, warnings)
  return { role, category, channels, tasks, warnings }
}
