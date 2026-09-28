import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleStatusRequest, handleUpdateRequest, handleCreateRequest, handleSubtaskRequest } from './internalTaskRoute.js'

const task = { id: 'A', guildConfigId: 'g1', title: 'Git Sync', status: 'open' }
const db = {
  task: { findFirst: async ({ where }) => (where.id === 'A' ? task : null) },
  guildMember: { findByConfigEmail: async ({ where }) => (where.email === 'a@granjur.com' ? { discordId: 'u-aashir' } : null) },
}
const ok = { headers: { 'x-internal-secret': 's3cret' }, body: { taskId: 'A', status: 'in_progress', actor: { email: 'a@granjur.com', name: 'Aashir' } } }

test('503 when no secret is configured, before anything else', async () => {
  const r = await handleStatusRequest({ ...ok, db, client: {}, secret: '' })
  assert.equal(r.status, 503)
})
test('401 on a missing or wrong secret', async () => {
  assert.equal((await handleStatusRequest({ ...ok, headers: {}, db, client: {}, secret: 's3cret' })).status, 401)
  assert.equal((await handleStatusRequest({ ...ok, headers: { 'x-internal-secret': 'nope' }, db, client: {}, secret: 's3cret' })).status, 401)
})
test('400 on an unknown status or missing taskId', async () => {
  assert.equal((await handleStatusRequest({ ...ok, body: { ...ok.body, status: 'flying' }, db, client: {}, secret: 's3cret' })).status, 400)
  const r = await handleStatusRequest({ ...ok, body: { status: 'open' }, db, client: {}, secret: 's3cret' })
  assert.equal(r.status, 400)
  assert.equal(r.body.message, 'taskId is required')
})
test('400 when taskId is over the length cap', async () => {
  const r = await handleStatusRequest({ ...ok, body: { ...ok.body, taskId: 'x'.repeat(65) }, db, client: {}, secret: 's3cret' })
  assert.equal(r.status, 400)
  assert.equal(r.body.message, 'taskId is too long (max 64)')
})
test('a null or non-object body is treated as empty, not a crash', async () => {
  const r1 = await handleStatusRequest({ headers: ok.headers, body: null, db, client: {}, secret: 's3cret' })
  assert.equal(r1.status, 400)
  assert.equal(r1.body.message, 'taskId is required')
  const r2 = await handleStatusRequest({ headers: ok.headers, body: 'x', db, client: {}, secret: 's3cret' })
  assert.equal(r2.status, 400)
  assert.equal(r2.body.message, 'taskId is required')
})
test('404 when the task does not exist', async () => {
  assert.equal((await handleStatusRequest({ ...ok, body: { ...ok.body, taskId: 'Z' }, db, client: {}, secret: 's3cret' })).status, 404)
})
test('same status is a no-op 200', async () => {
  let applied = 0
  const r = await handleStatusRequest({ ...ok, body: { ...ok.body, status: 'open' }, db, client: {}, secret: 's3cret', apply: async () => { applied++ } })
  assert.equal(r.status, 200); assert.equal(r.body.unchanged, true); assert.equal(applied, 0)
})
test('success applies with a "(via the site)" label and returns the warning', async () => {
  let seen
  const r = await handleStatusRequest({ ...ok, db, client: { c: 1 }, secret: 's3cret', apply: async (a) => { seen = a; return { warning: '⛔ x', notified: {} } } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, task: { id: 'A', status: 'in_progress' }, warning: '⛔ x', unchanged: false })
  assert.deepEqual(seen.updates, { status: 'in_progress' })
  assert.equal(seen.actor.label, 'Aashir (via the site)')
})
test('a thrown error becomes 500 without leaking a stack', async () => {
  const errors = []; const orig = console.error; console.error = (...a) => errors.push(a)
  try {
    const r = await handleStatusRequest({ ...ok, db, client: {}, secret: 's3cret', apply: async () => { throw new Error('db down') } })
    assert.equal(r.status, 500); assert.equal(r.body.ok, false); assert.equal(r.body.message, 'db down')
  } finally { console.error = orig }
})

test('the site user is matched to their Discord member by email for the activity log', async () => {
  let seen
  await handleStatusRequest({ ...ok, db, client: {}, secret: 's3cret', apply: async (a) => { seen = a; return { warning: '' } } })
  assert.equal(seen.actor.activityId, 'u-aashir')
  // The mention-triggering id is deliberately not set: a site edit never @mentions.
  assert.equal(seen.actor.discordId, undefined)
})
test('an email with no verified member still applies, with no activity id', async () => {
  let seen
  const other = { ...ok, body: { ...ok.body, actor: { email: 'nobody@granjur.com', name: 'Nobody' } } }
  const r = await handleStatusRequest({ ...other, db, client: {}, secret: 's3cret', apply: async (a) => { seen = a; return { warning: '' } } })
  assert.equal(r.status, 200)
  assert.equal(seen.actor.activityId, null)
})
test('a failing member lookup never blocks the update', async () => {
  const orig = console.error; console.error = () => {}
  try {
    let seen
    const broken = { ...db, guildMember: { findByConfigEmail: async () => { throw new Error('boom') } } }
    const r = await handleStatusRequest({ ...ok, db: broken, client: {}, secret: 's3cret', apply: async (a) => { seen = a; return { warning: '' } } })
    assert.equal(r.status, 200)
    assert.equal(seen.actor.activityId, null)
  } finally { console.error = orig }
})

test('finishing a task that has open subtasks is a 409 with the rule\'s own message, not a 500', async () => {
  const { TaskRuleError } = await import('../utils/taskHierarchy.js')
  const orig = console.error; const errors = []; console.error = (...a) => errors.push(a)
  try {
    const r = await handleStatusRequest({
      ...ok, body: { ...ok.body, status: 'done' }, db, client: {}, secret: 's3cret',
      apply: async () => { throw new TaskRuleError('**Git Sync** can\'t be marked done yet — 2 subtasks are still open') },
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.ok, false)
    assert.match(r.body.message, /2 subtasks are still open/)
    assert.equal(errors.length, 0) // a rule refusal is not logged as a fault
  } finally { console.error = orig }
})

const H = { 'x-internal-secret': 's3cret' }
const T = { id: 'T', guildConfigId: 'g1', type: 'feature', title: 'Git Sync', status: 'open', description: null, scope: null, implementationStatus: 'not_started', projectId: 'P1', projectName: 'Framework', assigneeIds: ['u1'], taggedMemberIds: [], estimateMinutes: null }
function routeDb(extra = {}) {
  return {
    task: {
      findFirst: async ({ where }) => (where.id === 'T' ? { ...T } : null),
      findByIds: async ({ where }) => where.ids.filter((id) => id === 'B').map((id) => ({ id, title: 'Blocker', status: 'open' })),
    },
    taskDependency: { findManyForGuild: async () => [{ taskId: 'B', blockedByTaskId: 'T' }] },
    project: { findFirst: async ({ where }) => (where.id === 'P1' ? { id: 'P1', name: 'Framework', guildConfigId: 'g1' } : where.id === 'PX' ? { id: 'PX', name: 'Other guild', guildConfigId: 'g2' } : null) },
    guildMember: {
      findByConfigEmail: async ({ where }) => (where.email === 'a@granjur.com' ? { discordId: 'u-aashir' } : null),
      findMany: async () => [{ discordId: 'u1' }, { discordId: 'u2' }],
    },
    guildConfig: { findById: async () => ({ id: 'g1', guildId: 'G1' }) },
    repository: { findMany: async () => [{ id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }] },
    ...extra,
  }
}
const actor = { email: 'a@granjur.com', name: 'Aashir' }

for (const [name, handler] of [['update', handleUpdateRequest], ['create', handleCreateRequest], ['subtask', handleSubtaskRequest]]) {
  test(`${name}: 503 without a secret, 401 on a wrong one, null body is not a crash`, async () => {
    assert.equal((await handler({ headers: H, body: {}, db: routeDb(), client: {}, secret: '' })).status, 503)
    assert.equal((await handler({ headers: { 'x-internal-secret': 'nope' }, body: {}, db: routeDb(), client: {}, secret: 's3cret' })).status, 401)
    assert.equal((await handler({ headers: H, body: null, db: routeDb(), client: {}, secret: 's3cret' })).status, 400)
  })
}

test('update: 404 for an unknown task', async () => {
  const r = await handleUpdateRequest({ headers: H, body: { taskId: 'Z', changes: { title: 'x' } }, db: routeDb(), client: {}, secret: 's3cret' })
  assert.equal(r.status, 404)
})
test('update: a refused field is a 400 with the rule sentence and nothing is applied', async () => {
  let edits = 0
  const r = await handleUpdateRequest({ headers: H, body: { taskId: 'T', changes: { passedApiTests: 900 }, actor }, db: routeDb(), client: {}, secret: 's3cret', edit: async () => { edits++ } })
  assert.equal(r.status, 400)
  assert.equal(r.body.message, 'Test counts must be whole numbers from 0 to 127.')
  assert.equal(edits, 0)
})
test('update: a refused blocker writes nothing, not even the valid fields beside it', async () => {
  let edits = 0
  const r = await handleUpdateRequest({ headers: H, body: { taskId: 'T', changes: { title: 'Renamed', blockerIds: ['B'] }, actor }, db: routeDb(), client: {}, secret: 's3cret', edit: async () => { edits++ } })
  assert.equal(r.status, 400)
  assert.equal(r.body.message, 'Blocker already depends on Git Sync, so Git Sync cannot be blocked by Blocker.')
  assert.equal(edits, 0)
})
test('update: nothing actually changed is a 200 unchanged with no write', async () => {
  let edits = 0
  const r = await handleUpdateRequest({ headers: H, body: { taskId: 'T', changes: { title: 'Git Sync', description: '' }, actor }, db: routeDb(), client: {}, secret: 's3cret', edit: async () => { edits++ } })
  assert.equal(r.status, 200)
  assert.equal(r.body.unchanged, true)
  assert.equal(edits, 0)
})
test('update: success passes updates, blockers and a site actor, and joins the project-move note into the warning', async () => {
  let seen
  const db = routeDb({ taskDependency: { findManyForGuild: async () => [] } })
  const r = await handleUpdateRequest({
    headers: H, body: { taskId: 'T', changes: { title: 'Renamed', projectId: null, holderIds: ['u2'], blockerIds: ['B'] }, actor }, db, client: {}, secret: 's3cret',
    edit: async (a) => { seen = a; return { error: null, dep: { lines: ['**Blocked by:** Blocker'] }, warning: '⛔ x', notified: {} } },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(seen.updates, { title: 'Renamed', projectId: null, projectName: null, assigneeIds: ['u2'] })
  assert.deepEqual(seen.blockers, { add: ['B'], remove: [] })
  assert.deepEqual(seen.actor, { activityId: 'u-aashir', label: 'Aashir (via the site)' })
  assert.equal(seen.actor.discordId, undefined, 'a site actor is never mentioned')
  assert.match(r.body.warning, /^⛔ x\nThis task now belongs to no project/)
  assert.deepEqual(r.body.lines, ['**Blocked by:** Blocker'])
  assert.equal(r.body.unchanged, false)
})
test('update: a project in another guild is refused', async () => {
  const r = await handleUpdateRequest({ headers: H, body: { taskId: 'T', changes: { projectId: 'PX' } }, db: routeDb(), client: {}, secret: 's3cret', edit: async () => ({}) })
  assert.equal(r.status, 400)
  assert.equal(r.body.message, 'No project matches that id.')
})
test('update: a write-time rule refusal from applyEdit is a 409', async () => {
  const r = await handleUpdateRequest({ headers: H, body: { taskId: 'T', changes: { status: 'done' } }, db: routeDb(), client: {}, secret: 's3cret', edit: async () => ({ error: "Git Sync can't be marked done yet", dep: { lines: [] } }) })
  assert.equal(r.status, 409)
})

const guildClient = { guilds: { cache: { get: (id) => (id === 'G1' ? { id: 'G1' } : undefined) } } }
test('create: project required and must exist', async () => {
  const r1 = await handleCreateRequest({ headers: H, body: { type: 'feature', title: 'x' }, db: routeDb(), client: guildClient, secret: 's3cret' })
  assert.equal(r1.status, 400); assert.equal(r1.body.message, 'projectId is required')
  const r2 = await handleCreateRequest({ headers: H, body: { type: 'feature', title: 'x', projectId: 'P9' }, db: routeDb(), client: guildClient, secret: 's3cret' })
  assert.equal(r2.status, 400); assert.equal(r2.body.message, 'No project matches that id.')
})
test('create: the guild missing from the bot cache is a 500 with a sentence', async () => {
  const r = await handleCreateRequest({ headers: H, body: { type: 'feature', title: 'x', projectId: 'P1' }, db: routeDb(), client: { guilds: { cache: { get: () => undefined } } }, secret: 's3cret', create: async () => { throw new Error('must not run') } })
  assert.equal(r.status, 500)
  assert.equal(r.body.message, 'The Discord server is not available to the bot right now.')
})
test('create: validated fields, the bug repo row and a site actor reach createTask', async () => {
  let seen
  const r = await handleCreateRequest({
    headers: H, body: { type: 'bug', title: 'Crash', projectId: 'P1', holderIds: ['u1'], repositoryIds: ['R1'], actor: { email: 'nobody@x.com', name: 'Nobody' } },
    db: routeDb(), client: guildClient, secret: 's3cret',
    create: async (a) => { seen = a; return { task: { id: 'N1', type: 'bug', status: 'pending', projectId: 'P1' }, channel: { id: 'ch9' }, fellBack: 'missing', issueUrl: '' } },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(seen.fields.repositoryIds, ['R1'])
  assert.deepEqual(seen.repo, { id: 'R1', name: 'bot', url: 'https://github.com/g/bot' })
  assert.deepEqual(seen.actor, { discordId: null, label: 'Nobody (via the site)', viaSite: true })
  assert.deepEqual(r.body.task, { id: 'N1', type: 'bug', status: 'pending', projectId: 'P1' })
  assert.equal(r.body.channelId, 'ch9')
  assert.equal(r.body.fellBack, 'missing')
  assert.equal(r.body.note, 'Framework has no Discord section yet, so the channel went to the global Bugs category. Run /project-setup for it.')
})
test('create: an unknown member is a 400', async () => {
  const r = await handleCreateRequest({ headers: H, body: { type: 'feature', title: 'x', projectId: 'P1', holderIds: ['u9'] }, db: routeDb(), client: guildClient, secret: 's3cret' })
  assert.equal(r.status, 400); assert.equal(r.body.message, 'u9 is not a member of this Discord server.')
})

test('subtask: title required, 404 for an unknown parent, members checked', async () => {
  assert.equal((await handleSubtaskRequest({ headers: H, body: { parentId: 'T', title: ' ' }, db: routeDb(), client: guildClient, secret: 's3cret' })).body.message, 'A subtask needs a title.')
  assert.equal((await handleSubtaskRequest({ headers: H, body: { parentId: 'Z', title: 'x' }, db: routeDb(), client: guildClient, secret: 's3cret' })).status, 404)
  assert.equal((await handleSubtaskRequest({ headers: H, body: { parentId: 'T', title: 'x', holderIds: ['u9'] }, db: routeDb(), client: guildClient, secret: 's3cret' })).status, 400)
})
test('subtask: success hands createSubtask the parent, fields and a site actor', async () => {
  let seen
  const r = await handleSubtaskRequest({
    headers: H, body: { parentId: 'T', title: ' Write tests ', holderIds: ['u2'], actor }, db: routeDb(), client: guildClient, secret: 's3cret',
    addSubtask: async (a) => { seen = a; return { id: 'S1', status: 'open', parentTaskId: 'T' } },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, task: { id: 'S1', status: 'open', parentId: 'T' } })
  assert.equal(seen.parent.id, 'T')
  assert.deepEqual(seen.fields, { title: 'Write tests', assigneeIds: ['u2'] })
  assert.deepEqual(seen.actor, { activityId: 'u-aashir', label: 'Aashir (via the site)' })
  assert.deepEqual(seen.guild, { id: 'G1' })
})
test('subtask: a TaskRuleError from createSubtask is a 409', async () => {
  const { TaskRuleError } = await import('../utils/taskHierarchy.js')
  const r = await handleSubtaskRequest({ headers: H, body: { parentId: 'T', title: 'x' }, db: routeDb(), client: guildClient, secret: 's3cret', addSubtask: async () => { throw new TaskRuleError('A task can have at most 25 subtasks.') } })
  assert.equal(r.status, 409); assert.equal(r.body.message, 'A task can have at most 25 subtasks.')
})
