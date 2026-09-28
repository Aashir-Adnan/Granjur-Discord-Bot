import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTask } from './taskCreate.js'

const cfg = { id: 'g1' }
const project = { id: 'P1', name: 'Framework', guildConfigId: 'g1', discordCategoryId: 'cat1' }
const baseFields = { type: 'feature', title: 'Sync', description: 'd', scope: 'backend', modules: ['auth'], holderIds: ['u2'], repositoryIds: ['R1', 'R2'], tracks: { apiTests: true, qaTests: false, acceptanceCriteria: false } }

function fakeDb() {
  const log = []
  let n = 0
  const row = (data, type) => ({ id: `task${++n}`, ...data, type })
  return {
    log,
    feature: { create: async ({ data }) => { log.push(['feature.create', data]); return row(data, 'feature') }, update: async (a) => { log.push(['feature.update', a.data]) } },
    bugTicket: { create: async ({ data }) => { log.push(['bug.create', data]); return row(data, 'bug') }, update: async (a) => { log.push(['bug.update', a.data]) } },
    featureRepositories: { add: async (id, ids) => { log.push(['repos.add', id, ids]) } },
    ticketDoc: { create: async ({ data }) => { log.push(['doc.create', data.ticketType]) } },
  }
}
function fakeChannelMaker() {
  const calls = []
  const maker = async (guild, opts) => {
    calls.push(opts)
    const channel = { id: 'ch1' }
    if (opts.onCreated) await opts.onCreated(channel)
    return { channel, fellBack: null, placed: 'section' }
  }
  return { calls, maker }
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
  assert.deepEqual(db.log.find((l) => l[0] === 'feature.update')[1], { discordChannelId: 'ch1' })
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

test('a bug with a project: pending row, GitHub issue, project-section channel via the shared helper', async () => {
  const db = fakeDb()
  const { calls, maker } = fakeChannelMaker()
  const repo = { id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }
  let issued = null
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, project, repo,
    fields: { ...baseFields, type: 'bug', modules: [], repositoryIds: ['R1'] },
    actor: { discordId: null, label: 'Me (via the site)', viaSite: true }, createChannel: maker,
    openIssue: async (url, title) => { issued = [url, title]; return { url: 'https://github.com/g/bot/issues/7', number: 7 } },
  })
  const [, data] = db.log.find((l) => l[0] === 'bug.create')
  assert.equal(data.status, 'pending'); assert.equal(data.projectId, 'P1'); assert.deepEqual(data.taggedMemberIds, ['u2'])
  assert.deepEqual(issued, ['https://github.com/g/bot', 'Sync'])
  assert.deepEqual(db.log.find((l) => l[0] === 'bug.update' && l[1].externalIssueUrl)[1], { externalIssueUrl: 'https://github.com/g/bot/issues/7', externalIssueNumber: 7 })
  assert.equal(calls[0].type, 'bug'); assert.equal(calls[0].project, project)
  assert.ok(calls[0].fields.some((f) => f.name === 'Issue' && f.value === 'https://github.com/g/bot/issues/7'))
  assert.equal(r.issueUrl, 'https://github.com/g/bot/issues/7')
})

test('a failed GitHub issue never fails the create', async () => {
  const db = fakeDb()
  const { maker } = fakeChannelMaker()
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, project, repo: { id: 'R1', name: 'bot', url: 'https://github.com/g/bot' },
    fields: { ...baseFields, type: 'bug', modules: [], repositoryIds: ['R1'] }, actor: {}, createChannel: maker,
    openIssue: async () => { throw new Error('rate limited') },
  })
  assert.equal(r.issueUrl, '')
  assert.equal(r.channel.id, 'ch1')
})

test('a bug without a project keeps the global Bugs channel (the /create-task path)', async () => {
  const db = fakeDb()
  const created = []
  const guild = {
    id: 'G',
    channels: {
      cache: { find: () => ({ id: 'bugsCat', type: 4, name: 'Bugs' }), filter: () => ({ size: 0 }) },
      create: async (opts) => { created.push(opts); return { id: 'bch', send: async () => {} } },
    },
  }
  const r = await createTask({
    db, guild, cfg, project: null, repo: null,
    fields: { ...baseFields, type: 'bug', modules: [], repositoryIds: [] }, actor: { discordId: 'u-me' },
    createChannel: async () => { throw new Error('must not be used for a project-less bug') },
    getCategory: async () => ({ id: 'bugsCat' }),
  })
  assert.equal(created[0].parent, 'bugsCat')
  assert.match(created[0].name, /^bug-/)
  assert.equal(r.channel.id, 'bch')
  assert.deepEqual(db.log.find((l) => l[0] === 'bug.update' && l[1].discordChannelId)[1], { discordChannelId: 'bch' })
})
