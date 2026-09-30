import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTask, issueReplyLine } from './taskCreate.js'
import { GitHubError } from './github.js'

const cfg = { id: 'g1' }
const project = { id: 'P1', name: 'Framework', guildConfigId: 'g1', discordCategoryId: 'cat1' }
const baseFields = { type: 'feature', title: 'Sync', description: 'd', scope: 'backend', modules: ['auth'], holderIds: ['u2'], repositoryIds: ['R1', 'R2'], tracks: { apiTests: true, qaTests: false, acceptanceCriteria: false } }

function fakeDb({ repos = [], links = [] } = {}) {
  const log = []
  let n = 0
  const row = (data, type) => ({ id: `task${++n}`, ...data, type })
  return {
    log,
    feature: { create: async ({ data }) => { log.push(['feature.create', data]); return row(data, 'feature') }, update: async (a) => { log.push(['feature.update', a.data]) } },
    bugTicket: { create: async ({ data }) => { log.push(['bug.create', data]); return row(data, 'bug') }, update: async (a) => { log.push(['bug.update', a.data]) } },
    featureRepositories: { add: async (id, ids) => { log.push(['repos.add', id, ids]) } },
    ticketDoc: { create: async ({ data }) => { log.push(['doc.create', data.ticketType]) } },
    repository: { findMany: async () => repos },
    projectRepos: { findMany: async ({ where }) => links.filter((l) => String(l.project_id) === String(where.project_id)) },
  }
}
function fakeChannelMaker() {
  const calls = []
  const sent = []
  const maker = async (guild, opts) => {
    calls.push(opts)
    const channel = { id: 'ch1', send: async (msg) => { sent.push(msg) } }
    if (opts.onCreated) await opts.onCreated(channel)
    return { channel, fellBack: null, placed: 'section' }
  }
  return { calls, sent, maker }
}

test('a site feature: row, repos, doc, project-section channel, id written back, creator not a holder', async () => {
  const db = fakeDb()
  const { calls, maker } = fakeChannelMaker()
  const r = await createTask({ db, guild: { id: 'G' }, cfg, fields: baseFields, project, actor: { discordId: 'u-me', label: 'Me (via the site)', viaSite: true }, createChannel: maker })
  const [, data] = db.log.find((l) => l[0] === 'feature.create')
  assert.equal(data.createdBy, 'u-me')
  assert.deepEqual(data.assigneeIds, ['u2'], 'the site creator is not auto-added to the holders')
  assert.equal(data.projectId, 'P1'); assert.equal(data.projectName, 'Framework')
  assert.equal(data.repositoryId, 'R1'); assert.equal(data.status, 'open'); assert.equal(data.implementationStatus, 'not_started')
  assert.equal(data.passedApiTests, 0); assert.equal(data.passedQaTests, null)
  assert.deepEqual(db.log.find((l) => l[0] === 'repos.add').slice(2), [['R1', 'R2']])
  assert.ok(db.log.some((l) => l[0] === 'doc.create' && l[1] === 'feature'))
  assert.deepEqual(db.log.find((l) => l[0] === 'feature.update' && l[1].discordChannelId)[1], { discordChannelId: 'ch1' })
  assert.deepEqual(calls[0].memberIds, ['u2', 'u-me'], 'the creator can see the channel')
  assert.equal(calls[0].project, project)
  assert.deepEqual(calls[0].fields.find((f) => f.name === 'Created by'), { name: 'Created by', value: '<@u-me>', inline: true })
  assert.equal(r.channel.id, 'ch1'); assert.equal(r.fellBack, null)
})

test('a site user with no Discord match: createdBy is null and the embed names them', async () => {
  const db = fakeDb()
  const { calls, maker } = fakeChannelMaker()
  await createTask({ db, guild: { id: 'G' }, cfg, fields: baseFields, project, actor: { discordId: null, label: 'ubs@granjur.com (via the site)', viaSite: true }, createChannel: maker })
  assert.equal(db.log.find((l) => l[0] === 'feature.create')[1].createdBy, null)
  assert.deepEqual(calls[0].memberIds, ['u2'])
  assert.equal(calls[0].fields.find((f) => f.name === 'Created by').value, 'ubs@granjur.com (via the site)')
})

test('a Discord feature gets no Created by field (Discord output unchanged)', async () => {
  const db = fakeDb()
  const { calls, maker } = fakeChannelMaker()
  await createTask({ db, guild: { id: 'G' }, cfg, fields: baseFields, project: null, actor: { discordId: 'u-me' }, createChannel: maker })
  assert.equal(calls[0].fields.some((f) => f.name === 'Created by'), false)
  assert.deepEqual(calls[0].fields.map((f) => f.name), ['Status', 'Assignees', 'Scope / Modules'])
})

test("a feature under a project whose link has the task's scope: opens an issue after the channel, updates the row, and posts a follow-up", async () => {
  const repos = [{ id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }]
  const links = [{ project_id: 'P1', repository_id: 'R1', scope: 'backend' }]
  const db = fakeDb({ repos, links })
  const { calls, sent, maker } = fakeChannelMaker()
  let issued = null
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, fields: { ...baseFields, repositoryIds: [] }, project,
    actor: { discordId: 'u-me' }, createChannel: maker,
    openIssue: async (url, title, body) => { issued = { url, title, body }; return { url: 'https://github.com/g/bot/issues/9', number: 9 } },
  })
  assert.equal(issued.url, 'https://github.com/g/bot')
  assert.equal(issued.title, 'Sync')
  assert.equal(issued.body, 'd\n\n---\nScope: Backend · Project: Framework\nDiscord: https://discord.com/channels/G/ch1\nTask ID: task1')
  assert.deepEqual(db.log.find((l) => l[0] === 'feature.update' && l[1].externalIssueUrl)[1], { externalIssueUrl: 'https://github.com/g/bot/issues/9', externalIssueNumber: 9 })
  assert.deepEqual(sent, [{ content: 'GitHub issue: https://github.com/g/bot/issues/9' }])
  assert.deepEqual(r.issue, { url: 'https://github.com/g/bot/issues/9' })
  assert.equal(r.issueUrl, 'https://github.com/g/bot/issues/9')
  assert.equal(db.log.find((l) => l[0] === 'feature.create')[1].repositoryId, 'R1')
  assert.equal(calls[0].fields.some((f) => f.name === 'Issue'), false, 'a feature embed never had an Issue field')
})

test("a bug under a project whose link has the task's scope: the ruled repo wins over the caller's repo, Repository shows it, no Issue field, follow-up posted", async () => {
  const repos = [{ id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }, { id: 'R2', name: 'other', url: 'https://github.com/g/other' }]
  const links = [{ project_id: 'P1', repository_id: 'R1', scope: 'backend' }]
  const db = fakeDb({ repos, links })
  const { calls, sent, maker } = fakeChannelMaker()
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, project, repo: { id: 'R2', name: 'other', url: 'https://github.com/g/other' },
    fields: { ...baseFields, type: 'bug', modules: [], repositoryIds: [] },
    actor: { discordId: null, label: 'Me (via the site)', viaSite: true }, createChannel: maker,
    openIssue: async (url) => ({ url: `${url}/issues/7`, number: 7 }),
  })
  const [, data] = db.log.find((l) => l[0] === 'bug.create')
  assert.equal(data.repositoryId, 'R1', 'the ruled repository wins over the caller-passed repo')
  assert.ok(calls[0].fields.some((f) => f.name === 'Repository' && f.value === 'https://github.com/g/bot'))
  assert.equal(calls[0].fields.some((f) => f.name === 'Issue'), false, 'the embed no longer carries an Issue field')
  assert.deepEqual(sent, [{ content: 'GitHub issue: https://github.com/g/bot/issues/7' }])
  assert.deepEqual(r.issue, { url: 'https://github.com/g/bot/issues/7' })
  assert.equal(r.issueUrl, 'https://github.com/g/bot/issues/7')
})

test('createIssue: false skips opening an issue entirely', async () => {
  const db = fakeDb({ repos: [{ id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }], links: [{ project_id: 'P1', repository_id: 'R1', scope: 'backend' }] })
  const { maker } = fakeChannelMaker()
  let called = false
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, fields: { ...baseFields, repositoryIds: [] }, project,
    actor: { discordId: 'u-me' }, createChannel: maker, createIssue: false,
    openIssue: async () => { called = true; return { url: 'x', number: 1 } },
  })
  assert.equal(called, false)
  assert.equal(r.issue, null)
})

test('no repository for the scope: no issue is opened, and the reason is reported', async () => {
  const links = [{ project_id: 'P1', repository_id: 'R1' }, { project_id: 'P1', repository_id: 'R2' }] // two untagged links
  const repos = [{ id: 'R1', name: 'a', url: 'https://github.com/g/a' }, { id: 'R2', name: 'b', url: 'https://github.com/g/b' }]
  const db = fakeDb({ repos, links })
  const { maker } = fakeChannelMaker()
  let called = false
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, fields: { ...baseFields, scope: 'design', repositoryIds: [] }, project,
    actor: { discordId: 'u-me' }, createChannel: maker,
    openIssue: async () => { called = true; return { url: 'x', number: 1 } },
  })
  assert.equal(called, false)
  assert.deepEqual(r.issue, { skipped: 'the project has no repository for this scope' })
})

test('a GitHubError from openIssue never fails the create and is reported as issue.error, without writing the row', async () => {
  const db = fakeDb({ repos: [{ id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }], links: [{ project_id: 'P1', repository_id: 'R1', scope: 'backend' }] })
  const { maker } = fakeChannelMaker()
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, fields: { ...baseFields, repositoryIds: [] }, project, actor: {}, createChannel: maker,
    openIssue: async () => { throw new GitHubError('no-access', 'No GitHub access to o/r') },
  })
  assert.deepEqual(r.issue, { error: 'No GitHub access to o/r' })
  assert.equal(r.channel.id, 'ch1')
  assert.equal(db.log.some((l) => l[0] === 'feature.update' && l[1].externalIssueUrl), false, 'the row is not updated with an issue on failure')
})

test('a bug with no project but an explicit repo: that repo is used (the Discord no-project path)', async () => {
  const db = fakeDb()
  const created = []
  const sentMessages = []
  const guild = {
    id: 'G',
    channels: {
      cache: { find: () => ({ id: 'bugsCat', type: 4, name: 'Bugs' }), filter: () => ({ size: 0 }) },
      create: async (opts) => { created.push(opts); return { id: 'bch', send: async (msg) => { sentMessages.push(msg) } } },
    },
  }
  const repo = { id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }
  const r = await createTask({
    db, guild, cfg, project: null, repo,
    fields: { ...baseFields, type: 'bug', modules: [], repositoryIds: [] }, actor: { discordId: 'u-me' },
    createChannel: async () => { throw new Error('must not be used for a project-less bug') },
    getCategory: async () => ({ id: 'bugsCat' }),
    openIssue: async (url) => ({ url: `${url}/issues/3`, number: 3 }),
  })
  assert.equal(created[0].parent, 'bugsCat')
  assert.match(created[0].name, /^bug-/)
  assert.equal(r.channel.id, 'bch')
  assert.deepEqual(db.log.find((l) => l[0] === 'bug.update' && l[1].discordChannelId)[1], { discordChannelId: 'bch' })
  assert.deepEqual(r.issue, { url: 'https://github.com/g/bot/issues/3' })
  assert.ok(sentMessages.some((m) => m.content === 'GitHub issue: https://github.com/g/bot/issues/3'), 'the follow-up went to the new channel')
})

// 2026-09-30: a bug never needs a repository.
test('a bug under a project with no repository: row has none, channel made, no issue, the reply line says why', async () => {
  const db = fakeDb({ repos: [{ id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }], links: [] })
  const { maker, calls, sent } = fakeChannelMaker()
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, project, repo: null,
    fields: { ...baseFields, type: 'bug', modules: [], repositoryIds: [] }, actor: { discordId: 'u-me' },
    createChannel: maker, openIssue: async () => { throw new Error('openIssue must not be reached') },
  })
  assert.equal(db.log.find((l) => l[0] === 'bug.create')[1].repositoryId, null)
  assert.equal(calls[0].fields.find((f) => f.name === 'Repository').value, '—')
  assert.equal(r.channel.id, 'ch1')
  assert.deepEqual(r.issue, { skipped: 'the project has no repository for this scope' })
  assert.equal(issueReplyLine(r.issue), 'Issue: not opened — the project has no repository for this scope')
  assert.equal(sent.length, 0, 'a skip posts nothing in the channel')
})

test('a bug with no project and no repository: global Bugs channel, topic shows no repo, no issue, the reply line says why', async () => {
  const db = fakeDb()
  const created = []
  const guild = { id: 'G', channels: { create: async (o) => { created.push(o); return { id: 'bch', send: async () => {} } } } }
  const r = await createTask({
    db, guild, cfg, project: null, repo: null,
    fields: { ...baseFields, type: 'bug', modules: [], repositoryIds: [] }, actor: { discordId: 'u-me' },
    createChannel: async () => { throw new Error('unused') }, getCategory: async () => ({ id: 'bugsCat' }),
    openIssue: async () => { throw new Error('openIssue must not be reached') },
  })
  assert.equal(db.log.find((l) => l[0] === 'bug.create')[1].repositoryId, null)
  assert.match(created[0].topic, /\| Repo: —$/)
  assert.deepEqual(r.issue, { skipped: 'no repository was picked' })
  assert.equal(issueReplyLine(r.issue), 'Issue: not opened — no repository was picked')
})

// F1 (final review, 2026-09-30): a failed issue is said in the task's channel too.
test('a failed issue posts "GitHub issue not opened — <reason>" in the task channel', async () => {
  const db = fakeDb({ repos: [{ id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }], links: [{ project_id: 'P1', repository_id: 'R1', scope: 'backend' }] })
  const { sent, maker } = fakeChannelMaker()
  await createTask({
    db, guild: { id: 'G' }, cfg, fields: { ...baseFields, repositoryIds: [] }, project, actor: {}, createChannel: maker,
    openIssue: async () => { throw new GitHubError('no-access', 'No GitHub access to g/bot') },
  })
  assert.deepEqual(sent, [{ content: 'GitHub issue not opened — No GitHub access to g/bot' }])
})

test('a skipped or switched-off issue posts nothing in the channel', async () => {
  const links = [{ project_id: 'P1', repository_id: 'R1' }, { project_id: 'P1', repository_id: 'R2' }]
  const repos = [{ id: 'R1', name: 'a', url: 'https://github.com/g/a' }, { id: 'R2', name: 'b', url: 'https://github.com/g/b' }]
  for (const createIssue of [true, false]) {
    const { sent, maker } = fakeChannelMaker()
    await createTask({
      db: fakeDb({ repos, links }), guild: { id: 'G' }, cfg, fields: { ...baseFields, scope: 'design', repositoryIds: [] }, project,
      actor: {}, createChannel: maker, createIssue, openIssue: async () => { throw new Error('must not run') },
    })
    assert.deepEqual(sent, [])
  }
})

test('a channel send that throws after a failed issue still returns issue.error', async () => {
  const db = fakeDb({ repos: [{ id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }], links: [{ project_id: 'P1', repository_id: 'R1', scope: 'backend' }] })
  const maker = async (guild, opts) => {
    const channel = { id: 'ch1', send: async () => { throw new Error('missing access') } }
    if (opts.onCreated) await opts.onCreated(channel)
    return { channel, fellBack: null }
  }
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, fields: { ...baseFields, repositoryIds: [] }, project, actor: {}, createChannel: maker,
    openIssue: async () => { throw new GitHubError('github', 'Validation Failed') },
  })
  assert.deepEqual(r.issue, { error: 'Validation Failed' })
})

// M2: the row update after a successful issue is best-effort on its own.
test('a failing row update after the issue opened still returns { url } and posts the link', async () => {
  const db = fakeDb({ repos: [{ id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }], links: [{ project_id: 'P1', repository_id: 'R1', scope: 'backend' }] })
  const realUpdate = db.feature.update
  db.feature.update = async (a) => { if (a.data.externalIssueUrl) throw new Error('db down'); return realUpdate(a) }
  const { sent, maker } = fakeChannelMaker()
  const orig = console.warn; console.warn = () => {}
  let r
  try {
    r = await createTask({
      db, guild: { id: 'G' }, cfg, fields: { ...baseFields, repositoryIds: [] }, project, actor: {}, createChannel: maker,
      openIssue: async (url) => ({ url: `${url}/issues/5`, number: 5 }),
    })
  } finally { console.warn = orig }
  assert.deepEqual(r.issue, { url: 'https://github.com/g/bot/issues/5' })
  assert.equal(r.issueUrl, 'https://github.com/g/bot/issues/5')
  assert.deepEqual(sent, [{ content: 'GitHub issue: https://github.com/g/bot/issues/5' }])
})

// ------------------------------------------------ creating with a status ----

const repoSetup = () => ({
  repos: [{ id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }],
  links: [{ project_id: 'P1', repository_id: 'R1', scope: 'backend' }],
})
const neverCalled = (name) => async () => { throw new Error(`${name} must not be called`) }

test('a done feature: row done, doc and repos still written, no channel, no issue', async () => {
  const db = fakeDb(repoSetup())
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, fields: { ...baseFields, status: 'done' }, project, actor: { discordId: 'u-me' },
    createChannel: neverCalled('createChannel'), openIssue: neverCalled('openIssue'), createIssue: true,
    setStatus: neverCalled('setStatus'),
  })
  const [, data] = db.log.find((l) => l[0] === 'feature.create')
  assert.equal(data.status, 'done')
  assert.ok(db.log.some((l) => l[0] === 'doc.create' && l[1] === 'feature'))
  assert.ok(db.log.some((l) => l[0] === 'repos.add'))
  assert.equal(db.log.some((l) => l[0] === 'feature.update'), false)
  assert.equal(r.task.status, 'done')
  assert.deepEqual({ ...r, task: null }, { task: null, channel: null, fellBack: null, issueUrl: null, issue: null })
})

test('a done bug: row done, repository id kept, doc written, no channel, no issue', async () => {
  const db = fakeDb(repoSetup())
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, project, repo: null,
    fields: { ...baseFields, type: 'bug', modules: [], repositoryIds: [], status: 'done' },
    actor: { discordId: null, label: 'Me (via the site)', viaSite: true },
    createChannel: neverCalled('createChannel'), openIssue: neverCalled('openIssue'), createIssue: true,
  })
  const [, data] = db.log.find((l) => l[0] === 'bug.create')
  assert.equal(data.status, 'done')
  assert.equal(data.repositoryId, 'R1')
  assert.ok(db.log.some((l) => l[0] === 'doc.create' && l[1] === 'bug'))
  assert.equal(db.log.some((l) => l[0] === 'bug.update'), false)
  assert.equal(r.channel, null); assert.equal(r.issue, null); assert.equal(r.issueUrl, null)
})

test('status open is today exactly: a bug stays pending, a feature open, no status change', async () => {
  const f = fakeDb(); const b = fakeDb()
  const setStatus = neverCalled('setStatus')
  await createTask({ db: f, guild: { id: 'G' }, cfg, fields: { ...baseFields, status: 'open' }, project, createChannel: fakeChannelMaker().maker, setStatus })
  await createTask({ db: b, guild: { id: 'G' }, cfg, fields: { ...baseFields, type: 'bug', modules: [], status: 'open' }, project, createChannel: fakeChannelMaker().maker, setStatus })
  assert.equal(f.log.find((l) => l[0] === 'feature.create')[1].status, 'open')
  assert.equal(b.log.find((l) => l[0] === 'bug.create')[1].status, 'pending')
})

test('an in-progress task: channel and issue as today, then one status change, and the result carries it', async () => {
  const db = fakeDb(repoSetup())
  const { calls, maker } = fakeChannelMaker()
  const moves = []
  const guild = { id: 'G' }
  const r = await createTask({
    db, guild, cfg, fields: { ...baseFields, repositoryIds: [], status: 'in_progress' }, project, actor: { discordId: 'u-me' },
    createChannel: maker, openIssue: async (url) => ({ url: `${url}/issues/3`, number: 3 }),
    setStatus: async (a) => { moves.push(a) },
  })
  assert.equal(calls.length, 1)
  assert.equal(db.log.find((l) => l[0] === 'feature.create')[1].status, 'open')
  assert.equal(r.issue.url, 'https://github.com/g/bot/issues/3')
  assert.equal(moves.length, 1)
  assert.equal(moves[0].task.id, 'task1')
  assert.equal(moves[0].guild, guild)
  assert.equal(r.task.status, 'in_progress')
  assert.equal(r.channel.id, 'ch1')
})

test('an in-progress bug is moved from pending; a failing status change is logged and the task is still returned', async () => {
  const db = fakeDb()
  const errors = []; const orig = console.error; console.error = (...a) => errors.push(a)
  try {
    const r = await createTask({
      db, guild: { id: 'G' }, cfg, project,
      fields: { ...baseFields, type: 'bug', modules: [], status: 'in_progress' },
      createChannel: fakeChannelMaker().maker,
      setStatus: async () => { throw new Error('boom') },
    })
    assert.equal(r.task.id, 'task1')
    assert.equal(r.task.status, 'pending', 'the task stays as created')
    assert.equal(errors.length, 1)
  } finally { console.error = orig }
})

test('the default in-progress move goes through applyTaskUpdate without telling anyone', async () => {
  const writes = []
  const db = {
    ...fakeDb(),
    task: { update: async ({ where, data }) => { writes.push([where.id, data]) }, findChildren: async () => [] },
    taskDependency: { findByTask: async () => [] },
    taskActivity: { add: async () => {} },
  }
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, fields: { ...baseFields, status: 'in_progress' }, project, actor: { discordId: 'u-me' },
    createChannel: fakeChannelMaker().maker,
  })
  assert.deepEqual(writes, [['task1', { status: 'in_progress' }]])
  assert.equal(r.task.status, 'in_progress')
})

test('an in-progress bug whose status change succeeds comes back in progress', async () => {
  const db = fakeDb()
  const moves = []
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, project,
    fields: { ...baseFields, type: 'bug', modules: [], status: 'in_progress' },
    createChannel: fakeChannelMaker().maker,
    setStatus: async (a) => { moves.push(a) },
  })
  assert.equal(moves.length, 1)
  assert.equal(r.task.status, 'in_progress')
  assert.equal(r.task.id, 'task1')
})
