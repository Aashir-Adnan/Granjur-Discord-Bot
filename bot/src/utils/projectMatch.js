// Map the free-text project name CSAAS attaches to a meeting task onto the
// bot's own `project` and `repository` rows.
//
// CSAAS says `Badar_HMS`; the project row is `Badar HMS` and its repository is
// `Badar_HMS_Node`. An exact string comparison misses every time, which is why
// every meeting task so far landed with `projectId = null`. Names are compared
// with case, spaces, underscores and punctuation removed, and a repository name
// resolves to its project through `project_repos`.

export function normalizeName(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * @param {string} name — what CSAAS called the project
 * @param {{projects: {id,name}[], repos: {id,name}[], links: {project_id,repository_id}[]}} ctx
 * @returns {{projectId: string|null, projectName: string|null, repositoryId: string|null} | null}
 */
export function matchProject(name, { projects = [], repos = [], links = [] } = {}) {
  const key = normalizeName(name)
  if (!key) return null

  const projectById = new Map(projects.map((p) => [p.id, p]))
  const reposOfProject = new Map()
  const projectOfRepo = new Map()
  for (const l of links) {
    if (!reposOfProject.has(l.project_id)) reposOfProject.set(l.project_id, [])
    reposOfProject.get(l.project_id).push(l.repository_id)
    projectOfRepo.set(l.repository_id, l.project_id)
  }

  const result = (projectId, repositoryId) => ({
    projectId: projectId ?? null,
    projectName: projectId ? projectById.get(projectId)?.name ?? null : null,
    repositoryId: repositoryId ?? null,
  })

  // 1. Exact project name.
  const exactProject = projects.find((p) => normalizeName(p.name) === key)
  if (exactProject) {
    const linked = reposOfProject.get(exactProject.id) || []
    return result(exactProject.id, linked.length === 1 ? linked[0] : null)
  }

  // 2. Exact repository name.
  const exactRepo = repos.find((r) => normalizeName(r.name) === key)
  if (exactRepo) return result(projectOfRepo.get(exactRepo.id) ?? null, exactRepo.id)

  // 3. Containment either way, but only when it is unambiguous. "node" is
  //    inside two repos of two projects — that is a guess, not a match.
  const candidates = []
  for (const p of projects) {
    const n = normalizeName(p.name)
    if (n && (n.includes(key) || key.includes(n))) candidates.push({ projectId: p.id, repositoryId: null, score: n.length })
  }
  for (const r of repos) {
    const n = normalizeName(r.name)
    if (n && (n.includes(key) || key.includes(n))) {
      candidates.push({ projectId: projectOfRepo.get(r.id) ?? null, repositoryId: r.id, score: n.length })
    }
  }
  if (candidates.length === 0) return null

  const distinctProjects = new Set(candidates.map((c) => c.projectId ?? `repo:${c.repositoryId}`))
  if (distinctProjects.size > 1) return null

  // Prefer the candidate that names a repository (more specific) over the
  // project alone; among repositories prefer the longest name (closest match).
  const withRepo = candidates.filter((c) => c.repositoryId).sort((a, b) => b.score - a.score)
  const best = withRepo[0] || candidates[0]
  return result(best.projectId, best.repositoryId)
}
