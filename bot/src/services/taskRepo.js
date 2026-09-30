// Which repository a task's GitHub issue goes to (roadmap sub-project 4,
// 2026-09-30). One rule for /create-task, the site's create route and the
// meeting pipeline:
//   1. the project's link carrying the task's scope;
//   2. else the project's ONLY link, when that link has no scope yet (a
//      single-repository project keeps working until it is tagged);
//   3. else none — never "the first of several".

const REASONS = {
  'no-project': 'the task has no project',
  'no-scope': 'the task has no scope',
  'no-repo-for-scope': 'the project has no repository for this scope',
}

export function repoReasonText(reason) {
  return REASONS[reason] ?? 'no repository was found'
}

export function resolveTaskRepo({ projectId, scope }, { links = [], repos = [] } = {}) {
  if (!projectId) return { repository: null, reason: 'no-project' }
  const byId = new Map((repos || []).map((r) => [String(r.id), r]))
  const mine = (links || []).filter((l) => String(l?.project_id) === String(projectId) && byId.has(String(l.repository_id)))
  if (scope) {
    const hit = mine.find((l) => l.scope === scope)
    if (hit) return { repository: byId.get(String(hit.repository_id)), reason: 'scope' }
  }
  if (mine.length === 1 && !mine[0].scope) return { repository: byId.get(String(mine[0].repository_id)), reason: 'only-repo' }
  return { repository: null, reason: scope ? 'no-repo-for-scope' : 'no-scope' }
}

/** The project's links, uncapped (findMany by project_id). Never throws. */
export async function loadProjectLinks(db, projectId) {
  if (!projectId) return []
  try {
    return (await db.projectRepos.findMany({ where: { project_id: projectId } })) ?? []
  } catch (e) {
    console.warn('[taskRepo] project links read failed:', e?.message ?? e)
    return []
  }
}
