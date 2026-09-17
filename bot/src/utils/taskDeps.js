// Dependency rules for tasks. Pure: no Discord, no database.
//
// "A is blocked by B" is a row { taskId: 'A', blockedByTaskId: 'B' }. Blocked
// state is never stored — it is whether any blocker is still open right now.

export const TERMINAL_STATUSES = new Set(['closed', 'done', 'resolved'])

/** Every status a task can hold, in the order the board and the pickers use. */
export const TASK_STATUSES = ['open', 'pending', 'in_progress', 'resolved', 'closed', 'done']

export const STATUS_LABEL = {
  open: 'open',
  pending: 'pending',
  in_progress: 'in progress',
  resolved: 'resolved',
  closed: 'closed',
  done: 'done',
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(String(status ?? ''))
}

/** Blocker tasks of `taskId` that are still open, in the order the rows were given. */
export function openBlockers(taskId, depRows = [], tasksById = {}) {
  const out = []
  for (const row of depRows) {
    if (String(row.taskId) !== String(taskId)) continue
    const blocker = tasksById[row.blockedByTaskId]
    if (!blocker) continue
    if (!isTerminal(blocker.status)) out.push(blocker)
  }
  return out
}

/**
 * Would recording "taskId is blocked by blockerId" create a cycle?
 * True when blockerId is taskId, or when following blocker edges from
 * blockerId reaches taskId. Depth-first; the graph is tiny.
 */
export function wouldCycle(taskId, blockerId, depRows = []) {
  const t = String(taskId)
  const b = String(blockerId)
  if (t === b) return true
  const edges = new Map()
  for (const row of depRows) {
    const from = String(row.taskId)
    if (!edges.has(from)) edges.set(from, [])
    edges.get(from).push(String(row.blockedByTaskId))
  }
  const seen = new Set()
  const stack = [b]
  while (stack.length) {
    const cur = stack.pop()
    if (cur === t) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of edges.get(cur) || []) stack.push(next)
  }
  return false
}

const labelOf = (status) => STATUS_LABEL[String(status)] ?? String(status ?? 'open')

export function blockerWarning(openBlockerTasks = []) {
  if (!openBlockerTasks.length) return ''
  const parts = openBlockerTasks.map((t) => `**${t.title || t.id}** (${labelOf(t.status)})`)
  return `⛔ Still blocked by: ${parts.join(', ')}`
}

export function unblockNotice(blockerTask, remainingOpen = 0) {
  const head = `✅ Blocker **${blockerTask?.title || blockerTask?.id}** is done.`
  if (remainingOpen <= 0) return `${head} This task is no longer blocked.`
  return `${head} ${remainingOpen} blocker${remainingOpen === 1 ? '' : 's'} still open.`
}
