/**
 * Pure select-menu construction for the /docs browser.
 * Operates on the lightweight index rows from db.docPage.listIndex
 * ({ path, docId, section, projectId, title, source }).
 */

const MAX_OPTIONS = 25
const LABEL_MAX = 100

function relOf(row) {
  return row.docId
}

function scopeRows(index, scope) {
  if (scope.startsWith('proj:')) {
    const projectId = scope.slice(5)
    return index.filter((r) => r.projectId === projectId)
  }
  if (scope.startsWith('sec:')) {
    const section = scope.slice(4)
    return index.filter((r) => !r.projectId && r.section === section)
  }
  return index
}

/** Root menu: projects that own docs, then unattributed sections. */
export function rootOptions(index, projects) {
  const options = []

  const byProject = new Map()
  for (const r of index) if (r.projectId) byProject.set(r.projectId, (byProject.get(r.projectId) || 0) + 1)
  for (const p of projects || []) {
    const n = byProject.get(p.id)
    if (!n) continue
    options.push({
      label: `📁 ${p.name}`.slice(0, LABEL_MAX),
      value: `proj:${p.id}`,
      description: `${n} page${n === 1 ? '' : 's'}`,
    })
  }

  const bySection = new Map()
  for (const r of index) if (!r.projectId) bySection.set(r.section, (bySection.get(r.section) || 0) + 1)
  for (const [section, n] of [...bySection.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    options.push({
      label: `📚 ${section}`.slice(0, LABEL_MAX),
      value: `sec:${section}`,
      description: `${n} page${n === 1 ? '' : 's'}`,
    })
  }

  return options.slice(0, MAX_OPTIONS)
}

/**
 * One level of the tree inside a scope.
 * `prefix` is a docId prefix (no trailing slash); '' is the scope root.
 */
export function childOptions(index, { scope, prefix = '', page = 0 }) {
  const rows = scopeRows(index, scope)
  let base = prefix ? `${prefix}/` : ''
  let morePrefix = prefix

  // For section scopes at the root, treat the section name as the base prefix.
  // This strips the section name from docIds like 'api/overview' -> 'overview'.
  if (scope.startsWith('sec:') && !prefix) {
    const section = scope.slice(4)
    base = `${section}/`
    morePrefix = section
  }

  const dirs = new Set()
  const files = []
  for (const r of rows) {
    const rel = relOf(r)
    if (base && !rel.startsWith(base)) continue
    const rest = rel.slice(base.length)
    if (!rest) continue
    const slash = rest.indexOf('/')
    if (slash === -1) files.push(r)
    else dirs.add(rest.slice(0, slash))
  }

  const entries = []
  for (const d of [...dirs].sort((a, b) => a.localeCompare(b))) {
    entries.push({
      label: `📁 ${d}`.slice(0, LABEL_MAX),
      value: `dir:${base}${d}`,
      description: 'Open folder',
    })
  }
  for (const f of files.sort((a, b) => a.title.localeCompare(b.title))) {
    const mark = f.source === 'local' ? '📝' : '📄'
    entries.push({
      // The row id, not the docId: Discord caps an option value at 100 chars
      // and the longest docId in this corpus is 103.
      label: `${mark} ${f.title}`.slice(0, LABEL_MAX),
      value: `doc:${f.id}`,
      description: f.docId.slice(-100),
    })
  }

  const options = []
  if (prefix) {
    const parent = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : ''
    options.push({
      label: '← Back',
      value: `back:${parent}`,
      description: parent || 'Back to the top',
    })
  }

  const room = MAX_OPTIONS - options.length
  const start = page * (room - 1)
  const slice = entries.slice(start, start + room)
  const hasMore = entries.length > start + slice.length

  if (hasMore) {
    options.push(...slice.slice(0, room - 1))
    options.push({
      label: `→ Next ${Math.min(room - 1, entries.length - start - (room - 1))} of ${entries.length}`.slice(0, LABEL_MAX),
      value: `more:${morePrefix}:${page + 1}`,
      description: 'Show more entries',
    })
  } else {
    options.push(...slice)
  }

  return { options, hasMore, total: entries.length }
}
