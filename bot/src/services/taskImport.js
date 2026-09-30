// The check behind the site's JSON task import: for each task in a parsed file,
// can it be imported, and if not, why not. Writes nothing; the site sends each
// valid task's `fields` to the ordinary create and subtask routes afterwards.
// Every task rule is the create route's own (validateCreate and its helpers);
// this file adds only what a file adds: assignees by name, statuses, subtasks,
// and the warnings.
import { validateCreate, statusOf, titleOf, descriptionOf, scopeOf, MAX_IDS } from '../utils/taskEditRules.js'
import { MAX_SUBTASKS } from '../utils/taskHierarchy.js'
import { resolveTaskRepo, loadProjectLinks } from './taskRepo.js'

export const MAX_IMPORT_TASKS = 50
/** Large enough that no real project's task list is cut short (taskFindMany defaults to 500). */
const EXISTING_TASKS_CAP = 5000

const NO_ISSUE_WARNING = 'No repository for this scope, so no GitHub issue will be opened.'
const norm = (s) => String(s ?? '').trim().toLowerCase()
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * Match each entry to one staff member: email first, then display name, then
 * username (case-insensitive, trimmed). A tier with several people is
 * ambiguous; the same person named twice counts once.
 */
export function resolveAssignees(entries, members) {
  const notText = { ids: [], errors: ['Assignees must be emails or names.'] }
  if (!Array.isArray(entries)) return notText
  if (entries.some((e) => typeof e !== 'string' || !e.trim())) return notText
  if (entries.length > MAX_IDS) return { ids: [], errors: [`A task can have at most ${MAX_IDS} people.`] }
  const staff = (members || []).filter((m) => m.status === 'approved' && m.kind !== 'client')
  const ids = []
  const errors = []
  for (const entry of entries) {
    const key = norm(entry)
    let found = []
    for (const field of ['email', 'displayName', 'username']) {
      found = [...new Set(staff.filter((m) => norm(m[field]) === key).map((m) => String(m.discordId)))]
      if (found.length) break
    }
    if (found.length === 0) errors.push(`No member matches "${entry.trim()}".`)
    else if (found.length > 1) errors.push(`"${entry.trim()}" matches more than one member — use their email.`)
    else if (!ids.includes(found[0])) ids.push(found[0])
  }
  return { ids, errors }
}

/** One subtask: `{ errors, fields }`; each error is already prefixed with the subtask's number. */
function checkSubtask(sub, n, members) {
  const prefix = `Subtask ${n}: `
  if (!isObject(sub)) return { errors: [`${prefix}Each subtask must be an object.`], fields: null }
  const errors = []
  const [tErr, title] = titleOf(sub.title)
  if (tErr) errors.push(tErr)
  const [dErr, description] = descriptionOf(sub.description)
  if (dErr) errors.push(dErr)
  const [scErr, scope] = scopeOf(sub.scope)
  if (scErr) errors.push(scErr)
  const [stErr, status] = statusOf(sub.status)
  if (stErr) errors.push(stErr)
  const who = resolveAssignees(sub.assignees ?? [], members)
  errors.push(...who.errors)
  if (errors.length) return { errors: errors.map((e) => prefix + e), fields: null }
  return { errors: [], fields: { title, description, scope, status, holderIds: who.ids } }
}

function checkTask(entry, ctx) {
  const { members, memberIds, project, reposById, links, repos, createIssues, existingTitles, seenTitles } = ctx
  if (!isObject(entry)) return { ok: false, errors: ['Each task must be an object.'], warnings: [], fields: null }
  const errors = []
  const warnings = []

  const who = resolveAssignees(entry.assignees ?? [], members)
  errors.push(...who.errors)
  // The file's assignees replace holderIds, and a file names no repositories:
  // the repository rule below is the one that decides a bug's.
  const v = validateCreate({ ...entry, holderIds: who.ids, repositoryIds: [] }, { project, memberIds, reposById })
  if (v.error) errors.push(v.error)
  const [, status] = statusOf(entry.status)

  const repoFor = () => resolveTaskRepo({ projectId: project.id, scope: v.fields.scope }, { links, repos }).repository
  if (v.fields?.type === 'bug' && !repoFor()) errors.push('This project has no repository for this scope.')

  let subtasks = []
  if (entry.subtasks !== undefined && entry.subtasks !== null) {
    if (!Array.isArray(entry.subtasks)) errors.push('Subtasks must be a list.')
    else if (entry.subtasks.length > MAX_SUBTASKS) errors.push(`A task can have at most ${MAX_SUBTASKS} subtasks.`)
    else {
      const checked = entry.subtasks.map((s, i) => checkSubtask(s, i + 1, members))
      for (const c of checked) errors.push(...c.errors)
      subtasks = checked.map((c) => c.fields)
      const unfinished = entry.subtasks.some((s) => isObject(s) && statusOf(s.status)[1] !== 'done')
      if (status === 'done' && unfinished) errors.push('A done task cannot have unfinished subtasks.')
    }
  }

  const titleKey = typeof entry.title === 'string' ? norm(entry.title) : ''
  if (titleKey) {
    if (existingTitles.has(titleKey) || seenTitles.has(titleKey)) warnings.push('A task with this title already exists in this project.')
    seenTitles.add(titleKey)
  }
  if (v.fields?.type === 'feature' && createIssues && status !== 'done' && !repoFor()) warnings.push(NO_ISSUE_WARNING)

  if (errors.length) return { ok: false, errors, warnings, fields: null }
  return { ok: true, errors: [], warnings, fields: { ...v.fields, status, repositoryIds: [], subtasks } }
}

/**
 * Check every task of a parsed file against one project. Reads only; `tasks`
 * is whatever the file held, so every entry is treated as untrusted.
 */
export async function checkImport({ db, cfg, project, tasks, createIssues = true }) {
  const [memberRows, repos, links, existing] = await Promise.all([
    db.guildMember.findMany({ where: { guildConfigId: cfg.id, all: true } }),
    db.repository.findMany({ where: { guildConfigId: cfg.id } }),
    loadProjectLinks(db, project.id),
    db.task.findMany({ where: { guildConfigId: cfg.id, projectId: project.id }, take: EXISTING_TASKS_CAP }),
  ])
  const members = memberRows || []
  const ctx = {
    members,
    memberIds: new Set(members.map((m) => String(m.discordId))),
    project,
    repos: repos || [],
    reposById: new Map((repos || []).map((r) => [String(r.id), r])),
    links,
    createIssues,
    existingTitles: new Set((existing || []).filter((t) => !t.parentTaskId).map((t) => norm(t.title))),
    seenTitles: new Set(),
  }
  return { tasks: (tasks || []).map((entry, index) => ({ index, ...checkTask(entry, ctx) })) }
}
