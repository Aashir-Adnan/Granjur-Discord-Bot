import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMembers, inferredMemberIds, execute, autocomplete, data } from './project-members.js'

test('inferredMemberIds: assignees of the project tasks not already explicit, deduplicated', () => {
  const tasks = [
    { assigneeIds: ['1', '2'] }, { assigneeIds: '["2","3"]' }, { assigneeIds: [], taggedMemberIds: ['4'] },
  ]
  assert.deepEqual(inferredMemberIds(tasks, ['1']), ['2', '3', '4'])
})

test('renderMembers groups by role and lists inferred people separately', () => {
  const out = renderMembers({
    project: { name: 'Framework' },
    explicit: [{ discordId: '1', role: 'lead' }, { discordId: '2', role: 'developer' }],
    inferredIds: ['3'],
    nameFor: (id) => ({ 1: 'Aashir', 2: 'Afaq', 3: 'Hassan' })[id],
  })
  assert.equal(out, [
    '**Framework**',
    '**Lead:** Aashir',
    '**Developer:** Afaq',
    '',
    '_Also assigned to tasks here:_ Hassan',
  ].join('\n'))
})

test('renderMembers lists Backend and Frontend Developers as their own groups, in role order', () => {
  const out = renderMembers({
    project: { name: 'Framework' },
    explicit: [
      { discordId: '3', role: 'frontend_developer' },
      { discordId: '2', role: 'backend_developer' },
      { discordId: '4', role: 'qa' },
      { discordId: '1', role: 'lead' },
    ],
    inferredIds: [],
    nameFor: (id) => ({ 1: 'Aashir', 2: 'Afaq', 3: 'Hamza', 4: 'Mukarram' })[id],
  })
  assert.equal(out, [
    '**Framework**',
    '**Lead:** Aashir',
    '**Backend Developer:** Afaq',
    '**Frontend Developer:** Hamza',
    '**QA:** Mukarram',
  ].join('\n'))
})

test('the role picker offers all six roles with readable labels', () => {
  const opt = data.toJSON().options.find((o) => o.name === 'add').options.find((o) => o.name === 'role')
  assert.deepEqual(opt.choices.map((c) => [c.value, c.name]), [
    ['lead', 'Lead'], ['developer', 'Developer'], ['backend_developer', 'Backend Developer'],
    ['frontend_developer', 'Frontend Developer'], ['qa', 'QA'], ['design', 'Design'],
  ])
})

test('renderMembers with nobody says so', () => {
  assert.equal(renderMembers({ project: { name: 'X' }, explicit: [], inferredIds: [], nameFor: () => null }), '**X**\nNo members yet. Add one with `/project-members add`.')
})

// --- controller tests ---

const PROJECT = { id: 'proj1', name: 'Framework', guildConfigId: 'g1' }

function fakeDb({ project = PROJECT, members = [], tasks = [], removed = 1 } = {}) {
  const calls = []
  return {
    calls,
    project: {
      findFirst: async ({ where }) => (where.id === project.id ? project : null),
    },
    projectMember: {
      add: async ({ data }) => { calls.push(['add', data]); return data },
      remove: async ({ where }) => { calls.push(['remove', where]); return { removed } },
      findByProject: async () => members,
    },
    task: {
      findMany: async () => tasks,
    },
  }
}

/** Fake slash interaction: subcommand + option values from `opts`, users from `users`. */
function fakeInteraction({ sub, opts = {}, users = {} } = {}) {
  const replies = []
  return {
    replies,
    guild: { id: 'guild1', members: { cache: new Map() } },
    user: { id: 'inviter1' },
    options: {
      getSubcommand: () => sub,
      getString: (name) => (Object.prototype.hasOwnProperty.call(opts, name) ? opts[name] : null),
      getUser: (name) => (Object.prototype.hasOwnProperty.call(users, name) ? users[name] : null),
    },
    editReply: async (payload) => { replies.push(payload); return payload },
  }
}

const getConfig = async () => ({ id: 'g1' })

test('execute add with no role: adds as developer, addedBy the invoker, reply names project and Developer', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ sub: 'add', opts: { project: 'proj1' }, users: { member: { id: 'u2', bot: false } } })
  await execute(it, { db, getConfig })
  assert.deepEqual(db.calls, [['add', { guildConfigId: 'g1', projectId: 'proj1', discordId: 'u2', role: 'developer', addedBy: 'inviter1' }]])
  const reply = it.replies[0]
  assert.match(reply.content, /Framework/)
  assert.match(reply.content, /Developer/)
})

test('execute add naming a bot user is refused, nothing written', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ sub: 'add', opts: { project: 'proj1' }, users: { member: { id: 'bot1', bot: true } } })
  await execute(it, { db, getConfig })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /[Bb]ot/)
})

test('execute remove of someone not on the project says so', async () => {
  const db = fakeDb({ removed: 0 })
  const it = fakeInteraction({ sub: 'remove', opts: { project: 'proj1' }, users: { member: { id: 'u2', bot: false } } })
  await execute(it, { db, getConfig })
  assert.match(it.replies[0].content, /not on/)
})

test('execute with a project id from another guild refuses, nothing written', async () => {
  const db = fakeDb({ project: { id: 'proj1', name: 'Framework', guildConfigId: 'other' } })
  const it = fakeInteraction({ sub: 'add', opts: { project: 'proj1' }, users: { member: { id: 'u2', bot: false } } })
  await execute(it, { db, getConfig })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /No project matches/)
})

test('execute list replies with renderMembers output for the fake rows', async () => {
  const members = [{ discordId: '1', role: 'lead' }]
  const tasks = [{ assigneeIds: ['2'] }]
  const db = fakeDb({ members, tasks })
  const it = fakeInteraction({ sub: 'list', opts: { project: 'proj1' } })
  await execute(it, { db, getConfig })
  const expected = renderMembers({ project: PROJECT, explicit: members, inferredIds: inferredMemberIds(tasks, ['1']), nameFor: () => null })
  assert.equal(it.replies[0].content, expected)
})
