import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkImport, resolveAssignees, MAX_IMPORT_TASKS } from './taskImport.js'
import { handleImportCheckRequest } from './internalTaskRoute.js'
import { SCOPE_VALUES } from '../utils/taskScope.js'
import { maxBodyFor, INTERNAL_MAX_BODY, IMPORT_CHECK_MAX_BODY } from '../utils/internalBodyCap.js'

const cfg = { id: 'g1', guildId: 'G1' }
const project = { id: 'P1', name: 'Alpha', guildConfigId: 'g1' }

const ali = { discordId: 'u-ali', guildConfigId: 'g1', email: 'ali@example.com', displayName: 'Ali Khan', username: 'ali_k', status: 'approved', kind: 'staff' }
const sara = { discordId: 'u-sara', guildConfigId: 'g1', email: 'sara@example.com', displayName: 'Sara Khan', username: 'sara', status: 'approved' }
const client = { discordId: 'u-client', guildConfigId: 'g1', email: 'cli@example.com', displayName: 'Cleo Client', username: 'cleo', status: 'approved', kind: 'client' }
const pending = { discordId: 'u-pend', guildConfigId: 'g1', email: 'pend@example.com', displayName: 'Pat Pending', username: 'pat', status: 'pending', kind: 'staff' }
const elsewhere = { discordId: 'u-else', guildConfigId: 'g2', email: 'else@example.com', displayName: 'Ellie Else', username: 'ellie', status: 'approved', kind: 'staff' }
const twin1 = { discordId: 'u-t1', guildConfigId: 'g1', email: 't1@example.com', displayName: 'Twin', username: 't1', status: 'approved', kind: 'staff' }
const twin2 = { discordId: 'u-t2', guildConfigId: 'g1', email: 't2@example.com', displayName: 'Twin', username: 't2', status: 'approved', kind: 'staff' }

/** An in-memory db; any write method throws so a write cannot pass unnoticed. */
function fakeDb({ members = [ali, sara, client, pending, elsewhere, twin1, twin2], repos = [], links = [], tasks = [] } = {}) {
  const writes = []
  const write = (name) => async () => { writes.push(name); throw new Error(`unexpected write: ${name}`) }
  return {
    writes,
    guildMember: {
      findMany: async ({ where }) => members.filter((m) => m.guildConfigId === where.guildConfigId),
      upsert: write('guildMember.upsert'), update: write('guildMember.update'),
    },
    repository: { findMany: async ({ where }) => repos.filter((r) => r.guildConfigId === where.guildConfigId), create: write('repository.create') },
    projectRepos: { findMany: async ({ where }) => links.filter((l) => l.project_id === where.project_id) },
    task: {
      findMany: async ({ where }) => tasks.filter((t) => t.guildConfigId === where.guildConfigId && t.projectId === where.projectId),
      create: write('task.create'), update: write('task.update'),
    },
  }
}

const repo = { id: 'R1', guildConfigId: 'g1', name: 'api', url: 'https://github.com/x/api' }
const withRepo = () => fakeDb({ repos: [repo], links: [{ project_id: 'P1', repository_id: 'R1', scope: null }] })
const check = (tasks, db = fakeDb(), extra = {}) => checkImport({ db, cfg, project, tasks, ...extra })
const one = async (task, db, extra) => (await check([task], db, extra)).tasks[0]

test('a minimal valid feature is ok, open, with no holders', async () => {
  const r = await one({ type: 'feature', title: 'Login' })
  assert.equal(r.index, 0)
  assert.equal(r.ok, true)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.fields, {
    type: 'feature', title: 'Login', description: null, scope: null, status: 'open', modules: [], holderIds: [], repositoryIds: [],
    tracks: { apiTests: false, qaTests: false, acceptanceCriteria: false }, subtasks: [],
  })
})

test('every create refusal surfaces as that task\'s error', async () => {
  const cases = [
    [{ type: 'epic', title: 'x' }, 'type must be feature or bug.'],
    [{ type: 'feature', title: '   ' }, 'A task needs a title.'],
    [{ type: 'feature', title: 'x'.repeat(201) }, 'The title can be at most 200 characters.'],
    [{ type: 'feature', title: 'x', description: 'd'.repeat(2001) }, 'The description can be at most 2000 characters.'],
    [{ type: 'bug', title: 'x', modules: ['m'] }, 'Modules are for features only.'],
    [{ type: 'feature', title: 'x', modules: Array.from({ length: 21 }, (_, i) => `m${i}`) }, 'A feature can list at most 20 modules.'],
  ]
  for (const [task, message] of cases) {
    const r = await one(task, withRepo())
    assert.equal(r.ok, false, message)
    assert.equal(r.fields, null)
    assert.ok(r.errors.includes(message), `${message} in ${JSON.stringify(r.errors)}`)
  }
})

test('a non-object entry is an error, and the others are still checked', async () => {
  const { tasks } = await check([null, 'x', [1], { type: 'feature', title: 'ok' }])
  assert.deepEqual(tasks.map((t) => t.ok), [false, false, false, true])
  for (const t of tasks.slice(0, 3)) assert.deepEqual(t.errors, ['Each task must be an object.'])
  assert.deepEqual(tasks.map((t) => t.index), [0, 1, 2, 3])
})

test('assignees match by email (any case, padded), display name and username', async () => {
  const r = await one({ type: 'feature', title: 'x', assignees: ['  ALI@Example.com ', 'sara khan'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.fields.holderIds, ['u-ali', 'u-sara'])
  assert.deepEqual((await one({ type: 'feature', title: 'x', assignees: ['ali_K'] })).fields.holderIds, ['u-ali'])
})

test('assignee errors: none, several, not text, too many', async () => {
  assert.deepEqual((await one({ type: 'feature', title: 'x', assignees: ['nobody'] })).errors, ['No member matches "nobody".'])
  assert.deepEqual((await one({ type: 'feature', title: 'x', assignees: ['Twin'] })).errors, ['"Twin" matches more than one member — use their email.'])
  assert.deepEqual((await one({ type: 'feature', title: 'x', assignees: [7] })).errors, ['Assignees must be emails or names.'])
  assert.deepEqual((await one({ type: 'feature', title: 'x', assignees: [''] })).errors, ['Assignees must be emails or names.'])
  assert.deepEqual((await one({ type: 'feature', title: 'x', assignees: 'ali@example.com' })).errors, ['Assignees must be emails or names.'])
  const many = Array.from({ length: 51 }, (_, i) => `p${i}@x.com`)
  assert.deepEqual((await one({ type: 'feature', title: 'x', assignees: many })).errors, ['A task can have at most 50 people.'])
})

test('the same person named twice, in two ways, is one holder', async () => {
  const r = await one({ type: 'feature', title: 'x', assignees: ['ali@example.com', 'Ali Khan', 'ali_k'] })
  assert.deepEqual(r.fields.holderIds, ['u-ali'])
})

test('a client, a pending member and a member of another guild are never matched', async () => {
  for (const who of ['cli@example.com', 'Cleo Client', 'cleo', 'pend@example.com', 'Pat Pending', 'pat', 'else@example.com', 'Ellie Else', 'ellie']) {
    const r = await one({ type: 'feature', title: 'x', assignees: [who] })
    assert.equal(r.ok, false, who)
    assert.deepEqual(r.errors, [`No member matches "${who}".`])
  }
})

test('a member row from before the kind column counts as staff', () => {
  assert.deepEqual(resolveAssignees(['sara@example.com'], [sara]), { ids: ['u-sara'], errors: [] })
  assert.deepEqual(resolveAssignees(['cli@example.com'], [client]).ids, [])
})

test('the assignee errors come before the validator error', async () => {
  const r = await one({ type: 'epic', title: 'x', assignees: ['nobody'] })
  assert.deepEqual(r.errors, ['No member matches "nobody".', 'type must be feature or bug.'])
})

test('status: open, in_progress and done are carried; anything else is refused', async () => {
  for (const s of ['open', 'in_progress', 'done']) assert.equal((await one({ type: 'feature', title: 'x', status: s })).fields.status, s)
  assert.equal((await one({ type: 'feature', title: 'x', status: null })).fields.status, 'open')
  const r = await one({ type: 'feature', title: 'x', status: 'blocked' })
  assert.equal(r.ok, false)
  assert.deepEqual(r.errors, ['status must be open, in_progress or done.'])
})

test('a done task needs done subtasks', async () => {
  const bad = await one({ type: 'feature', title: 'x', status: 'done', subtasks: [{ title: 'a', status: 'done' }, { title: 'b', status: 'open' }] })
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.errors, ['A done task cannot have unfinished subtasks.'])
  const noStatus = await one({ type: 'feature', title: 'x', status: 'done', subtasks: [{ title: 'a' }] })
  assert.deepEqual(noStatus.errors, ['A done task cannot have unfinished subtasks.'])
  const good = await one({ type: 'feature', title: 'x', status: 'done', subtasks: [{ title: 'a', status: 'done' }, { title: 'b', status: 'done' }] })
  assert.equal(good.ok, true)
  assert.deepEqual(good.fields.subtasks.map((s) => s.status), ['done', 'done'])
})

test('subtasks: fields are normalised and holders resolved', async () => {
  const r = await one({ type: 'feature', title: 'x', subtasks: [{ title: ' Sub ', description: 'd', scope: 'backend', status: 'in_progress', assignees: ['Ali Khan'] }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.fields.subtasks, [{ title: 'Sub', description: 'd', scope: 'backend', status: 'in_progress', holderIds: ['u-ali'] }])
})

test('a bad subtask makes the parent not ok and names the subtask', async () => {
  const r = await one({ type: 'feature', title: 'x', subtasks: [{ title: 'fine' }, { scope: 'nowhere' }, 'str', { title: 't', assignees: ['nobody'] }] })
  assert.equal(r.ok, false)
  assert.equal(r.fields, null)
  assert.deepEqual(r.errors, [
    'Subtask 2: A task needs a title.',
    `Subtask 2: scope must be one of ${SCOPE_VALUES.join(', ')}, or empty`,
    'Subtask 3: Each subtask must be an object.',
    'Subtask 4: No member matches "nobody".',
  ])
})

test('26 subtasks are refused with one error', async () => {
  const r = await one({ type: 'feature', title: 'x', subtasks: Array.from({ length: 26 }, (_, i) => ({ title: `s${i}` })) })
  assert.deepEqual(r.errors, ['A task can have at most 25 subtasks.'])
  assert.equal((await one({ type: 'feature', title: 'x', subtasks: Array.from({ length: 25 }, (_, i) => ({ title: `s${i}` })) })).ok, true)
})

test('a bug needs a repository for its scope', async () => {
  const none = await one({ type: 'bug', title: 'Crash', scope: 'backend' })
  assert.equal(none.ok, false)
  assert.deepEqual(none.errors, ['This project has no repository for this scope.'])
  const has = await one({ type: 'bug', title: 'Crash', scope: 'backend' }, withRepo())
  assert.equal(has.ok, true)
  assert.deepEqual(has.fields.repositoryIds, [])
  // A done bug needs it too.
  assert.equal((await one({ type: 'bug', title: 'Crash', status: 'done' })).ok, false)
})

test('warning: a title the project already has (case-insensitive, subtasks ignored)', async () => {
  const db = fakeDb({ tasks: [
    { id: 't1', guildConfigId: 'g1', projectId: 'P1', title: '  Login Page ' },
    { id: 't2', guildConfigId: 'g1', projectId: 'P1', title: 'Only a subtask', parentTaskId: 't1' },
    { id: 't3', guildConfigId: 'g1', projectId: 'P2', title: 'Other project' },
  ] })
  const { tasks } = await check([
    { type: 'feature', title: 'login PAGE' }, { type: 'feature', title: 'Only a subtask' }, { type: 'feature', title: 'Other project' },
  ], db, { createIssues: false })
  assert.deepEqual(tasks[0].warnings, ['A task with this title already exists in this project.'])
  assert.equal(tasks[0].ok, true)
  assert.deepEqual(tasks[1].warnings, [])
  assert.deepEqual(tasks[2].warnings, [])
})

test('warning: a title repeated in the file lands on the later task only', async () => {
  const { tasks } = await check([{ type: 'feature', title: 'Same' }, { type: 'feature', title: ' same ' }, { type: 'feature', title: 'SAME' }], fakeDb(), { createIssues: false })
  assert.deepEqual(tasks.map((t) => t.warnings.length), [0, 1, 1])
})

test('warning: an open or in-progress feature with issues on and no repository', async () => {
  const noIssue = 'No repository for this scope, so no GitHub issue will be opened.'
  assert.deepEqual((await one({ type: 'feature', title: 'x' })).warnings, [noIssue])
  assert.deepEqual((await one({ type: 'feature', title: 'x', status: 'in_progress' })).warnings, [noIssue])
  assert.deepEqual((await one({ type: 'feature', title: 'x' }, fakeDb(), { createIssues: false })).warnings, [])
  assert.deepEqual((await one({ type: 'feature', title: 'x', status: 'done' })).warnings, [])
  assert.deepEqual((await one({ type: 'feature', title: 'x' }, withRepo())).warnings, [])
})

test('an invalid task still carries its warnings', async () => {
  const r = await one({ type: 'feature', title: 'x', assignees: ['nobody'] })
  assert.equal(r.ok, false)
  assert.equal(r.warnings.length, 1)
})

test('nothing is written', async () => {
  const db = withRepo()
  await check([
    { type: 'feature', title: 'a', assignees: ['ali@example.com'], subtasks: [{ title: 's' }] },
    { type: 'bug', title: 'b' }, null, { type: 'x' },
  ], db)
  assert.deepEqual(db.writes, [])
})

// ---- the route -------------------------------------------------------------

const H = { 'x-internal-secret': 's3cret' }
const guildClient = { guilds: { cache: { get: (id) => (id === 'G1' ? { id: 'G1' } : undefined) } } }
const routeDb = () => ({
  project: { findFirst: async ({ where }) => (where.id === 'P1' ? project : null) },
  guildConfig: { findById: async (id) => (id === 'g1' ? cfg : null) },
})
const call = (body, extra = {}) => handleImportCheckRequest({ headers: H, body, db: routeDb(), client: guildClient, secret: 's3cret', ...extra })

test('route: 503 without a secret, 401 on a wrong one, a null body is a 400', async () => {
  assert.equal((await call({}, { secret: '' })).status, 503)
  assert.equal((await call({}, { headers: { 'x-internal-secret': 'nope' } })).status, 401)
  assert.equal((await call(null)).status, 400)
})

test('route: 400 for a missing or unknown project, and for bad tasks', async () => {
  const noProject = await call({ tasks: [{}] })
  assert.equal(noProject.status, 400); assert.equal(noProject.body.message, 'projectId is required')
  const unknown = await call({ projectId: 'P9', tasks: [{}] })
  assert.equal(unknown.status, 400); assert.equal(unknown.body.message, 'No project matches that id.')
  for (const tasks of [undefined, 'x', {}, []]) assert.equal((await call({ projectId: 'P1', tasks })).status, 400)
  const big = await call({ projectId: 'P1', tasks: Array.from({ length: MAX_IMPORT_TASKS + 1 }, () => ({})) })
  assert.equal(big.status, 400); assert.equal(big.body.message, 'A file can hold at most 50 tasks.')
})

test('route: 500 when the Discord server is not available', async () => {
  const r = await call({ projectId: 'P1', tasks: [{}] }, { client: { guilds: { cache: { get: () => undefined } } }, check: async () => { throw new Error('must not run') } })
  assert.equal(r.status, 500)
})

test('route: passes cfg, project, tasks and createIssues to the check and returns its verdicts', async () => {
  let seen
  const tasks = [{ type: 'feature', title: 'x' }]
  const verdicts = [{ index: 0, ok: true, errors: [], warnings: [], fields: {} }]
  const r = await call({ projectId: 'P1', tasks, createIssues: false }, { check: async (a) => { seen = a; return { tasks: verdicts } } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, tasks: verdicts })
  assert.deepEqual({ cfg: seen.cfg, project: seen.project, tasks: seen.tasks, createIssues: seen.createIssues }, { cfg, project, tasks, createIssues: false })
  await call({ projectId: 'P1', tasks }, { check: async (a) => { seen = a; return { tasks: [] } } })
  assert.equal(seen.createIssues, true)
})

test('route: the real check runs through the route over a fake db', async () => {
  const db = { ...routeDb(), ...fakeDb() }
  const r = await handleImportCheckRequest({ headers: H, body: { projectId: 'P1', tasks: [{ type: 'feature', title: 'x' }], createIssues: false }, db, client: guildClient, secret: 's3cret' })
  assert.equal(r.status, 200)
  assert.equal(r.body.tasks[0].ok, true)
})

test('body cap: 512 KB for the import check, 64 KB for every other route', () => {
  const size = 300 * 1024
  assert.ok(size <= maxBodyFor('/internal/tasks/import-check'))
  assert.ok(size > maxBodyFor('/internal/tasks/create'))
  assert.equal(maxBodyFor('/internal/tasks/import-check'), 512 * 1024)
  assert.equal(IMPORT_CHECK_MAX_BODY, 512 * 1024)
  for (const url of ['/internal/tasks/create', '/internal/tasks/subtask', '/internal/tasks/update', '/internal/tasks/status', '/internal/clock/in', '/verify', undefined]) {
    assert.equal(maxBodyFor(url), INTERNAL_MAX_BODY)
  }
  assert.equal(INTERNAL_MAX_BODY, 64 * 1024)
})
