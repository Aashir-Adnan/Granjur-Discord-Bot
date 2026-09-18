// Human-readable identity for a task row.
//
// Task ids are 25-character hex strings. Asking someone to read one off a
// dashboard and retype it into /update-task is not a workflow, so anywhere a
// task is chosen or listed we show what it IS — title, status, who holds it —
// and keep the id out of sight.

/** Tolerate a JSON column that arrives as an array, a JSON string, or null. */
export function idList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String)
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : []
    } catch {
      return []
    }
  }
  return []
}

/** Whoever holds this task: assignees for a feature, tagged members for a bug. */
export function holdersOf(task) {
  const assignees = idList(task?.assigneeIds)
  return assignees.length ? assignees : idList(task?.taggedMemberIds)
}

/**
 * One line naming a task, for an autocomplete choice or a compact list.
 * Discord caps an autocomplete choice name at 100 characters, so the title is
 * what gets trimmed — the status and the holder always survive, because those
 * are what tell two similar tasks apart.
 *
 * @param {object} task
 * @param {{ nameFor?: (id: string) => string|null, max?: number }} [opts]
 */
export function taskChoiceLabel(task, { nameFor = () => null, max = 100 } = {}) {
  const status = String(task?.status || 'open')
  const holders = holdersOf(task)
  const who = holders.length
    ? holders.map((id) => nameFor(id) || id).join(', ')
    : 'unassigned'

  const suffix = ` · ${status} · ${who}`
  const title = String(task?.title || task?.id || 'Task')

  // Reserve the suffix, give the rest to the title. If the suffix alone would
  // overflow (many assignees), it is the suffix that gets cut instead — a label
  // with no title is useless, one with no third assignee is not.
  const room = max - suffix.length
  if (room >= 12) {
    const head = title.length > room ? `${title.slice(0, room - 1)}…` : title
    return `${head}${suffix}`
  }
  const line = `${title} · ${status} · ${who}`
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
