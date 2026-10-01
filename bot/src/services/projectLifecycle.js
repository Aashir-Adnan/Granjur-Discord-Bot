// Soft-deleting and reactivating a project (`/projects` → Delete project /
// Reactivate project). The row is the source of truth and is changed FIRST
// both ways, so everything that reads projects hides (or shows) it at once even
// if the Discord part is slow or partly fails:
//
//   delete     — mark the row, stop running clocks on its tasks, move each
//                task channel into a hidden, read-only archive category
//                (`🗄 ARCHIVED PROJECTS`, then `… 2` once one holds 50), then
//                remove the section's stored channels, archive every other
//                channel still in its category (ids recorded under
//                `discordChannels.archived`), remove the category (kept when
//                any channel could not be archived) and its role, and null the
//                ids of what is gone (what could not be removed stays stored).
//   reactivate — un-mark the row, rebuild the section with `setupOneProject`
//                (whose task pass moves the task channels back in), move the
//                recorded `archived` channels back, only into the project's own
//                category (with its overwrites; any other stays archived and is
//                named), rebuild each task channel's
//                overwrites the way a new one is built (moving one the rebuild
//                left in the archive to where a new one would go; a client
//                request's also naming the project's client managers), relock
//                the finished ones, and drop any empty archive category.
//
// Nothing in the database is deleted. Each Discord step is caught on its own
// and reported in `failures`; the project stays deleted (or reactivated)
// regardless. Every dependency is a parameter, so tests pass fakes only.
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { ARCHIVE_CATEGORY_BASE } from '../utils/projectDeleted.js'
import { taskChannelOverwrites, resolveParentCategory, categoryHasRoom } from './taskTicketChannel.js'
import { lockTicketChannel } from '../utils/channels.js'
import { isFinished } from '../utils/ticketArchive.js'
import { isTicketChannel } from '../utils/taskChannelName.js'
import { holdersOf } from '../utils/taskLabel.js'
import { storedChannels, archivedChannelIds, ARCHIVED_STORE_KEY } from '../utils/projectStore.js'
import { managerIdsOf } from '../utils/clientRoles.js'
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

/** The delete reply's line when a task channel could not be archived, so the category stays. */
export const CATEGORY_KEPT = 'Kept the section category because some task channels could not be archived.'

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
 * A channel the rebuild left in an archive category (its task pass reads a
 * capped number of tasks and respects the section's channel cap) is moved in
 * the same edit to where a new task channel would go (`resolveParentCategory`):
 * the project's category when it has room, else the global Features/Bugs one.
 * A live ticket must never sit, open to its members, under "archived".
 *
 * `managerIds` are the project's client managers (`managerIdsOf` over its
 * roster); they are added only when the task is a client request
 * (`requestedBy` set). A meeting task's approver is not stored on its row, so a
 * mirrored task's channel comes back without them.
 *
 * @returns {Promise<{edited: number, failed: number}|null>} the relock's counts, null when not finished
 */
export async function restoreTaskChannel(guild, channel, { task, project, managerIds = [] }) {
  const payload = {}
  let inSection = Boolean(project?.discordCategoryId) && channel.parentId === project.discordCategoryId
  if (inArchive(guild, channel)) {
    const { category, fellBack } = await resolveParentCategory(guild, project, task?.type === 'bug' ? 'Bugs' : 'Features')
    payload.parent = category.id
    inSection = !fellBack
  }
  payload.permissionOverwrites = taskChannelOverwrites(guild, {
    project,
    // A client request's channel is also its project's client managers' (the
    // rule `clientRequest.js` creates it by and `/project-members` keeps).
    memberIds: [task?.createdBy, ...holdersOf(task), ...(task?.requestedBy ? managerIds : [])],
    inSection,
  })
  const edited = (await channel.edit(payload)) ?? channel
  if (!isFinished(task?.status)) return null
  return lockTicketChannel(edited)
}

/** Is this channel inside one of the archive categories? */
function inArchive(guild, channel) {
  return Boolean(channel?.parentId) && isArchiveCategory(guild?.channels?.cache?.get?.(channel.parentId))
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
  // Any task channel that may still sit in the section with its members'
  // overwrites. Deleting the category would lift it to the top level, open.
  let archiveIncomplete = false
  try {
    tasks = (await readTasks(dbArg, guildConfigId, project.id)) ?? []
  } catch (e) {
    archiveIncomplete = true
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
  // Tried here, moved or not: the sweep in 4b does not try (or report) it twice.
  const attempted = new Set()
  for (const task of ownChannelTasks(tasks)) {
    const found = await lookup(guild.channels, task.discordChannelId, UNKNOWN_CHANNEL)
    if (found.gone) continue
    if (found.error) {
      archiveIncomplete = true
      fail(`find task channel ${task.discordChannelId}`, found.error)
      continue
    }
    const channel = found.item
    if (!isTicketChannel(channel)) continue
    attempted.add(channel.id)
    try {
      await archiveTaskChannel(guild, channel, await ensureArchiveCategory(guild))
      archived += 1
    } catch (e) {
      archiveIncomplete = true
      fail(`archive #${channel.name}`, e)
    }
  }

  // 4. The section: its channels (the archive divider among them), then the
  //    category, then the role. One already gone is simply skipped. `remove`
  //    says whether the object is gone now (deleted, or already missing).
  let removed = 0
  const remove = async (manager, id, goneCode, label) => {
    if (!id) return true
    const found = await lookup(manager, id, goneCode)
    if (found.gone) return true
    if (found.error) {
      fail(`find ${label(null)}`, found.error)
      return false
    }
    try {
      await found.item.delete()
      removed += 1
      return true
    } catch (e) {
      fail(`delete ${label(found.item)}`, e)
      return false
    }
  }
  const keptChannels = {}
  for (const [key, id] of Object.entries(storedChannels(project))) {
    const gone = await remove(guild.channels, id, UNKNOWN_CHANNEL, (c) => (c ? `#${c.name}` : `channel ${id}`))
    if (!gone) keptChannels[key] = id
  }

  // 4b. Whatever else is still in the category — a /meeting-channel pair, a
  //     legacy section channel whose id was never stored, a hand-made channel,
  //     one of the section's own that refused deletion — goes into the archive
  //     too, the same way, and its id is recorded so a reactivation brings it
  //     back. Deleting the category would otherwise lift it to the top level
  //     with the role's overwrite gone. One that cannot be moved keeps the
  //     category, exactly as a task channel does.
  const archivedIds = []
  const leftInSection = project.discordCategoryId
    ? cachedChannels(guild).filter((c) => c?.parentId === project.discordCategoryId && !attempted.has(c.id))
    : []
  for (const channel of leftInSection) {
    try {
      await archiveTaskChannel(guild, channel, await ensureArchiveCategory(guild))
      archivedIds.push(channel.id)
    } catch (e) {
      archiveIncomplete = true
      fail(`archive #${channel.name}`, e)
    }
  }

  let categoryGone = false
  if (archiveIncomplete && project.discordCategoryId) {
    failures.push(CATEGORY_KEPT)
  } else {
    categoryGone = await remove(guild.channels, project.discordCategoryId, UNKNOWN_CHANNEL, (c) =>
      c ? `the category ${c.name}` : 'its category'
    )
  }
  const roleGone = await remove(guild.roles, project.discordRoleId, UNKNOWN_ROLE, () => 'its role')

  // 5. The row forgets what is gone; a reactivation builds fresh ones. What
  //    could not be removed stays stored, so /project-setup and a reactivation
  //    still track it instead of building a duplicate beside it.
  const channelsLeft = archivedIds.length ? { ...keptChannels, [ARCHIVED_STORE_KEY]: archivedIds } : keptChannels
  const data = { discordChannels: Object.keys(channelsLeft).length ? channelsLeft : null }
  if (categoryGone) data.discordCategoryId = null
  if (roleGone) data.discordRoleId = null
  try {
    await dbArg.project.update({ where: { id: project.id }, data })
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
  // Read before the rebuild, whose single write of the section ids drops the list.
  const archivedIds = archivedChannelIds(fresh)
  let rebuilt = false
  let rebuildWarnings = []
  try {
    // `reactivating`: the rebuild must not refuse a row it may still read as deleted.
    const out = await setup(guild, fresh, { db: dbArg, cfg, botUserId, reactivating: true })
    rebuilt = Boolean(out?.result?.category)
    // What the rebuild itself could not do (a refused channel, a full category).
    rebuildWarnings = [...new Set([...(out?.plan?.warnings ?? []), ...(out?.result?.warnings ?? [])].map(String))]
  } catch (e) {
    console.error(`[projectLifecycle] reactivate ${project?.name ?? project?.id}: section rebuild:`, e)
  }
  if (!rebuilt) failures.push(SECTION_REBUILD_FAILED)
  failures.push(...rebuildWarnings.map((w) => `Rebuild: ${w}`))

  const current = await reread(fresh)

  // 3. The non-task channels the delete archived, back into the section with
  //    the category's overwrites (so the new role sees them), or where a new
  //    task channel would go when the category is full. Before the task pass,
  //    which then gives any task channel among them its own overwrites.
  //    A swept channel has no `@everyone` deny of its own, so it only ever goes
  //    where `lockPermissions` gives it the project's: its own category. With no
  //    category, or no room in it, it stays in the archive (still recorded) and
  //    is named in the reply — never into the server-wide category, which would
  //    show it to everyone.
  const placedBySetup = new Set(Object.values(storedChannels(current)))
  const projectCategory = rebuilt ? guild.channels.cache.get(current?.discordCategoryId) : null
  const stillArchived = []
  for (const id of archivedIds) {
    if (placedBySetup.has(id)) continue
    const found = await lookup(guild.channels, id, UNKNOWN_CHANNEL)
    if (found.gone) continue
    if (found.error) {
      fail(`find archived channel ${id}`, found.error)
      stillArchived.push(id)
      continue
    }
    const channel = found.item
    if (projectCategory?.type !== ChannelType.GuildCategory || !categoryHasRoom(guild, projectCategory.id)) {
      failures.push(`#${channel.name} stays in ${ARCHIVE_CATEGORY_BASE} — move it into the project's category by hand.`)
      stillArchived.push(id)
      continue
    }
    try {
      await channel.edit({ parent: projectCategory.id, lockPermissions: true })
    } catch (e) {
      fail(`restore #${channel.name}`, e)
      stillArchived.push(id)
    }
  }
  if (archivedIds.length) {
    // The rebuild's section ids stay; `archived` is exactly what is still in the archive.
    let latest = null
    try {
      latest = await dbArg.project.findFirst({ where: { id: project.id } })
    } catch {
      latest = null
    }
    if (!latest) {
      failures.push('Could not record which channels stayed archived.')
    } else {
      const next = storedChannels(latest)
      if (stillArchived.length) next[ARCHIVED_STORE_KEY] = stillArchived
      try {
        await dbArg.project.update({
          where: { id: project.id },
          data: { discordChannels: Object.keys(next).length ? next : null },
        })
      } catch (e) {
        fail('record which channels stayed archived', e)
      }
    }
  }

  // 4. Each task channel's overwrites, against the ids the rebuild just stored.
  let tasks = []
  try {
    tasks = (await readTasks(dbArg, cfg?.id ?? project.guildConfigId, project.id)) ?? []
  } catch (e) {
    fail('read its tasks, so no task channel was restored', e)
  }
  const owned = ownChannelTasks(tasks)
  // The client managers, for request channels only; read only when there is one.
  let managerIds = []
  if (owned.some((t) => t?.requestedBy)) {
    try {
      managerIds = managerIdsOf(await dbArg.projectMember.findByProject({ where: { projectId: project.id } }))
    } catch (e) {
      fail("read its client managers, so request channels came back without them", e)
    }
  }
  let restored = 0
  const seen = []
  for (const task of owned) {
    const found = await lookup(guild.channels, task.discordChannelId, UNKNOWN_CHANNEL)
    if (found.gone) continue
    if (found.error) {
      fail(`find task channel ${task.discordChannelId}`, found.error)
      continue
    }
    const channel = found.item
    if (!isTicketChannel(channel)) continue
    seen.push(channel)
    try {
      const lock = await restoreTaskChannel(guild, channel, { task, project: current, managerIds })
      restored += 1
      if (lock?.failed) failures.push(`Could not lock #${channel.name} again: ${lock.failed} overwrite(s) refused.`)
    } catch (e) {
      fail(`restore #${channel.name}`, e)
    }
  }
  // Said out loud: a task channel nothing managed to move out of the archive.
  for (const channel of seen) {
    if (!inArchive(guild, channel)) continue
    const where = guild.channels.cache.get(channel.parentId)?.name ?? ARCHIVE_CATEGORY_BASE
    failures.push(`#${channel.name} is still in ${where} — run /project-setup for it.`)
  }

  // 5. An archive category nothing is left in.
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
