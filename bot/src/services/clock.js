// The clock rules, in one place. /clock-in, /clock-out and the site's clock
// routes all call these, so the rules cannot drift between them. Nothing here
// talks to Discord interactions: `member` is optional and fetched on demand.

import db from '../db/index.js'
import { isLeadershipFor, memberProjectIdsOf } from '../utils/timeAccess.js'
import { clockableTasks } from '../utils/timeTaskPicker.js'
import { entryMinutes } from '../utils/timeTracking.js'
import { PROJECT_DELETED, projectIdIsDeleted } from '../utils/projectDeleted.js'

const NOTE_MAX = 500
const GENERAL_TITLE = 'General work'

/** A refusal that is safe to show the person who asked. */
export class ClockError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ClockError'
  }
}

/** Close an open entry, writing its duration. */
export async function closeEntry(dbArg, entry, { at = new Date(), note = null, source } = {}) {
  const minutes = entryMinutes(entry.clockInAt, at)
  const data = { clockOutAt: at, minutes }
  if (note) data.note = note
  if (source) data.source = source
  await dbArg.clockEntry.update(entry.id, data)
  return minutes
}

const taskOf = (dbArg, cfg, taskId) =>
  dbArg.task.findFirst({ where: { id: taskId, guildConfigId: cfg.id } }).catch(() => null)

const wholeSeconds = (from, now) =>
  Math.max(0, Math.floor((new Date(now).getTime() - new Date(from).getTime()) / 1000)) || 0

export async function clockIn({ db: dbArg = db, cfg, guild, discordId, taskId = null, member, now = new Date() }) {
  // Fetched at most once: leadership needs it for a task, the role needs it to start.
  let resolved = member
  const memberOf = async () => {
    if (resolved === undefined || resolved === null) resolved = await guild.members.fetch(discordId).catch(() => null)
    return resolved
  }

  // A task that does not exist and one the caller cannot use get the same
  // message, so this cannot be used to probe for tasks.
  let task = null
  if (taskId) {
    task = await dbArg.task.findFirst({ where: { id: taskId, guildConfigId: cfg.id } })
    const allowed = task
      ? clockableTasks([task], {
          memberProjectIds: await memberProjectIdsOf(dbArg, cfg, discordId),
          isLeadership: isLeadershipFor(guild, await memberOf(), cfg),
          callerId: discordId,
        }).length > 0
      : false
    if (!allowed) throw new ClockError('That task is not available to clock in on.')
    if (await taskProjectDeleted(dbArg, task.projectId)) throw new ClockError(PROJECT_DELETED)
  }
  const wanted = task ? task.id : null

  const active = await dbArg.clockEntry.findActive(guild.id, discordId)

  if (active && (active.taskId ?? null) === wanted) {
    return { outcome: 'unchanged', task, stopped: null, runningMinutes: entryMinutes(active.clockInAt, now) }
  }

  let stopped = null
  if (active) {
    const minutes = await closeEntry(dbArg, active, { at: now })
    let title = 'general work'
    if (active.taskId) title = (await taskOf(dbArg, cfg, active.taskId))?.title ?? 'a task'
    stopped = { title, minutes }
  }

  await dbArg.clockEntry.create({
    data: { guildConfigId: cfg.id, discordId, clockInAt: now, taskId: wanted, source: 'timer' },
  })

  // Switching tasks keeps the person clocked in, so the role is left alone.
  if (!active && cfg.clockedInRoleId) {
    const m = await memberOf()
    if (m) await m.roles.add(cfg.clockedInRoleId).catch(() => {})
  }

  return { outcome: stopped ? 'switched' : 'started', task, stopped, runningMinutes: null }
}

export async function clockOut({ db: dbArg = db, cfg, guild, discordId, note, member, now = new Date() }) {
  const active = await dbArg.clockEntry.findActive(guild.id, discordId)
  if (!active) throw new ClockError('You are not clocked in.')

  const cleanNote = String(note ?? '').trim().slice(0, NOTE_MAX) || null
  const minutes = await closeEntry(dbArg, active, { at: now, note: cleanNote })

  if (cfg.clockedInRoleId) {
    const m = member ?? await guild.members.fetch(discordId).catch(() => null)
    if (m) await m.roles.remove(cfg.clockedInRoleId).catch(() => {})
  }

  if (!active.taskId) return { minutes, task: null, taskTotalMinutes: null }

  // A task that can no longer be found still counts as a task, not general work.
  const task = (await taskOf(dbArg, cfg, active.taskId)) ?? { id: active.taskId, title: 'a task' }
  // The total is a SQL SUM, not a sum over a capped list of entries, so a busy
  // task is never understated. The entry just closed is already included.
  let taskTotalMinutes = null
  try {
    const rows = await dbArg.clockEntry.sumByTask({ guildConfigId: cfg.id, taskIds: [active.taskId] })
    taskTotalMinutes = (rows || []).reduce((n, r) => n + Number(r.minutes || 0), 0)
  } catch (e) {
    console.error('[clock] task total:', e?.message ?? e)
  }
  return { minutes, task, taskTotalMinutes }
}

/**
 * Project id -> name for the guild, soft-deleted projects included (a timer
 * already running on a deleted project's task still names it), empty when the
 * lookup fails.
 */
async function projectNamesOf(dbArg, cfg) {
  const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id, includeDeleted: true } }).catch(() => [])
  return new Map((projects || []).map((p) => [String(p.id), String(p.name || '')]))
}

/**
 * Whether a task's project is soft-deleted, for clock-in and /log-time. A
 * project that cannot be read counts as not deleted (and is logged), as a
 * failed read does for the names above: a lookup must never turn clock-in
 * into a crash.
 */
export async function taskProjectDeleted(dbArg, projectId) {
  try {
    return await projectIdIsDeleted(dbArg, projectId)
  } catch (e) {
    console.error('[clock] project lookup:', e?.message ?? e)
    return false
  }
}

export async function clockStatus({ db: dbArg = db, cfg, guild, discordId, now = new Date() }) {
  const active = await dbArg.clockEntry.findActive(guild.id, discordId)
  if (!active) return { active: false }

  const taskId = active.taskId ?? null
  let taskTitle = GENERAL_TITLE
  let projectName = null
  if (taskId) {
    const task = await taskOf(dbArg, cfg, taskId)
    taskTitle = task?.title ?? 'a task'
    if (task?.projectId) projectName = (await projectNamesOf(dbArg, cfg)).get(String(task.projectId)) ?? null
  }
  return {
    active: true,
    entryId: active.id,
    taskId,
    taskTitle,
    projectName,
    clockInAt: active.clockInAt,
    elapsedSeconds: wholeSeconds(active.clockInAt, now),
  }
}

export async function clockedInNow({ db: dbArg = db, cfg, now = new Date() }) {
  const open = await dbArg.clockEntry.findMany({ where: { guildConfigId: cfg.id, openOnly: true } })
  if (!open?.length) return []

  // `all: true` or the roster is silently capped at 25.
  const members = await dbArg.guildMember.findMany({ where: { guildConfigId: cfg.id, all: true } }).catch(() => [])
  const byId = new Map((members || []).map((m) => [String(m.discordId), m]))
  const projectNames = await projectNamesOf(dbArg, cfg)

  const taskIds = [...new Set(open.map((e) => e.taskId).filter(Boolean))]
  const tasks = new Map()
  for (const id of taskIds) tasks.set(id, await taskOf(dbArg, cfg, id))

  return [...open]
    .sort((a, b) => new Date(a.clockInAt) - new Date(b.clockInAt))
    .map((e) => {
      const person = byId.get(String(e.discordId))
      const task = e.taskId ? tasks.get(e.taskId) : null
      const projectId = task?.projectId ?? null
      return {
        discordId: String(e.discordId),
        name: person?.displayName || String(e.discordId),
        avatarUrl: person?.avatarUrl ?? null,
        taskId: e.taskId ?? null,
        taskTitle: e.taskId ? (task?.title ?? 'a task') : GENERAL_TITLE,
        projectId,
        projectName: projectId ? (projectNames.get(String(projectId)) ?? null) : null,
        clockInAt: e.clockInAt,
        elapsedSeconds: wholeSeconds(e.clockInAt, now),
      }
    })
}
