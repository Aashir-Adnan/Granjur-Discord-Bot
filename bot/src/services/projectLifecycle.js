// Soft-deleting and reactivating a project (`/projects` → Delete project /
// Reactivate project). The row is the source of truth and is changed FIRST
// both ways, so everything that reads projects hides (or shows) it at once even
// if the Discord part is slow or partly fails:
//
//   delete     — mark the row, stop running clocks on its tasks, move each
//                task channel into a hidden, read-only archive category
//                (`🗄 ARCHIVED PROJECTS`, then `… 2` once one holds 50), then
//                remove the section's channels, its category and its role, and
//                null the ids the row kept for them.
//   reactivate — un-mark the row, rebuild the section with `setupOneProject`
//                (whose task pass moves the task channels back in), rebuild
//                each task channel's overwrites the way a new one is built,
//                relock the finished ones, and drop any empty archive category.
//
// Nothing in the database is deleted. Each Discord step is caught on its own
// and reported in `failures`; the project stays deleted (or reactivated)
// regardless. Every dependency is a parameter, so tests pass fakes only.
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { ARCHIVE_CATEGORY_BASE } from '../utils/projectDeleted.js'
import { taskChannelOverwrites } from './taskTicketChannel.js'
import { lockTicketChannel } from '../utils/channels.js'
import { isFinished } from '../utils/ticketArchive.js'
import { isTicketChannel } from '../utils/taskChannelName.js'
import { holdersOf } from '../utils/taskLabel.js'
import { storedChannels } from '../utils/projectStore.js'
import { closeEntry } from './clock.js'
import { setupOneProject } from '../commands/project-setup.js'

/** Discord's hard limit on the channels in one category. */
export const ARCHIVE_CATEGORY_LIMIT = 50

/** How many of the project's tasks are read (newest first) for archiving and restoring. */
const TASK_LIMIT = 2000

/** The note written on a clock entry this stops. */
const CLOCK_NOTE = 'Project deleted'

/** The line a reactivation reply carries when the section could not be rebuilt. */
export const SECTION_REBUILD_FAILED = 'Section rebuild failed — run /project-setup for it.'

const UNKNOWN_CHANNEL = 10003
const UNKNOWN_ROLE = 10011

const errText = (e) => e?.message ?? String(e)

/** `🗄 ARCHIVED PROJECTS` for the first, `🗄 ARCHIVED PROJECTS <n>` after it. Pure. */
export function archiveCategoryName(n) {
  return n <= 1 ? ARCHIVE_CATEGORY_BASE : `${ARCHIVE_CATEGORY_BASE} ${n}`
}

const cachedChannels = (guild) => (guild?.channels?.cache?.values ? [...guild.channels.cache.values()] : [])

const childCount = (guild, categoryId) => cachedChannels(guild).filter((c) => c?.parentId === categoryId).length

/** Is this one of the archive categories (`🗄 ARCHIVED PROJECTS`, `… 2`, …)? */
function isArchiveCategory(channel) {
  if (channel?.type !== ChannelType.GuildCategory) return false
  const name = String(channel.name ?? '')
  if (name === ARCHIVE_CATEGORY_BASE) return true
  const rest = name.startsWith(`${ARCHIVE_CATEGORY_BASE} `) ? name.slice(ARCHIVE_CATEGORY_BASE.length + 1) : ''
  return /^\d+$/.test(rest)
}

/**
 * The first archive category with room (fewer than 50 channels), walking
 * `🗄 ARCHIVED PROJECTS`, `… 2`, `… 3`; the first name in that walk that does
 * not exist yet is created, with `@everyone` denied ViewChannel. Found by name:
 * nothing stores its id. Counted from the channel cache, which Discord keeps
 * current as each channel is moved, so calling this once per channel never
 * puts a 51st into one.
 */
export async function ensureArchiveCategory(guild) {
  const all = cachedChannels(guild)
  for (let n = 1; ; n++) {
    const name = archiveCategoryName(n)
    const category = all.find((c) => c?.type === ChannelType.GuildCategory && c.name === name)
    if (!category) {
      return guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] }],
      })
    }
    if (childCount(guild, category.id) < ARCHIVE_CATEGORY_LIMIT) return category
  }
}

/**
 * Park one task channel: into the archive category, and its overwrites
 * replaced by `@everyone` denied view and send — hidden and read-only for
 * everyone but admins, discussion kept. One edit.
 */
export async function archiveTaskChannel(guild, channel, archiveCategory) {
  return channel.edit({
    parent: archiveCategory.id,
    permissionOverwrites: [
      {
        id: guild.id,
        type: OverwriteType.Role,
        deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      },
    ],
  })
}

/**
 * Give an archived task channel back its audience: the overwrites a new task
 * channel gets (`taskChannelOverwrites` — `@everyone` denied, the project role
 * allowed when the channel is inside the project's category, the creator and
 * each holder allowed). A finished task's channel is then locked again.
 *
 * @returns {Promise<{edited: number, failed: number}|null>} the relock's counts, null when not finished
 */
export async function restoreTaskChannel(guild, channel, { task, project }) {
  const inSection = Boolean(project?.discordCategoryId) && channel.parentId === project.discordCategoryId
  const permissionOverwrites = taskChannelOverwrites(guild, {
    project,
    memberIds: [task?.createdBy, ...holdersOf(task)],
    inSection,
  })
  const edited = (await channel.edit({ permissionOverwrites })) ?? channel
  if (!isFinished(task?.status)) return null
  return lockTicketChannel(edited)
}

/**
 * A channel or role by id: `{ item }`, `{ gone: true }` when Discord says it no
 * longer exists, or `{ error }` when the lookup failed for another reason.
 */
async function lookup(manager, id, goneCode) {
  const cached = manager?.cache?.get?.(id)
  if (cached) return { item: cached }
  try {
    const item = await manager.fetch(id)
    return item ? { item } : { gone: true }
  } catch (e) {
    if (e?.code === goneCode || e?.status === 404) return { gone: true }
    return { error: e }
  }
}

/**
 * The task rows whose channel is their own. A channel several rows name is a
 * meeting's shared review channel, not a ticket (the same rule the section
 * observer applies), and is never archived or restored with one project.
 */
function ownChannelTasks(tasks) {
  const counts = new Map()
  for (const t of tasks) if (t?.discordChannelId) counts.set(t.discordChannelId, (counts.get(t.discordChannelId) ?? 0) + 1)
  return tasks.filter((t) => t?.discordChannelId && counts.get(t.discordChannelId) === 1)
}

function readTasks(dbArg, guildConfigId, projectId) {
  return dbArg.task.findMany({ where: { guildConfigId, projectId, includeDeleted: true }, take: TASK_LIMIT })
}

/**
 * Soft-delete a project. See the file header for the order.
 *
 * @param {{db: object, guild: import('discord.js').Guild, cfg?: {id: string, clockedInRoleId?: string|null}|null,
 *   project: object, actorId?: string|null, now?: Date}} opts
 * @returns {Promise<{archived: number, removed: number, stoppedClocks: number, failures: string[]}>}
 *   Throws only when the row itself could not be marked (then nothing was done).
 */
export async function deleteProject({ db: dbArg, guild, cfg = null, project, actorId = null, now = new Date() }) {
  const failures = []
  const fail = (what, e) => {
    console.warn(`[projectLifecycle] delete ${project?.name ?? project?.id}: ${what}:`, errText(e))
    failures.push(`Could not ${what}: ${errText(e)}`)
  }
  const guildConfigId = project.guildConfigId ?? cfg?.id

  // 1. The row first: from here on every list hides it, whatever Discord does.
  await dbArg.project.update({ where: { id: project.id }, data: { deletedAt: now, deletedBy: actorId } })

  let tasks = []
  try {
    tasks = (await readTasks(dbArg, guildConfigId, project.id)) ?? []
  } catch (e) {
    fail('read its tasks, so no task channel was archived', e)
  }

  // 2. Running clocks on its tasks stop now, so "who is clocked in" never
  //    names a task nobody can see. The Clocked In role goes, as /clock-out
  //    takes it; a member who cannot be fetched keeps it (best effort).
  let stoppedClocks = 0
  const taskIds = new Set(tasks.map((t) => String(t.id)))
  let open = []
  try {
    open = (await dbArg.clockEntry.findMany({ where: { guildConfigId, openOnly: true } })) ?? []
  } catch (e) {
    fail('read the running clocks', e)
  }
  for (const entry of open) {
    if (!entry?.taskId || !taskIds.has(String(entry.taskId))) continue
    try {
      await closeEntry(dbArg, entry, { at: now, note: CLOCK_NOTE, source: 'auto_stopped' })
      stoppedClocks += 1
    } catch (e) {
      fail(`stop <@${entry.discordId}>'s running clock`, e)
      continue
    }
    if (cfg?.clockedInRoleId) {
      const member = await guild.members.fetch(entry.discordId).catch(() => null)
      if (member) await member.roles.remove(cfg.clockedInRoleId).catch(() => {})
    }
  }

  // 3. Each task channel into the archive, before its category goes.
  let archived = 0
  for (const task of ownChannelTasks(tasks)) {
    const found = await lookup(guild.channels, task.discordChannelId, UNKNOWN_CHANNEL)
    if (found.gone) continue
    if (found.error) {
      fail(`find task channel ${task.discordChannelId}`, found.error)
      continue
    }
    const channel = found.item
    if (!isTicketChannel(channel)) continue
    try {
      await archiveTaskChannel(guild, channel, await ensureArchiveCategory(guild))
      archived += 1
    } catch (e) {
      fail(`archive #${channel.name}`, e)
    }
  }

  // 4. The section: its channels (the archive divider among them), then the
  //    category, then the role. One already gone is simply skipped.
  let removed = 0
  const remove = async (manager, id, goneCode, label) => {
    if (!id) return
    const found = await lookup(manager, id, goneCode)
    if (found.gone) return
    if (found.error) return fail(`find ${label(null)}`, found.error)
    try {
      await found.item.delete()
      removed += 1
    } catch (e) {
      fail(`delete ${label(found.item)}`, e)
    }
  }
  for (const id of Object.values(storedChannels(project))) {
    await remove(guild.channels, id, UNKNOWN_CHANNEL, (c) => (c ? `#${c.name}` : `channel ${id}`))
  }
  await remove(guild.channels, project.discordCategoryId, UNKNOWN_CHANNEL, (c) =>
    c ? `the category ${c.name}` : 'its category'
  )
  await remove(guild.roles, project.discordRoleId, UNKNOWN_ROLE, () => 'its role')

  // 5. The row forgets them; a reactivation builds fresh ones.
  try {
    await dbArg.project.update({
      where: { id: project.id },
      data: { discordCategoryId: null, discordRoleId: null, discordChannels: null },
    })
  } catch (e) {
    fail('clear its stored channel, category and role ids', e)
  }

  return { archived, removed, stoppedClocks, failures }
}

/**
 * Reactivate a soft-deleted project. See the file header for the order.
 *
 * @param {{db: object, guild: import('discord.js').Guild, cfg: {id: string}, project: object,
 *   botUserId?: string|null, setup?: typeof setupOneProject}} opts
 * @returns {Promise<{restored: number, failures: string[]}>}
 *   Throws only when the row itself could not be un-marked (then nothing was done).
 */
export async function reactivateProject({ db: dbArg, guild, cfg, project, botUserId = null, setup = setupOneProject }) {
  const failures = []
  const fail = (what, e) => {
    console.warn(`[projectLifecycle] reactivate ${project?.name ?? project?.id}: ${what}:`, errText(e))
    failures.push(`Could not ${what}: ${errText(e)}`)
  }
  const reread = async (fallback) => (await dbArg.project.findFirst({ where: { id: project.id } }).catch(() => null)) ?? fallback

  // 1. The row first, so the rebuild and every list see a live project.
  await dbArg.project.update({ where: { id: project.id }, data: { deletedAt: null, deletedBy: null } })
  const fresh = await reread({ ...project, deletedAt: null, deletedBy: null })

  // 2. The section, through the same routine /project-setup runs. Its task
  //    pass moves every task channel that still exists into the new category.
  let rebuilt = false
  try {
    const out = await setup(guild, fresh, { db: dbArg, cfg, botUserId })
    rebuilt = Boolean(out?.result?.category)
  } catch (e) {
    console.error(`[projectLifecycle] reactivate ${project?.name ?? project?.id}: section rebuild:`, e)
  }
  if (!rebuilt) failures.push(SECTION_REBUILD_FAILED)

  // 3. Each task channel's overwrites, against the ids the rebuild just stored.
  const current = await reread(fresh)
  let tasks = []
  try {
    tasks = (await readTasks(dbArg, cfg?.id ?? project.guildConfigId, project.id)) ?? []
  } catch (e) {
    fail('read its tasks, so no task channel was restored', e)
  }
  let restored = 0
  for (const task of ownChannelTasks(tasks)) {
    const found = await lookup(guild.channels, task.discordChannelId, UNKNOWN_CHANNEL)
    if (found.gone) continue
    if (found.error) {
      fail(`find task channel ${task.discordChannelId}`, found.error)
      continue
    }
    const channel = found.item
    if (!isTicketChannel(channel)) continue
    try {
      const lock = await restoreTaskChannel(guild, channel, { task, project: current })
      restored += 1
      if (lock?.failed) failures.push(`Could not lock #${channel.name} again: ${lock.failed} overwrite(s) refused.`)
    } catch (e) {
      fail(`restore #${channel.name}`, e)
    }
  }

  // 4. An archive category nothing is left in.
  for (const category of cachedChannels(guild).filter(isArchiveCategory)) {
    if (childCount(guild, category.id) > 0) continue
    try {
      await category.delete()
    } catch (e) {
      fail(`delete the empty ${category.name}`, e)
    }
  }

  return { restored, failures }
}

/** The delete reply: the result line, then one line per failed step. Pure. */
export function deleteReply(name, { archived = 0, stoppedClocks = 0, failures = [] } = {}) {
  let head = `Deleted **${name}**. Archived ${archived} task channels; removed its section and role.`
  if (stoppedClocks > 0) head += ` Stopped ${stoppedClocks} running clocks.`
  return [head, ...failures].join('\n')
}

/** The reactivate reply: the result line, then one line per failed step. Pure. */
export function reactivateReply(name, { restored = 0, failures = [] } = {}) {
  return [`Reactivated **${name}**. Rebuilt its section; restored ${restored} task channels.`, ...failures].join('\n')
}
