/**
 * Pure select-menu construction for the "Ticket docs" branch of /docs: the
 * write-ups attached to closed feature tickets, grouped by project.
 *
 * Rows come from db.ticketDoc.listWithTask:
 *   { id, title, taskId, ticketType, updatedAt, projectId, projectName, taskStatus, taskTitle }
 */

const MAX_OPTIONS = 25
const LABEL_MAX = 100

export const TICKETS_ROOT = 'tickets:'
export const TICKETS_NO_PROJECT = 'tickets:none'

/** The /docs root entry, or null when there is nothing to browse. */
export function ticketsRootOption(rows) {
  const n = (rows || []).length
  if (n === 0) return null
  return {
    label: '🎫 Ticket docs',
    value: TICKETS_ROOT,
    description: `${n} write-up${n === 1 ? '' : 's'} from closed tickets`,
  }
}

/** Level 1 under Ticket docs: one entry per project, plus "No project". */
export function ticketProjectOptions(rows) {
  const byProject = new Map()
  let none = 0
  for (const r of rows || []) {
    if (r.projectId) {
      const cur = byProject.get(r.projectId) || { name: r.projectName || 'Project', n: 0 }
      cur.n += 1
      if (!cur.name && r.projectName) cur.name = r.projectName
      byProject.set(r.projectId, cur)
    } else {
      none += 1
    }
  }
  const options = [
    { label: '← All documentation', value: 'root:', description: 'Back to projects and sections' },
  ]
  const projects = [...byProject.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))
  for (const [id, { name, n }] of projects) {
    options.push({
      label: `📁 ${name}`.slice(0, LABEL_MAX),
      value: `tickets:proj:${id}`,
      description: `${n} write-up${n === 1 ? '' : 's'}`,
    })
  }
  if (none > 0) {
    options.push({
      label: '📁 No project',
      value: TICKETS_NO_PROJECT,
      description: `${none} write-up${none === 1 ? '' : 's'}`,
    })
  }
  return options.slice(0, MAX_OPTIONS)
}

/** Level 2: the write-ups in one project bucket, newest first. */
export function ticketDocOptions(rows, scope) {
  const projectId = scope === TICKETS_NO_PROJECT ? null : scope.startsWith('tickets:proj:') ? scope.slice('tickets:proj:'.length) : null
  const inScope = (rows || []).filter((r) => (projectId ? r.projectId === projectId : !r.projectId))
  const options = [
    { label: '← Back', value: TICKETS_ROOT, description: 'Back to ticket projects' },
  ]
  for (const r of inScope.slice(0, MAX_OPTIONS - 1)) {
    const when = r.updatedAt ? new Date(r.updatedAt).toISOString().slice(0, 10) : ''
    options.push({
      label: `📝 ${r.title || r.taskTitle || 'Write-up'}`.slice(0, LABEL_MAX),
      value: `tdoc:${r.id}`,
      description: [r.taskStatus, when].filter(Boolean).join(' · ').slice(0, 100) || 'Open',
    })
  }
  return options
}

/** Where a ticket doc's Back button returns to. */
export function ticketDocScopeFor(row) {
  return row?.projectId ? `tickets:proj:${row.projectId}` : TICKETS_NO_PROJECT
}
