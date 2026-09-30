import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REVIEW_PROJECT_LIMIT,
  loadProjectContext,
  settledProject,
  resolveMeetingTaskProject,
  reviewProjectOptions,
} from './meetingTaskProject.js'

const P1 = { id: 'p1', name: 'Framework' }
const P2 = { id: 'p2', name: 'Badar HMS' }
const ctxOf = (over = {}) => ({ projects: [P1, P2], repos: [], links: [], meetingProjectId: null, ...over })

test('loadProjectContext reads projects, repos, links and the meeting project through the db seam', async () => {
  const seen = []
  const db = {
    project: { findMany: async (q) => { seen.push(['project', q]); return [P1] } },
    repository: { findMany: async () => [{ id: 'r1', name: 'fw' }] },
    projectRepos: { findMany: async () => [{ projectId: 'p1', repositoryId: 'r1' }] },
    meeting: { findUnique: async (q) => { seen.push(['meeting', q]); return { id: 'M', projectId: 'p1' } } },
  }
  const ctx = await loadProjectContext(db, { guildConfigId: 'g', meetingId: 'M' })
  assert.deepEqual(ctx.projects, [P1])
  assert.equal(ctx.repos.length, 1)
  assert.equal(ctx.links.length, 1)
  assert.equal(ctx.meetingProjectId, 'p1')
  assert.deepEqual(seen[0], ['project', { where: { guildConfigId: 'g' } }])
  assert.deepEqual(seen[1], ['meeting', { where: { id: 'M' } }])
})

test('loadProjectContext never throws: a failed read leaves that part empty', async () => {
  const ctx = await loadProjectContext({}, { guildConfigId: 'g', meetingId: 'M' })
  assert.deepEqual(ctx, { projects: [], repos: [], links: [], meetingProjectId: null })
})

test("rule 1: the meeting's project wins over the project Claude named", () => {
  const out = settledProject({ project: 'Badar HMS' }, ctxOf({ meetingProjectId: 'p1' }))
  assert.deepEqual(out, { projectId: 'p1', projectName: 'Framework' })
})

test('rule 2: with no meeting project, the named project is matched', () => {
  const out = settledProject({ project: 'Badar_HMS' }, ctxOf())
  assert.deepEqual(out, { projectId: 'p2', projectName: 'Badar HMS' })
})

test('a meeting project that no longer exists falls through to rule 2', () => {
  const out = settledProject({ project: 'Framework' }, ctxOf({ meetingProjectId: 'gone' }))
  assert.deepEqual(out, { projectId: 'p1', projectName: 'Framework' })
})

test('unclear: no meeting project and no match settles nothing', () => {
  assert.equal(settledProject({ project: 'Something else' }, ctxOf()), null)
  assert.equal(settledProject({}, ctxOf()), null)
})

test("rule 3: the reviewer's pick applies only to an unclear task", () => {
  const picked = resolveMeetingTaskProject({}, { projectId: 'p2' }, ctxOf())
  assert.deepEqual(picked, { projectId: 'p2', projectName: 'Badar HMS', repositoryId: null, repoReason: 'no-scope' })
  const ignored = resolveMeetingTaskProject({}, { projectId: 'p2' }, ctxOf({ meetingProjectId: 'p1' }))
  assert.equal(ignored.projectId, 'p1')
})

test('a picked project that no longer exists, "none", or a legacy state gives no project and no name', () => {
  const none = { projectId: null, projectName: null, repositoryId: null, repoReason: 'no-project' }
  assert.deepEqual(resolveMeetingTaskProject({ project: 'Ghost' }, { projectId: 'deleted' }, ctxOf()), none)
  assert.deepEqual(resolveMeetingTaskProject({ project: 'Ghost' }, { projectId: null }, ctxOf()), none)
  assert.deepEqual(resolveMeetingTaskProject({ project: 'Ghost' }, { taskId: 'a' }, ctxOf()), none)
})

// Repository by the rule (roadmap sub-project 4, 2026-09-30): the project's
// link with the task's scope, else its only untagged link, else none.
const REPOS = [
  { id: 'r-node', name: 'Badar_HMS_Node' },
  { id: 'r-web', name: 'Badar_HMS_Web' },
  { id: 'r-fw-be', name: 'framework-backend' },
  { id: 'r-fw-mob', name: 'framework-app' },
]

test('the repository is the project link carrying the task scope', () => {
  const ctx = ctxOf({
    repos: REPOS,
    links: [
      { project_id: 'p2', repository_id: 'r-node', scope: 'backend' },
      { project_id: 'p2', repository_id: 'r-web', scope: 'frontend' },
    ],
  })
  assert.equal(resolveMeetingTaskProject({ project: 'Badar HMS', platform: 'node' }, {}, ctx).repositoryId, 'r-node')
  assert.equal(resolveMeetingTaskProject({ project: 'Badar HMS', platform: 'react' }, {}, ctx).repositoryId, 'r-web')
  // No link for this scope, and more than one link: none, never "the first".
  assert.equal(resolveMeetingTaskProject({ project: 'Badar HMS', platform: 'react-native' }, {}, ctx).repositoryId, null)
})

test("a project's single untagged link is used whatever the scope", () => {
  const ctx = ctxOf({ repos: REPOS, links: [{ project_id: 'p2', repository_id: 'r-node', scope: null }] })
  assert.equal(resolveMeetingTaskProject({ project: 'Badar HMS', platform: 'react' }, {}, ctx).repositoryId, 'r-node')
  assert.equal(resolveMeetingTaskProject({ project: 'Badar HMS' }, {}, ctx).repositoryId, 'r-node')
})

test('two untagged links give no repository', () => {
  const ctx = ctxOf({
    repos: REPOS,
    links: [
      { project_id: 'p2', repository_id: 'r-node', scope: null },
      { project_id: 'p2', repository_id: 'r-web', scope: null },
    ],
  })
  assert.equal(resolveMeetingTaskProject({ project: 'Badar HMS', platform: 'node' }, {}, ctx).repositoryId, null)
})

test("the meeting project's override picks the meeting project's scope link, not the named project's", () => {
  const ctx = ctxOf({
    meetingProjectId: 'p1',
    repos: REPOS,
    links: [
      { project_id: 'p2', repository_id: 'r-node', scope: 'backend' },
      { project_id: 'p1', repository_id: 'r-fw-be', scope: 'backend' },
      { project_id: 'p1', repository_id: 'r-fw-mob', scope: 'mobile' },
    ],
  })
  const out = resolveMeetingTaskProject({ project: 'Badar HMS', platform: 'node' }, {}, ctx)
  assert.deepEqual(out, { projectId: 'p1', projectName: 'Framework', repositoryId: 'r-fw-be', repoReason: 'scope' })
  assert.equal(resolveMeetingTaskProject({ project: 'Badar HMS', platform: 'react-native' }, {}, ctx).repositoryId, 'r-fw-mob')
})

test("the reviewer's pick gets that project's repository by the rule", () => {
  const ctx = ctxOf({ repos: REPOS, links: [{ project_id: 'p2', repository_id: 'r-web', scope: 'frontend' }] })
  assert.equal(resolveMeetingTaskProject({ platform: 'react' }, { projectId: 'p2' }, ctx).repositoryId, 'r-web')
})

test('a task with no project has no repository, even when its name matches a repository', () => {
  const ctx = ctxOf({ projects: [], repos: [{ id: 'r1', name: 'granjur' }] })
  assert.deepEqual(resolveMeetingTaskProject({ project: 'granjur' }, {}, ctx), { projectId: null, projectName: null, repositoryId: null, repoReason: 'no-project' })
})

test('reviewProjectOptions sorts by name, drops unnamed rows, and caps at 24', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `id${i}`, name: `Proj ${String(i).padStart(2, '0')}` }))
  const out = reviewProjectOptions([{ id: 'x', name: '' }, ...many.reverse()])
  assert.equal(REVIEW_PROJECT_LIMIT, 24)
  assert.equal(out.length, 24)
  assert.deepEqual(out[0], { id: 'id0', name: 'Proj 00' })
  assert.equal(out[23].name, 'Proj 23')
  assert.deepEqual(reviewProjectOptions(undefined), [])
})

// --- a soft-deleted project is never matched -------------------------------

const P_GONE = { id: 'pGone', name: 'Apollo', deletedAt: new Date('2026-10-01T09:00:00Z') }
/** A db whose project list hides a deleted project unless the read opts in, as the real one does. */
function hidingDb({ links = [], repos = [], meetingProjectId = null } = {}) {
  return {
    project: { findMany: async ({ where }) => [P1, P2, P_GONE].filter((p) => where.includeDeleted === true || !p.deletedAt) },
    repository: { findMany: async () => repos },
    projectRepos: { findMany: async () => links },
    meeting: { findUnique: async () => ({ id: 'M', projectId: meetingProjectId }) },
  }
}

test('a deleted project is never matched: not by its name, and not as the meeting project', async () => {
  const ctx = await loadProjectContext(hidingDb({ meetingProjectId: 'pGone' }), { guildConfigId: 'g', meetingId: 'M' })
  assert.deepEqual(ctx.projects.map((p) => p.id), ['p1', 'p2'])
  assert.equal(settledProject({ project: 'Apollo' }, ctx), null)
  assert.equal(resolveMeetingTaskProject({ project: 'Apollo' }, { projectId: 'pGone' }, ctx).projectId, null)
})

test('a live repository linked only to a deleted project resolves to no project', async () => {
  const ctx = await loadProjectContext(hidingDb({
    repos: [{ id: 'r-apollo', name: 'apollo-api' }, { id: 'r-fw', name: 'framework-backend' }],
    links: [
      { project_id: 'pGone', repository_id: 'r-apollo', scope: 'backend' },
      { project_id: 'p1', repository_id: 'r-fw', scope: 'backend' },
    ],
  }), { guildConfigId: 'g', meetingId: 'M' })
  assert.deepEqual(ctx.links.map((l) => l.project_id), ['p1'], "the deleted project's link is dropped")
  assert.equal(settledProject({ project: 'apollo_api' }, ctx), null)
  const out = resolveMeetingTaskProject({ project: 'apollo_api', platform: 'node' }, {}, ctx)
  assert.equal(out.projectId, null)
  assert.equal(out.repositoryId, null)
  // A live project's own link still resolves.
  assert.deepEqual(settledProject({ project: 'framework-backend' }, ctx), { projectId: 'p1', projectName: 'Framework' })
})
