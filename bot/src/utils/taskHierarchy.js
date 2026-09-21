// Task hierarchy: a task may have subtasks, one level deep.
//
// The rules, all in one place (pure functions; the services that apply them
// live in services/taskHierarchy.js):
//   * a task with an unfinished subtask cannot itself be finished;
//   * when the last unfinished subtask is finished, the parent is done;
//   * if a finished parent gains an unfinished subtask (one is added, or one is
//     reopened) it goes back to in progress, so "parent finished" always means
//     "every subtask finished".

/** Statuses that count as finished — the same three the rest of the bot uses. */
export const FINISHED = new Set(['done', 'closed', 'resolved'])
export const isFinished = (status) => FINISHED.has(String(status ?? ''))

/** A parent holds at most this many subtasks (a checklist select holds 25). */
export const MAX_SUBTASKS = 25

/** A refusal that is the user's to fix, not a failure. `status` is what the site sees. */
export class TaskRuleError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TaskRuleError'
    this.status = 409
  }
}

export const openChildren = (children) => (children || []).filter((c) => !isFinished(c.status))

/** { done, total } — for "3 of 5 done". */
export function subtaskProgress(children) {
  const list = children || []
  return { done: list.filter((c) => isFinished(c.status)).length, total: list.length }
}

/**
 * Why `task` cannot move to `nextStatus`, or null when it can. Only moving to a
 * finished status is ever blocked, and only while a subtask is still open.
 */
export function finishBlockMessage(task, children, nextStatus) {
  if (!isFinished(nextStatus)) return null
  const open = openChildren(children)
  if (!open.length) return null
  const names = open.slice(0, 5).map((c) => `• ${c.title || c.id}`).join('\n')
  const more = open.length > 5 ? `\n…and ${open.length - 5} more` : ''
  return `**${task.title || task.id}** can't be marked ${nextStatus} yet — ${open.length} subtask${open.length === 1 ? ' is' : 's are'} still open:\n${names}${more}`
}

/**
 * The status the parent should now have given its subtasks, or null to leave it.
 * Call after a subtask's status changed or a subtask was added.
 */
export function parentNextStatus(parent, children) {
  if (!children?.length) return null
  const anyOpen = openChildren(children).length > 0
  if (isFinished(parent.status) && anyOpen) return 'in_progress'
  if (!isFinished(parent.status) && !anyOpen) return 'done'
  return null
}

/** The label the activity log and channel post carry for an automatic change. */
export const AUTO_LABEL = {
  done: 'Automatic (all subtasks done)',
  in_progress: 'Automatic (a subtask is open again)',
}

/** ☑ / ☐ lines for an embed field, clipped to `max` characters. */
export function checklistText(children, nameFor = () => null, max = 1000) {
  if (!children?.length) return 'No subtasks yet'
  const lines = children.map((c) => {
    const who = idsOf(c).map((id) => nameFor(id) || `<@${id}>`).join(', ')
    return `${isFinished(c.status) ? '☑' : '☐'} ${c.title || c.id}${who ? ` — ${who}` : ''}`
  })
  const text = lines.join('\n')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function idsOf(task) {
  const pick = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? safeParse(v) : [])
  const a = pick(task?.assigneeIds).filter(Boolean).map(String)
  return a.length ? a : pick(task?.taggedMemberIds).filter(Boolean).map(String)
}
function safeParse(v) {
  try {
    const p = JSON.parse(v)
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}

/** parentId -> { done, total } over a list of tasks (subtasks point at parents by parentTaskId). */
export function childStats(rows) {
  const stats = new Map()
  for (const t of rows || []) {
    if (!t.parentTaskId) continue
    const key = String(t.parentTaskId)
    const s = stats.get(key) ?? { done: 0, total: 0 }
    s.total += 1
    if (isFinished(t.status)) s.done += 1
    stats.set(key, s)
  }
  return stats
}
