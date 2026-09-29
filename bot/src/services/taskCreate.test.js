import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTask } from './taskCreate.js'
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
