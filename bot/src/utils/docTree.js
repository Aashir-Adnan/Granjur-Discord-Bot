/**
 * Pure select-menu construction for the /docs browser.
 * Operates on the lightweight index rows from db.docPage.listIndex
 * ({ path, docId, section, projectId, title, source }).
 */

const MAX_OPTIONS = 25
const PER_PAGE = 23  // MAX_OPTIONS - 2 (Back + More slots, reserved on every page)
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
  // But a loose .md file directly in docs/ has no directory of its own, so
  // sectionOf() falls back to the filename as its section (e.g. 'init.md' for
  // docs/init.md, whose docId is just 'init'). Only substitute the section
  // name as a base prefix when it is genuinely a directory — i.e. at least
  // one row's docId actually starts with `${section}/` — otherwise leave the
  // base empty so the loose file's docId (which has no slash) lists normally.
  if (scope.startsWith('sec:') && !prefix) {
    const section = scope.slice(4)
    const sectionIsDirectory = rows.some((r) => relOf(r).startsWith(`${section}/`))
    if (sectionIsDirectory) {
      base = `${section}/`
      morePrefix = section
    }
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
  } else if (scope) {
    // At the scope's own root there is nothing to go "up" to within the scope —
    // without this, entering a project/section leaves no way back to the
    // global project/section picker except re-running /docs.
    options.push({
      label: '← All documentation',
      value: 'root:',
      description: 'Back to projects and sections',
    })
  }

  // Constant stride: always show PER_PAGE entries per page, with room for Back + More
  const start = page * PER_PAGE
  const slice = entries.slice(start, start + PER_PAGE)
  const hasMore = entries.length > start + slice.length

  options.push(...slice)

  if (hasMore) {
    options.push({
      label: `→ Next ${Math.min(PER_PAGE, entries.length - start - PER_PAGE)} of ${entries.length}`.slice(0, LABEL_MAX),
      value: `more:${morePrefix}:${page + 1}`,
      description: 'Show more entries',
    })
  }

  return { options, hasMore, total: entries.length }
}
