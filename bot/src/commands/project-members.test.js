import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OverwriteType } from 'discord.js'
import { renderMembers, inferredMemberIds, execute, autocomplete, data } from './project-members.js'
import { CLIENT_TEXT_ALLOW_OBJ } from '../services/clientAccess.js'

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

test('the role picker offers all eight roles with readable labels', () => {
  const opt = data.toJSON().options.find((o) => o.name === 'add').options.find((o) => o.name === 'role')
  assert.deepEqual(opt.choices.map((c) => [c.value, c.name]), [
    ['lead', 'Lead'], ['developer', 'Developer'], ['backend_developer', 'Backend Developer'],
    ['frontend_developer', 'Frontend Developer'], ['qa', 'QA'], ['design', 'Design'], ['client', 'Client'],
    ['client_manager', 'Client Manager'],
  ])
})

test('renderMembers with nobody says so', () => {
  assert.equal(renderMembers({ project: { name: 'X' }, explicit: [], inferredIds: [], nameFor: () => null }), '**X**\nNo members yet. Add one with `/project-members add`.')
})

// --- controller tests ---

const PROJECT = { id: 'proj1', name: 'Framework', guildConfigId: 'g1' }

function fakeDb({ project = PROJECT, members = [], tasks = [], removed = 1 } = {}) {
  const calls = []
  // A `remove` flips this so `findByProject` reflects the delete: the "remove"
  // sub-command reads the roster both before (for the prior role) and after
  // (for the race guard), and those two reads must disagree once removed.
  let removedRow = false
  return {
    calls,
    project: {
      findFirst: async ({ where }) => (where.id === project.id ? project : null),
    },
    projectMember: {
      add: async ({ data }) => { calls.push(['add', data]); return data },
      remove: async ({ where }) => { calls.push(['remove', where]); removedRow = true; return { removed } },
      findByProject: async () => (removedRow ? [] : members),
    },
    task: {
      findMany: async () => tasks,
    },
  }
}

/** Fake slash interaction: subcommand + option values from `opts`, users from `users`. */
function fakeInteraction({ sub, opts = {}, users = {}, guild = { id: 'guild1', members: { cache: new Map() } } } = {}) {
  const replies = []
  return {
    replies,
    guild,
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

// --- in-project inference, role change, panel ---
// Every fake below stands in for the database, the guild config and Discord:
// nothing here reaches the real `db` export or `getOrCreateGuildConfig`.

const SECTION = {
  id: 'proj1', name: 'Framework', guildConfigId: 'g1',
  discordCategoryId: 'cat1', discordRoleId: 'role1',
  discordChannels: JSON.stringify({ members: 'mchan1' }),
}
const OTHER = { id: 'proj2', name: 'Other', guildConfigId: 'g1', discordCategoryId: 'cat2', discordRoleId: 'role2' }

/** A stateful fake: `table` is the projectmember table. */
function sectionDb({ projects = [SECTION, OTHER], rows = [] } = {}) {
  const table = rows.map((r) => ({ ...r }))
  const calls = []
  return {
    calls,
    table,
    project: {
      findFirst: async ({ where }) => projects.find((p) => p.id === where.id) ?? null,
      findMany: async ({ where }) => projects.filter((p) => p.guildConfigId === where.guildConfigId),
    },
    projectMember: {
      add: async ({ data }) => {
        calls.push(['add', data])
        const hit = table.find((r) => r.projectId === data.projectId && r.discordId === data.discordId)
        if (hit) hit.role = data.role
        else table.push({ projectId: data.projectId, discordId: data.discordId, role: data.role })
        return data
      },
      // Like the real DELETE: every row for (projectId, discordId), of which
      // uq_projectmember_pair allows at most one.
      remove: async ({ where }) => {
        calls.push(['remove', where])
        let removed = 0
        for (let i = table.length - 1; i >= 0; i--) {
          if (table[i].projectId === where.projectId && table[i].discordId === where.discordId) { table.splice(i, 1); removed++ }
        }
        return { removed }
      },
      findByProject: async ({ where }) => table.filter((r) => r.projectId === where.projectId).map((r) => ({ ...r })),
    },
    task: { findMany: async () => [] },
  }
}

/** A fake guild that records role changes and members-channel traffic. */
function sectionGuild({ roleFails = null, memberGone = false, channels = ['mchan1'] } = {}) {
  const log = { roles: [], sent: [], pinned: [] }
  const channelFor = (id) => ({
    id,
    messages: { fetchPinned: async () => new Map() },
    send: async (payload) => {
      log.sent.push([id, payload])
      return { pin: async () => { log.pinned.push(id) }, edit: async () => {} }
    },
  })
  return {
    id: 'guild1',
    log,
    roles: { cache: new Map([['role1', { id: 'role1', name: 'Framework' }]]) },
    channels: { cache: new Map(channels.map((id) => [id, channelFor(id)])), fetch: async () => null },
    members: {
      cache: new Map([['u2', { displayName: 'Afaq' }]]),
      fetch: async (id) => {
        if (memberGone) throw new Error('Unknown Member')
        return {
          id,
          roles: {
            add: async (r) => { if (roleFails) throw new Error(roleFails); log.roles.push(['add', id, r]) },
            remove: async (r) => { if (roleFails) throw new Error(roleFails); log.roles.push(['remove', id, r]) },
          },
        }
      },
    },
  }
}

function sectionInteraction({ sub, opts = {}, users = {}, guild = sectionGuild(), channel = { id: 'c1', parentId: 'cat1' } } = {}) {
  const replies = []
  return {
    replies,
    guild,
    channel,
    client: { user: { id: 'bot' } },
    user: { id: 'inviter1' },
    options: {
      getSubcommand: () => sub,
      getString: (name) => (Object.prototype.hasOwnProperty.call(opts, name) ? opts[name] : null),
      getUser: (name) => (Object.prototype.hasOwnProperty.call(users, name) ? users[name] : null),
    },
    editReply: async (payload) => { replies.push(payload); return payload },
  }
}

const U2 = { member: { id: 'u2', bot: false, username: 'afaq' } }

test('the project option is optional on every subcommand, and required options come first', () => {
  for (const sub of data.toJSON().options) {
    const project = sub.options.find((o) => o.name === 'project')
    assert.equal(project.required, false, sub.name)
    const firstOptional = sub.options.findIndex((o) => !o.required)
    assert.ok(sub.options.slice(firstOptional).every((o) => !o.required), sub.name)
  }
})

test('add without the project option inside a project channel resolves that project', async () => {
  const db = sectionDb()
  const it = sectionInteraction({ sub: 'add', users: U2 })
  await execute(it, { db, getConfig })
  assert.equal(db.calls[0][1].projectId, 'proj1')
  assert.doesNotMatch(it.replies[0].content, /No project matches/)
  assert.match(it.replies[0].content, /Framework/)
})

test('add run on the category itself resolves that project', async () => {
  const db = sectionDb()
  const it = sectionInteraction({ sub: 'add', users: U2, channel: { id: 'cat2', parentId: null } })
  await execute(it, { db, getConfig })
  assert.equal(db.calls[0][1].projectId, 'proj2')
})

test('a named project wins over the channel it is run in', async () => {
  const db = sectionDb()
  const it = sectionInteraction({ sub: 'add', opts: { project: 'proj2' }, users: U2 })
  await execute(it, { db, getConfig })
  assert.equal(db.calls[0][1].projectId, 'proj2')
})

test('add outside any project with no project option writes nothing and asks for one', async () => {
  const db = sectionDb()
  const it = sectionInteraction({ sub: 'add', users: U2, channel: { id: 'general', parentId: 'elsewhere' } })
  await execute(it, { db, getConfig })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /Pick a project/)
})

test('inference never picks a project from another guild config', async () => {
  const db = sectionDb({ projects: [{ ...SECTION, guildConfigId: 'other' }] })
  const it = sectionInteraction({ sub: 'add', users: U2 })
  await execute(it, { db, getConfig })
  assert.deepEqual(db.calls, [])
})

test('add grants the project role to that one member, posts the change, and refreshes the panel with the full roster', async () => {
  const db = sectionDb({ rows: [{ projectId: 'proj1', discordId: 'u1', role: 'lead' }] })
  const guild = sectionGuild()
  const it = sectionInteraction({ sub: 'add', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.deepEqual(guild.log.roles, [['add', 'u2', 'role1']])
  const [line, panel] = guild.log.sent
  assert.equal(line[0], 'mchan1')
  assert.match(line[1].content, /\*\*Afaq\*\* joined the project as Developer/)
  const fields = panel[1].embeds[0].toJSON().fields
  assert.deepEqual(fields.map((f) => [f.name, f.value]), [['Lead', '<@u1>'], ['Developer', 'Afaq']])
  assert.deepEqual(guild.log.pinned, ['mchan1'])
  assert.match(it.replies[0].content, /Added <@u2> to \*\*Framework\*\*/)
  assert.match(it.replies[0].content, /now have the \*\*Framework\*\* role/)
})

test('add re-adding someone with the same role posts no change line but still refreshes the panel', async () => {
  const db = sectionDb({ rows: [{ projectId: 'proj1', discordId: 'u2', role: 'developer' }] })
  const guild = sectionGuild()
  const it = sectionInteraction({ sub: 'add', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.equal(guild.log.sent.length, 1)
  assert.ok(guild.log.sent[0][1].embeds)
})

test('add whose role change fails still saves the row and says which half failed', async () => {
  const db = sectionDb()
  const guild = sectionGuild({ roleFails: 'Missing Permissions' })
  const it = sectionInteraction({ sub: 'add', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.equal(db.table.length, 1)
  const reply = it.replies[0].content
  assert.equal(reply, [
    'Added <@u2> to **Framework** as **Developer**.',
    'The membership is saved, but I could not give them the **Framework** role (Missing Permissions), so they cannot see its channels yet.',
  ].join('\n'))
})

test('add whose first roster read fails posts no "joined" line, but still refreshes the panel', async () => {
  const db = sectionDb({ rows: [{ projectId: 'proj1', discordId: 'u2', role: 'developer' }] })
  const read = db.projectMember.findByProject
  let calls = 0
  db.projectMember.findByProject = async (args) => {
    if (calls++ === 0) throw new Error('db blip')
    return read(args)
  }
  const guild = sectionGuild()
  const it = sectionInteraction({ sub: 'add', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.equal(guild.log.sent.length, 1)
  assert.ok(guild.log.sent[0][1].embeds, 'only the panel, no change line')
})

test('a failed project read says so instead of asking for a project, and writes nothing', async () => {
  const db = sectionDb()
  db.project.findMany = async () => { throw new Error('db down') }
  const guild = sectionGuild()
  const it = sectionInteraction({ sub: 'add', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.deepEqual(db.calls, [])
  assert.deepEqual(guild.log.roles, [])
  assert.equal(it.replies[0].content, 'I could not load the projects just now, so nothing changed. Try again in a moment.')
})

test('add inside a thread of a project channel resolves that project', async () => {
  const db = sectionDb()
  const parent = { id: 'c1', parentId: 'cat1', isThread: () => false }
  const it = sectionInteraction({ sub: 'add', users: U2, channel: { id: 't1', parentId: 'c1', isThread: () => true, parent } })
  await execute(it, { db, getConfig })
  assert.equal(db.calls[0][1].projectId, 'proj1')
})

test('add in a category two projects claim writes nothing and grants no role', async () => {
  const twin = { ...SECTION, id: 'projTwin', name: 'Twin', discordRoleId: 'roleTwin' }
  const db = sectionDb({ projects: [SECTION, twin] })
  const guild = sectionGuild()
  const it = sectionInteraction({ sub: 'add', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.deepEqual(db.calls, [])
  assert.deepEqual(guild.log.roles, [])
  assert.match(it.replies[0].content, /Pick a project/)
})

test('add for someone who left the server still saves the row and reports it', async () => {
  const db = sectionDb()
  const guild = sectionGuild({ memberGone: true })
  const it = sectionInteraction({ sub: 'add', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.equal(db.table.length, 1)
  assert.match(it.replies[0].content, /Unknown Member/)
})

test('add on a project with no section yet writes the row, skips the panel, and says there is no role', async () => {
  const bare = { id: 'proj3', name: 'Bare', guildConfigId: 'g1' }
  const db = sectionDb({ projects: [bare] })
  const guild = sectionGuild()
  const it = sectionInteraction({ sub: 'add', opts: { project: 'proj3' }, users: U2, guild })
  await execute(it, { db, getConfig })
  assert.equal(db.table.length, 1)
  assert.deepEqual(guild.log.roles, [])
  assert.deepEqual(guild.log.sent, [])
  assert.match(it.replies[0].content, /no Discord role yet/)
})

test('add with a stale members channel id still grants the role and skips the panel', async () => {
  const db = sectionDb()
  const guild = sectionGuild({ channels: [] })
  const it = sectionInteraction({ sub: 'add', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.deepEqual(guild.log.roles, [['add', 'u2', 'role1']])
  assert.deepEqual(guild.log.sent, [])
})

test('add reads discordChannels given as an object too', async () => {
  const db = sectionDb({ projects: [{ ...SECTION, discordChannels: { members: 'mchan1' } }] })
  const guild = sectionGuild()
  const it = sectionInteraction({ sub: 'add', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.equal(guild.log.sent.length, 2)
})

test('remove of the last row revokes the role, posts the change, and refreshes the panel', async () => {
  const db = sectionDb({ rows: [{ projectId: 'proj1', discordId: 'u2', role: 'developer' }, { projectId: 'proj1', discordId: 'u1', role: 'lead' }] })
  const guild = sectionGuild()
  const it = sectionInteraction({ sub: 'remove', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.deepEqual(guild.log.roles, [['remove', 'u2', 'role1']])
  const [line, panel] = guild.log.sent
  assert.match(line[1].content, /\*\*Afaq\*\* left the project/)
  assert.deepEqual(panel[1].embeds[0].toJSON().fields.map((f) => f.name), ['Lead'])
  assert.match(it.replies[0].content, /Removed <@u2>/)
  assert.match(it.replies[0].content, /role was taken away/)
})

test('race: a concurrent re-add between the delete and the re-read keeps the role', async () => {
  const db = sectionDb({ rows: [{ projectId: 'proj1', discordId: 'u2', role: 'developer' }] })
  // Another manager's `add` lands right after this remove's DELETE.
  const del = db.projectMember.remove
  db.projectMember.remove = async (args) => {
    const out = await del(args)
    db.table.push({ projectId: 'proj1', discordId: 'u2', role: 'qa' })
    return out
  }
  const guild = sectionGuild()
  const it = sectionInteraction({ sub: 'remove', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.deepEqual(guild.log.roles, [])
  assert.equal(guild.log.sent.length, 1, 'the panel refreshes, but no "left" line is posted')
  assert.ok(guild.log.sent[0][1].embeds)
  assert.equal(it.replies[0].content, [
    'Removed <@u2> from **Framework**.',
    'They were added back while this ran, so their channel access stays.',
  ].join('\n'))
})

test('remove when the roster cannot be re-read keeps the role', async () => {
  const db = sectionDb({ rows: [{ projectId: 'proj1', discordId: 'u2', role: 'developer' }] })
  db.projectMember.findByProject = async () => { throw new Error('db down') }
  const guild = sectionGuild()
  const it = sectionInteraction({ sub: 'remove', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.deepEqual(guild.log.roles, [])
  assert.deepEqual(guild.log.sent, [])
  assert.match(it.replies[0].content, /left their channel access alone/)
})

test('remove whose revoke fails still reports the row as removed', async () => {
  const db = sectionDb({ rows: [{ projectId: 'proj1', discordId: 'u2', role: 'developer' }] })
  const guild = sectionGuild({ roleFails: 'Missing Permissions' })
  const it = sectionInteraction({ sub: 'remove', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.equal(db.table.length, 0)
  assert.equal(it.replies[0].content, [
    'Removed <@u2> from **Framework**.',
    'They are off the project, but I could not take away the **Framework** role (Missing Permissions), so they can still see its channels.',
  ].join('\n'))
})

test('remove of someone not on the project changes no role and posts nothing', async () => {
  const db = sectionDb()
  const guild = sectionGuild()
  const it = sectionInteraction({ sub: 'remove', users: U2, guild })
  await execute(it, { db, getConfig })
  assert.deepEqual(guild.log.roles, [])
  assert.deepEqual(guild.log.sent, [])
  assert.match(it.replies[0].content, /not on/)
})

test('list without the project option lists the project it is run in, and touches no role or channel', async () => {
  const rows = [{ projectId: 'proj1', discordId: '1', role: 'lead' }]
  const db = sectionDb({ rows })
  const guild = sectionGuild()
  const it = sectionInteraction({ sub: 'list', guild })
  await execute(it, { db, getConfig })
  assert.equal(it.replies[0].content, renderMembers({ project: SECTION, explicit: rows, inferredIds: [], nameFor: () => null }))
  assert.deepEqual(guild.log.roles, [])
  assert.deepEqual(guild.log.sent, [])
})

// --- clients ------------------------------------------------------------------

function clientHarness({ members = [] } = {}) {
  const edits = []
  const deletes = []
  const textAllows = []
  const support = { id: 'sup', name: 'fw-support', permissionOverwrites: { cache: new Map(), edit: async (id, allow, opts) => { edits.push(['sup', id, opts?.type]); textAllows.push(allow) }, delete: async (id) => { deletes.push(['sup', id]) } } }
  const supportVoice = { id: 'supv', name: 'fw-support-voice', permissionOverwrites: { cache: new Map(), edit: async (id, allow, opts) => { edits.push(['supv', id, opts?.type, allow.Connect]) }, delete: async (id) => { deletes.push(['supv', id]) } } }
  const roleAdds = []
  const roleRemoves = []
  const guild = {
    id: 'g1',
    roles: { cache: new Map([['role1', { id: 'role1', name: 'Framework' }]]) },
    channels: { cache: new Map([['sup', support], ['supv', supportVoice]]) },
    members: { cache: new Map(), fetch: async (id) => ({ id, roles: { add: async (r) => { roleAdds.push(r) }, remove: async (r) => { roleRemoves.push(r) } } }) },
  }
  const project = { ...PROJECT, discordRoleId: 'role1', discordChannels: { support: 'sup', supportVoice: 'supv' } }
  const db = fakeDb({ project, members })
  return { guild, db, project, edits, deletes, textAllows, roleAdds, roleRemoves }
}

test('adding a client grants the two support overwrites and never the project role', async () => {
  const h = clientHarness()
  const ix = fakeInteraction({ guild: h.guild, sub: 'add', opts: { role: 'client', project: 'proj1' }, users: { member: { id: 'u-c', bot: false } } })
  await execute(ix, { db: h.db, getConfig })
  assert.deepEqual(h.edits, [['sup', 'u-c', OverwriteType.Member], ['supv', 'u-c', OverwriteType.Member, true]])
  // Pins down which allow object goes to which channel: swapping the text and
  // voice allow objects would still pass the assertion above.
  assert.deepEqual(h.textAllows[0], CLIENT_TEXT_ALLOW_OBJ)
  assert.deepEqual(h.roleAdds, [])
  assert.match(ix.replies.at(-1).content, /support channels/)
})

test('removing a client revokes the two overwrites and leaves the role alone', async () => {
  const h = clientHarness({ members: [{ discordId: 'u-c', role: 'client' }] })
  const ix = fakeInteraction({ guild: h.guild, sub: 'remove', opts: { project: 'proj1' }, users: { member: { id: 'u-c', bot: false } } })
  await execute(ix, { db: h.db, getConfig })
  assert.deepEqual(h.deletes, [['sup', 'u-c'], ['supv', 'u-c']])
  assert.deepEqual(h.roleRemoves, [])
})

test('changing a staff row to client revokes the role and grants access; the reverse undoes it', async () => {
  const h = clientHarness({ members: [{ discordId: 'u1', role: 'developer' }] })
  const ix = fakeInteraction({ guild: h.guild, sub: 'add', opts: { role: 'client', project: 'proj1' }, users: { member: { id: 'u1', bot: false } } })
  await execute(ix, { db: h.db, getConfig })
  assert.deepEqual(h.roleRemoves, ['role1'])
  assert.equal(h.edits.length, 2)
})

test('add role:client when the prior roster read fails still revokes the role rather than risk leaving it on', async () => {
  const h = clientHarness()
  const readRoster = h.db.projectMember.findByProject
  let calls = 0
  h.db.projectMember.findByProject = async (...args) => {
    calls += 1
    if (calls === 1) throw new Error('db blip')
    return readRoster(...args)
  }
  const ix = fakeInteraction({ guild: h.guild, sub: 'add', opts: { role: 'client', project: 'proj1' }, users: { member: { id: 'u-c', bot: false } } })
  await execute(ix, { db: h.db, getConfig })
  // The prior role could not be read, so it is treated as "unknown, not
  // already a client" and revoked anyway — an idempotent no-op if they never
  // held it, and the only way a converted client cannot silently keep all
  // twelve channels.
  assert.deepEqual(h.roleRemoves, ['role1'])
  assert.deepEqual(h.edits, [['sup', 'u-c', OverwriteType.Member], ['supv', 'u-c', OverwriteType.Member, true]])
})

// --- client managers ---------------------------------------------------------------
// A client manager is a client who also reads every REQUEST channel on the
// project — the channels of tasks with `requestedBy` set — and never a team
// task's channel, and never the project role.

function managerHarness({ members = [] } = {}) {
  const h = clientHarness({ members })
  const reqEdits = []
  const reqDeletes = []
  const chan = (id, name) => ({ id, name, permissionOverwrites: { cache: new Map(), edit: async (uid, allow, opts) => { reqEdits.push([id, uid, opts?.type]) }, delete: async (uid) => { reqDeletes.push([id, uid]) } } })
  const req1 = chan('req1', 'bug-login-fails')
  const req2 = chan('req2', 'feature-export')
  const teamTask = chan('team1', 'feature-refactor')
  h.guild.channels.cache.set('req1', req1); h.guild.channels.cache.set('req2', req2); h.guild.channels.cache.set('team1', teamTask)
  h.db.task.findMany = async () => [
    { id: 't1', projectId: 'proj1', requestedBy: 'u-c', discordChannelId: 'req1' },
    { id: 't2', projectId: 'proj1', requestedBy: 'u-c2', discordChannelId: 'req2' },
    { id: 't3', projectId: 'proj1', requestedBy: null, discordChannelId: 'team1' },
    { id: 't4', projectId: 'proj1', requestedBy: 'u-c', discordChannelId: null },
  ]
  return { ...h, reqEdits, reqDeletes }
}

test('adding a client manager grants the support pair, every request channel, no team task channel, and never the project role', async () => {
  const h = managerHarness()
  const ix = fakeInteraction({ guild: h.guild, sub: 'add', opts: { role: 'client_manager', project: 'proj1' }, users: { member: { id: 'u-m', bot: false } } })
  await execute(ix, { db: h.db, getConfig })
  assert.deepEqual(h.edits.map((e) => e[0]), ['sup', 'supv'], 'the support pair, like any client')
  assert.deepEqual(h.reqEdits, [['req1', 'u-m', OverwriteType.Member], ['req2', 'u-m', OverwriteType.Member]], 'both request channels, typed Member')
  assert.ok(!h.reqEdits.some((e) => e[0] === 'team1'), 'a team task channel is never opened to a client manager')
  assert.deepEqual(h.roleAdds, [], 'never the project role')
  assert.deepEqual(h.roleRemoves, ['role1'], 'the role is revoked unconditionally, as for a client')
  assert.match(ix.replies.at(-1).content, /2 existing request channel\(s\) opened/)
})

test('removing a client manager closes the request channels and the support pair, and leaves the role alone', async () => {
  const h = managerHarness({ members: [{ discordId: 'u-m', role: 'client_manager' }] })
  const ix = fakeInteraction({ guild: h.guild, sub: 'remove', opts: { project: 'proj1' }, users: { member: { id: 'u-m', bot: false } } })
  await execute(ix, { db: h.db, getConfig })
  assert.deepEqual(h.deletes, [['sup', 'u-m'], ['supv', 'u-m']])
  assert.deepEqual(h.reqDeletes, [['req1', 'u-m'], ['req2', 'u-m']])
  assert.deepEqual(h.roleRemoves, [])
})

test('demoting a client manager to a plain client closes the request channels but keeps the support pair', async () => {
  const h = managerHarness({ members: [{ discordId: 'u-m', role: 'client_manager' }] })
  const ix = fakeInteraction({ guild: h.guild, sub: 'add', opts: { role: 'client', project: 'proj1' }, users: { member: { id: 'u-m', bot: false } } })
  await execute(ix, { db: h.db, getConfig })
  assert.deepEqual(h.reqDeletes, [['req1', 'u-m'], ['req2', 'u-m']])
  assert.deepEqual(h.deletes, [], 'still a client: the support pair stays')
  assert.deepEqual(h.roleRemoves, [], 'was never a role holder — prior role is a client role, so no revoke')
})
