// What a site edit or a site create may change, and the rule each value must
// meet. Pure: no Discord, no database — the bot's internal routes load the
// context (projects, members, tasks, dependency rows) and hand it in, so the
// rules are testable on their own and the routes stay thin.
//
// The rules are Discord's own: the value sets are the ones /update-task and
// /create-task offer as pickers, the limits are the slash options' and the
// task hub's. A site edit must never be able to write something Discord could
// not. Messages are plain text (no Discord markdown): the site shows them as-is.

import { TASK_STATUSES, wouldCycle } from './taskDeps.js'
import { SCOPE_VALUES } from './taskScope.js'
import { BAD_DURATION, MAX_STORABLE_MINUTES, parseDuration } from './timeTracking.js'
import { holdersOf, idList } from './taskLabel.js'

/** passedApiTests / passedQaTests / passedAcceptanceCriteria are signed TINYINT columns. */
export const MAX_TEST_COUNT = 127
export const ESTIMATE_TOO_LARGE = 'That estimate is too large to store.'
export const IMPLEMENTATION_STATUSES = ['not_started', 'in_progress', 'done']
export const TASK_TYPES = ['feature', 'bug']
export const TITLE_MAX = 200
export const DESCRIPTION_MAX = 2000
/** Holders and blockers: more than this in one request is not a real edit. */
export const MAX_IDS = 50
export const MAX_REPOSITORIES = 20
export const MAX_MODULES = 20
export const MODULE_MAX = 100

export const EDIT_KEYS = [
  'status', 'title', 'description', 'scope', 'implementationStatus', 'projectId',
  'holderIds', 'passedApiTests', 'passedQaTests', 'passedAcceptanceCriteria', 'estimate', 'blockerIds',
]
const COUNT_KEYS = ['passedApiTests', 'passedQaTests', 'passedAcceptanceCriteria']

const refuse = (error) => ({ error, updates: {}, blockers: { add: [], remove: [] } })

/** Distinct, trimmed, non-empty strings — or null when `value` is not a list of strings. */
function stringList(value) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return null
  return [...new Set(value.map((v) => v.trim()).filter(Boolean))]
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))

function titleOf(value) {
  if (typeof value !== 'string' || !value.trim()) return ['A task needs a title.']
  const t = value.trim()
  if (t.length > TITLE_MAX) return [`The title can be at most ${TITLE_MAX} characters.`]
  return [null, t]
}

function descriptionOf(value) {
  if (value !== null && value !== undefined && typeof value !== 'string') return ['The description must be text.']
  const d = String(value ?? '').trim()
  if (d.length > DESCRIPTION_MAX) return [`The description can be at most ${DESCRIPTION_MAX} characters.`]
  return [null, d || null]
}

function scopeOf(value) {
  if (value === null || value === undefined || value === '') return [null, null]
  if (!SCOPE_VALUES.includes(value)) return [`scope must be one of ${SCOPE_VALUES.join(', ')}, or empty`]
  return [null, value]
}

function holdersFrom(value, memberIds) {
  const ids = stringList(value)
  if (!ids) return ['holderIds must be a list of Discord ids.']
  if (ids.length > MAX_IDS) return [`A task can have at most ${MAX_IDS} people.`]
  const stranger = ids.find((id) => !memberIds.has(id))
  if (stranger) return [`${stranger} is not a member of this Discord server.`]
  return [null, ids]
}

/**
 * Check a site edit against `task` and turn it into the `updates` object
 * /update-task builds, plus the blocker adds and removes. Everything is checked
 * before anything is returned as writable: any refusal comes back with empty
 * `updates` and no blockers. Values equal to the stored ones are dropped, so a
 * form saved without touching a field writes nothing.
 */
export function validateEdit(task, changes, ctx = {}) {
  const { projectsById = new Map(), memberIds = new Set(), tasksById = new Map(), deps = [] } = ctx
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return refuse('changes must be an object.')
  const unknown = Object.keys(changes).find((k) => !EDIT_KEYS.includes(k))
  if (unknown) return refuse(`${unknown} cannot be changed.`)
  const c = changes
  const updates = {}

  if ('status' in c) {
    if (!TASK_STATUSES.includes(c.status)) return refuse(`status must be one of ${TASK_STATUSES.join(', ')}`)
    if (c.status !== task.status) updates.status = c.status
  }
  if ('title' in c) {
    const [err, t] = titleOf(c.title)
    if (err) return refuse(err)
    if (t !== task.title) updates.title = t
  }
  if ('description' in c) {
    const [err, d] = descriptionOf(c.description)
    if (err) return refuse(err)
    if (d !== (task.description ?? null)) updates.description = d
  }
  if ('scope' in c) {
    const [err, s] = scopeOf(c.scope)
    if (err) return refuse(err)
    if (s !== (task.scope ?? null)) updates.scope = s
  }
  if ('implementationStatus' in c) {
    if (!IMPLEMENTATION_STATUSES.includes(c.implementationStatus)) {
      return refuse(`implementationStatus must be one of ${IMPLEMENTATION_STATUSES.join(', ')}`)
    }
    if (c.implementationStatus !== task.implementationStatus) updates.implementationStatus = c.implementationStatus
  }
  if ('projectId' in c) {
    if (c.projectId === null || c.projectId === '') {
      if (task.projectId) { updates.projectId = null; updates.projectName = null }
    } else {
      const p = projectsById.get(String(c.projectId))
      if (!p) return refuse('No project matches that id.')
      if (p.id !== task.projectId) { updates.projectId = p.id; updates.projectName = p.name }
    }
  }
  if ('holderIds' in c) {
    const [err, ids] = holdersFrom(c.holderIds, memberIds)
    if (err) return refuse(err)
    // Written to assigneeIds for every type, as /update-task and the hub do: the
    // notifier and the activity log read only assigneeIds.
    if (!sameSet(ids, holdersOf(task))) {
      updates.assigneeIds = ids
      // holdersOf falls back to taggedMemberIds when assigneeIds is empty, so an
      // emptied bug would show its old tagged members again.
      if (!ids.length && idList(task.taggedMemberIds).length) updates.taggedMemberIds = []
    }
  }
  for (const key of COUNT_KEYS) {
    if (!(key in c)) continue
    const n = c[key]
    if (!Number.isInteger(n) || n < 0 || n > MAX_TEST_COUNT) {
      return refuse(`Test counts must be whole numbers from 0 to ${MAX_TEST_COUNT}.`)
    }
    if (n !== task[key]) updates[key] = n
  }
  if ('estimate' in c) {
    if (c.estimate !== null && typeof c.estimate !== 'string') return refuse(BAD_DURATION)
    const raw = String(c.estimate ?? '').trim()
    let minutes = null
    if (raw) {
      minutes = parseDuration(raw)
      if (minutes === null) return refuse(BAD_DURATION)
      if (!Number.isSafeInteger(minutes) || minutes > MAX_STORABLE_MINUTES) return refuse(ESTIMATE_TOO_LARGE)
    }
    if (minutes !== (task.estimateMinutes ?? null)) updates.estimateMinutes = minutes
  }

  const blockers = { add: [], remove: [] }
  if ('blockerIds' in c) {
    const ids = stringList(c.blockerIds)
    if (!ids) return refuse('blockerIds must be a list of task ids.')
    if (ids.length > MAX_IDS) return refuse(`A task can have at most ${MAX_IDS} blockers.`)
    if (ids.includes(String(task.id))) return refuse('A task cannot be blocked by itself.')
    const missing = ids.find((id) => !tasksById.has(id))
    if (missing) return refuse(`No task matches ${missing}.`)
    const current = deps.filter((r) => String(r.taskId) === String(task.id)).map((r) => String(r.blockedByTaskId))
    const add = ids.filter((id) => !current.includes(id))
    const remove = current.filter((id) => !ids.includes(id))
    // The graph as it will be once this edit lands: the removed edges gone, and
    // each accepted add in place before the next one is checked.
    const graph = deps.filter((r) => !(String(r.taskId) === String(task.id) && remove.includes(String(r.blockedByTaskId))))
    for (const id of add) {
      if (wouldCycle(task.id, id, graph)) {
        const b = tasksById.get(id)?.title || id
        const t = task.title || task.id
        return refuse(`${b} already depends on ${t}, so ${t} cannot be blocked by ${b}.`)
      }
      graph.push({ taskId: String(task.id), blockedByTaskId: id })
    }
    blockers.add = add
    blockers.remove = remove
  }
  return { error: null, updates, blockers }
}

/**
 * Check a site create. The project is required on the site: it gives the guild
 * and puts the task under a project card. Returns the normalised fields
 * `services/taskCreate.js` takes.
 */
export function validateCreate(input, ctx = {}) {
  const { project = null, memberIds = new Set(), reposById = new Map() } = ctx
  const f = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const bad = (error) => ({ error, fields: null })
  if (!TASK_TYPES.includes(f.type)) return bad('type must be feature or bug.')
  const isBug = f.type === 'bug'
  const [tErr, title] = titleOf(f.title)
  if (tErr) return bad(tErr)
  const [dErr, description] = descriptionOf(f.description)
  if (dErr) return bad(dErr)
  if (!project) return bad('Pick a project for the task.')
  const [sErr, scope] = scopeOf(f.scope)
  if (sErr) return bad(sErr)
  const [hErr, holderIds] = holdersFrom(f.holderIds ?? [], memberIds)
  if (hErr) return bad(hErr)

  const modules = stringList(f.modules ?? [])
  if (!modules) return bad('modules must be a list of names.')
  if (isBug && modules.length) return bad('Modules are for features only.')
  if (modules.length > MAX_MODULES) return bad(`A feature can list at most ${MAX_MODULES} modules.`)
  if (modules.some((m) => m.length > MODULE_MAX)) return bad(`A module name can be at most ${MODULE_MAX} characters.`)

  const repositoryIds = stringList(f.repositoryIds ?? [])
  if (!repositoryIds) return bad('repositoryIds must be a list of repository ids.')
  if (isBug && repositoryIds.length > 1) return bad('A bug can name one repository.')
  if (repositoryIds.length > MAX_REPOSITORIES) return bad(`A task can name at most ${MAX_REPOSITORIES} repositories.`)
  const unknownRepo = repositoryIds.find((id) => !reposById.has(id))
  if (unknownRepo) return bad(`No repository matches ${unknownRepo}.`)

  const t = f.tracks && typeof f.tracks === 'object' ? f.tracks : {}
  return {
    error: null,
    fields: {
      type: f.type, title, description, scope, modules, holderIds, repositoryIds,
      tracks: { apiTests: t.apiTests === true, qaTests: t.qaTests === true, acceptanceCriteria: t.acceptanceCriteria === true },
    },
  }
}
