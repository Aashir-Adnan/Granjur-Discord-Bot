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
  assert.deepEqual(picked, { projectId: 'p2', projectName: 'Badar HMS', repositoryId: null })
  const ignored = resolveMeetingTaskProject({}, { projectId: 'p2' }, ctxOf({ meetingProjectId: 'p1' }))
  assert.equal(ignored.projectId, 'p1')
})

test('a picked project that no longer exists, "none", or a legacy state gives no project and no name', () => {
  const none = { projectId: null, projectName: null, repositoryId: null }
  assert.deepEqual(resolveMeetingTaskProject({ project: 'Ghost' }, { projectId: 'deleted' }, ctxOf()), none)
  assert.deepEqual(resolveMeetingTaskProject({ project: 'Ghost' }, { projectId: null }, ctxOf()), none)
  assert.deepEqual(resolveMeetingTaskProject({ project: 'Ghost' }, { taskId: 'a' }, ctxOf()), none)
})

test("the matched repository is kept only when the match's project is the task's project", () => {
  const ctx = ctxOf({
    repos: [{ id: 'r2', name: 'Badar_HMS_Node' }],
    links: [{ project_id: 'p2', repository_id: 'r2' }],
  })
  // Rule 2 settled on the match: its repository comes along.
  assert.equal(resolveMeetingTaskProject({ project: 'Badar HMS' }, {}, ctx).repositoryId, 'r2')
  // Rule 1 overrode the match: the match's repository belongs to another project.
  assert.equal(resolveMeetingTaskProject({ project: 'Badar HMS' }, {}, { ...ctx, meetingProjectId: 'p1' }).repositoryId, null)
})

test('a repository-only match (no project) keeps its repository when the task also has no project', () => {
  const ctx = ctxOf({ projects: [], repos: [{ id: 'r1', name: 'granjur' }] })
  assert.deepEqual(resolveMeetingTaskProject({ project: 'granjur' }, {}, ctx), { projectId: null, projectName: null, repositoryId: 'r1' })
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
