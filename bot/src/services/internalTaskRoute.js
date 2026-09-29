// Loopback-only routes through which CSAAS asks the bot to change, create or
// extend a task on behalf of a signed-in website user. Guarded by a shared
// secret compared in constant time; disabled entirely when the secret is unset.
import { timingSafeEqual } from 'node:crypto'
import db from '../db/index.js'
import { applyTaskUpdate } from './taskStatusChange.js'
import { TASK_STATUSES } from '../utils/taskDeps.js'
import { TaskRuleError } from '../utils/taskHierarchy.js'
import { validateCreate, validateEdit } from '../utils/taskEditRules.js'
import { applyEdit, projectMoveNote } from './taskEdit.js'
import { createTask } from './taskCreate.js'
import { resolveTaskRepo, loadProjectLinks } from './taskRepo.js'
import { createSubtask } from './taskHierarchy.js'
import { notifyTaskUpdate } from './taskUpdateNotify.js'

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

const bad = (message) => ({ status: 400, body: { ok: false, message } })

/**
 * The part every internal route shares: disabled without a secret (503),
 * refused without the right header (401), the body normalised to an object
 * before anything reads it, a TaskRuleError is the caller's to fix (409), and
 * anything else thrown is a logged 500 — never a hung response.
 */
async function guarded({ headers = {}, body, secret, route }, handler) {
  if (!secret) return { status: 503, body: { ok: false, message: 'internal route not configured' } }
  if (!safeEqual(headers['x-internal-secret'], secret)) return { status: 401, body: { ok: false, message: 'unauthorized' } }
  try {
    // A default parameter only fires on `undefined`; a JSON body of `null` (or
    // any non-object) must not reach a property read, so it's normalized here.
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    return await handler(b)
  } catch (e) {
    if (e instanceof TaskRuleError) return { status: 409, body: { ok: false, message: e.message } }
    console.error(`[internal] ${route} route:`, e?.message ?? e)
    return { status: 500, body: { ok: false, message: e?.message || 'internal error' } }
  }
}

/**
 * Who the site says did this. The label names them in the channel post; the
 * email match (a Discord id) attributes the activity row and, for a create, the
 * creator — never a mention. No match is fine.
 */
async function siteActor(dbArg, guildConfigId, actor) {
  const name = String(actor?.name || actor?.email || 'Someone').slice(0, 100)
  // CSAAS sends the caller's stored Discord link (identity link, 2026-09-28).
  // Trusted like the rest of the body (the shared secret); only its shape is checked.
  const linked = typeof actor?.discordId === 'string' && /^\d{1,32}$/.test(actor.discordId) ? actor.discordId : null
  if (linked) return { label: `${name} (via the site)`, activityId: linked }
  let activityId = null
  const email = String(actor?.email ?? '').trim()
  if (email) {
    try {
      const member = await dbArg.guildMember.findByConfigEmail({ where: { guildConfigId, email } })
      activityId = member?.discordId ?? null
    } catch (e) {
      console.error('[internal] actor lookup:', e?.message ?? e)
    }
  }
  return { label: `${name} (via the site)`, activityId }
}

/** A task id from the body, or a 400 message. */
function idFrom(value, field) {
  const id = String(value ?? '').trim()
  if (!id) return [`${field} is required`]
  if (id.length > 64) return [`${field} is too long (max 64)`]
  return [null, id]
}

/** At most this many ids in `hiddenTaskIds` (CSAAS caps its list at the same number). */
export const MAX_HIDDEN_IDS = 200

/**
 * `hiddenTaskIds` from the body as a Set: the tasks related to the target (its
 * blockers, what it blocks, its subtasks) that the site caller cannot see, so
 * the reply names them generically. Anything but an array of at most 200
 * non-empty strings of at most 64 characters is ignored (an empty Set).
 */
export function redactSetFrom(value) {
  if (!Array.isArray(value) || value.length > MAX_HIDDEN_IDS) return new Set()
  if (!value.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 64)) return new Set()
  return new Set(value)
}

/** The Discord ids of every member row in a guild. */
async function memberIdsOf(dbArg, guildConfigId) {
  const rows = await dbArg.guildMember.findMany({ where: { guildConfigId, all: true } })
  return new Set((rows || []).map((m) => String(m.discordId)))
}

async function guildOf(dbArg, client, guildConfigId) {
  const cfg = await dbArg.guildConfig.findById(guildConfigId)
  return { cfg, guild: cfg ? client?.guilds?.cache?.get(cfg.guildId) ?? null : null }
}

export async function handleStatusRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, apply = applyTaskUpdate }) {
  return guarded({ headers, body, secret, route: 'status' }, async (b) => {
    const [idErr, taskId] = idFrom(b.taskId, 'taskId')
    if (idErr) return bad(idErr)
    const status = String(b.status ?? '').trim()
    if (!TASK_STATUSES.includes(status)) return bad(`status must be one of ${TASK_STATUSES.join(', ')}`)
    const task = await dbArg.task.findFirst({ where: { id: taskId } })
    if (!task) return { status: 404, body: { ok: false, message: 'Task not found' } }
    if (task.status === status) return { status: 200, body: { ok: true, task: { id: task.id, status }, warning: '', unchanged: true } }
    const actor = await siteActor(dbArg, task.guildConfigId, b.actor)
    const { warning } = await apply({ db: dbArg, client, task, updates: { status }, actor, redact: redactSetFrom(b.hiddenTaskIds) })
    return { status: 200, body: { ok: true, task: { id: task.id, status }, warning: warning || '', unchanged: false } }
  })
}

/** A site edit: every field `/update-task` and the task hub can change, checked whole before anything is written. */
export async function handleUpdateRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, edit = applyEdit }) {
  return guarded({ headers, body, secret, route: 'update' }, async (b) => {
    const [idErr, taskId] = idFrom(b.taskId, 'taskId')
    if (idErr) return bad(idErr)
    const task = await dbArg.task.findFirst({ where: { id: taskId } })
    if (!task) return { status: 404, body: { ok: false, message: 'Task not found' } }
    const changes = b.changes
    const has = (k) => changes && typeof changes === 'object' && Object.prototype.hasOwnProperty.call(changes, k)

    // Load only what the changes need, all from the task's own guild.
    const ctx = { projectsById: new Map(), memberIds: new Set(), tasksById: new Map(), deps: [] }
    if (has('projectId') && changes.projectId) {
      const p = await dbArg.project.findFirst({ where: { id: String(changes.projectId) } })
      if (p && p.guildConfigId === task.guildConfigId) ctx.projectsById.set(p.id, p)
    }
    if (has('holderIds')) ctx.memberIds = await memberIdsOf(dbArg, task.guildConfigId)
    if (has('blockerIds') && Array.isArray(changes.blockerIds)) {
      const ids = changes.blockerIds.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
      const rows = ids.length ? await dbArg.task.findByIds({ where: { guildConfigId: task.guildConfigId, ids } }) : []
      ctx.tasksById = new Map(rows.map((r) => [String(r.id), r]))
      ctx.deps = await dbArg.taskDependency.findManyForGuild({ where: { guildConfigId: task.guildConfigId } })
    }

    const v = validateEdit(task, changes, ctx)
    if (v.error) return bad(v.error)
    if (!Object.keys(v.updates).length && !v.blockers.add.length && !v.blockers.remove.length) {
      return { status: 200, body: { ok: true, task: { id: task.id, status: task.status }, warning: '', lines: [], unchanged: true } }
    }
    const actor = await siteActor(dbArg, task.guildConfigId, b.actor)
    const r = await edit({
      db: dbArg, client, cfg: { id: task.guildConfigId }, task, updates: v.updates, blockers: v.blockers, actor,
      redact: redactSetFrom(b.hiddenTaskIds),
    })
    // Validation already passed, so a refusal here is the state changing under
    // us (a subtask reopened, a blocker deleted) — a conflict, not bad input.
    if (r?.error) return { status: 409, body: { ok: false, message: r.error } }
    const warning = [r?.warning, projectMoveNote(task, v.updates)].filter(Boolean).join('\n')
    return {
      status: 200,
      body: { ok: true, task: { id: task.id, status: v.updates.status ?? task.status }, warning, lines: r?.dep?.lines ?? [], unchanged: false },
    }
  })
}

/** Why a new task's channel is not in its project's section, in plain words ('' when it is). */
function placementNote(project, type, fellBack) {
  const label = type === 'bug' ? 'Bugs' : 'Features'
  if (fellBack === 'cap') return `${project.name}'s section is full, so the channel went to the global ${label} category.`
  if (fellBack === 'missing') return `${project.name} has no Discord section yet, so the channel went to the global ${label} category. Run /project-setup for it.`
  return ''
}

/** A site create: a Feature or a Bug under a project, made exactly as /create-task makes it. */
export async function handleCreateRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, create = createTask }) {
  return guarded({ headers, body, secret, route: 'create' }, async (b) => {
    const [idErr, projectId] = idFrom(b.projectId, 'projectId')
    if (idErr) return bad(idErr)
    const project = await dbArg.project.findFirst({ where: { id: projectId } })
    if (!project) return bad('No project matches that id.')
    const { cfg, guild } = await guildOf(dbArg, client, project.guildConfigId)
    if (!cfg || !guild) return { status: 500, body: { ok: false, message: 'The Discord server is not available to the bot right now.' } }

    const memberIds = await memberIdsOf(dbArg, cfg.id)
    const repos = await dbArg.repository.findMany({ where: { guildConfigId: cfg.id } })
    const reposById = new Map((repos || []).map((r) => [String(r.id), r]))
    const v = validateCreate(b, { project, memberIds, reposById })
    if (v.error) return bad(v.error)

    if (v.fields.type === 'bug') {
      const links = await loadProjectLinks(dbArg, project.id)
      const { repository: ruled } = resolveTaskRepo({ projectId: project.id, scope: v.fields.scope }, { links, repos })
      if (!ruled && !v.fields.repositoryIds[0]) {
        return bad('This project has no repository for this scope — pick a repository for the bug.')
      }
    }

    const { label, activityId } = await siteActor(dbArg, cfg.id, b.actor)
    const repo = v.fields.type === 'bug' && v.fields.repositoryIds[0] ? reposById.get(v.fields.repositoryIds[0]) : null
    const made = await create({
      db: dbArg, guild, cfg, fields: v.fields, project, repo,
      actor: { discordId: activityId, label, viaSite: true },
      createIssue: b.createIssue !== false,
    })
    return {
      status: 200,
      body: {
        ok: true,
        task: { id: made.task.id, type: made.task.type ?? v.fields.type, status: made.task.status, projectId: project.id },
        channelId: made.channel?.id ?? null,
        fellBack: made.fellBack ?? null,
        note: placementNote(project, v.fields.type, made.fellBack ?? null),
        issue: made.issue ?? null,
      },
    }
  })
}

/**
 * A site "Add subtask": createSubtask with the site user as the actor. Its
 * replies name no other task today; `hiddenTaskIds` is still accepted and
 * passed on as `redact` so a future text that does is scrubbed the same way.
 */
export async function handleSubtaskRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, addSubtask = createSubtask }) {
  return guarded({ headers, body, secret, route: 'subtask' }, async (b) => {
    const [idErr, parentId] = idFrom(b.parentId, 'parentId')
    if (idErr) return bad(idErr)
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    if (!title) return bad('A subtask needs a title.')
    if (title.length > 200) return bad('The title can be at most 200 characters.')
    const parent = await dbArg.task.findFirst({ where: { id: parentId } })
    if (!parent) return { status: 404, body: { ok: false, message: 'Task not found' } }
    let assigneeIds = []
    if (b.holderIds !== undefined) {
      const v = validateEdit(parent, { holderIds: b.holderIds }, { memberIds: await memberIdsOf(dbArg, parent.guildConfigId) })
      if (v.error) return bad(v.error)
      assigneeIds = [...new Set(b.holderIds.map((id) => id.trim()).filter(Boolean))]
    }
    const actor = await siteActor(dbArg, parent.guildConfigId, b.actor)
    const { guild } = await guildOf(dbArg, client, parent.guildConfigId)
    const child = await addSubtask({
      db: dbArg, client, guild, parent, fields: { title, assigneeIds }, actor,
      notify: notifyTaskUpdate, apply: applyTaskUpdate, redact: redactSetFrom(b.hiddenTaskIds),
    })
    return { status: 200, body: { ok: true, task: { id: child.id, status: child.status, parentId: child.parentTaskId ?? parent.id } } }
  })
}
