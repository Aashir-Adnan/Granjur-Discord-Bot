import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import {
  data,
  execute,
  autocomplete,
  renderPlan,
  renderResult,
  staffOnly,
  clientIdsOf,
} from './project-setup.js'

// --- fakes ------------------------------------------------------------------

function fakeChannel(id, name, { type = ChannelType.GuildText, parentId = null } = {}) {
  const channel = {
    id,
    name,
    type,
    parentId,
    edits: [],
    sent: [],
    permissionOverwrites: { cache: new Map() },
    messages: { fetchPinned: async () => [] },
    async send(payload) {
      channel.sent.push(payload)
      return { pin: async () => {} }
    },
    async edit(opts) {
      channel.edits.push(opts)
      if (opts.name) channel.name = opts.name
      if ('parent' in opts) channel.parentId = opts.parent
      return channel
    },
  }
  return channel
}

function fakeGuild({ channels = [], roles = [], members = [] } = {}) {
  const memberMap = new Map(members.map((m) => [m.id, m]))
  const guild = {
    id: 'G1',
    fetchedAll: 0,
    roles: {
      cache: new Map(roles.map((r) => [r.id, r])),
      // The yardstick for "is this same-named role also a power role".
      everyone: { id: 'G1', name: '@everyone', permissions: 0n },
      calls: [],
      async create(opts) {
        guild.roles.calls.push(opts)
        const role = { id: `role-${guild.roles.calls.length}`, name: opts.name, members: new Map() }
        guild.roles.cache.set(role.id, role)
        return role
      },
    },
    channels: {
      cache: new Map(channels.map((c) => [c.id, c])),
      calls: [],
      async create(opts) {
        guild.channels.calls.push(opts)
        const made = fakeChannel(`new-${guild.channels.calls.length}`, opts.name, {
          type: opts.type,
          parentId: opts.parent ?? null,
        })
        guild.channels.cache.set(made.id, made)
        return made
      },
    },
    members: {
      cache: memberMap,
      async fetch(id) {
        if (id === undefined) {
          guild.fetchedAll += 1
          return memberMap
        }
        const found = memberMap.get(id)
        if (!found) throw new Error('Unknown Member')
        return found
      },
    },
  }
  return guild
}

function fakeMember(id, displayName) {
  const roleIds = new Set()
  return {
    id,
    displayName,
    added: [],
    removed: [],
    roles: {
      cache: roleIds,
      async add(role) {
        this.addedTo = role
        roleIds.add(role?.id ?? role)
      },
      async remove(role) {
        roleIds.delete(role?.id ?? role)
      },
    },
  }
}

const CFG = { id: 'g1' }
const getConfig = async () => CFG

function fakeDb({ projects = [], tasks = [], members = [], onUpdate } = {}) {
  const calls = []
  return {
    calls,
    project: {
      findMany: async ({ where }) => {
        calls.push(['project.findMany', where])
        return projects
      },
      findFirst: async ({ where }) => projects.find((p) => p.id === where.id) ?? null,
      update: async (args) => {
        calls.push(['project.update', args])
        if (onUpdate) onUpdate(args)
        return { id: args?.where?.id }
      },
    },
    task: {
      findMany: async ({ where }) => tasks.filter((t) => t.projectId === where.projectId),
    },
    projectMember: {
      findByProject: async ({ where }) => members.filter((m) => m.projectId === where.projectId),
    },
  }
}

function fakeInteraction({ opts = {}, guild } = {}) {
  const replies = []
  const responses = []
  return {
    replies,
    responses,
    guild,
    user: { id: 'operator1' },
    client: { user: { id: 'bot1' } },
    options: {
      getString: (name) => (Object.prototype.hasOwnProperty.call(opts, name) ? opts[name] : null),
      getBoolean: (name) => (Object.prototype.hasOwnProperty.call(opts, name) ? opts[name] : null),
      getFocused: () => ({ name: 'project', value: opts.focused ?? '' }),
    },
    editReply: async (payload) => {
      replies.push(payload)
      return payload
    },
    respond: async (choices) => {
      responses.push(choices)
      return choices
    },
  }
}

/** Run something that is expected to log, without spraying the test output. */
async function quiet(fn) {
  const warn = console.warn
  const error = console.error
  console.warn = () => {}
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.warn = warn
    console.error = error
  }
}

// --- renderPlan (pure) ------------------------------------------------------

test('a task channel opened to the project role is shown in the preview and the result', () => {
  const plan = renderPlan({ name: 'Framework' }, { tasks: [{ action: 'grant' }, { action: 'none' }] })
  assert.match(plan, /Task channels: 1 to open to the project role, 1 already right/)
  const result = renderResult({ name: 'Framework' }, { granted: ['feature-git-sync'], tasks: 1 })
  // Counted once, not also as a rename or a move.
  assert.match(result, /^\*\*Framework\*\* — 1 opened to the project role \(incl\. 1 task channel\)\./)
})

test('renderPlan on an empty plan says there is nothing to do', () => {
  assert.equal(renderPlan({ name: 'Framework' }, {}), '**Framework** — nothing to do.')
  assert.equal(renderPlan({ name: 'Framework' }), '**Framework** — nothing to do.')
})

test('renderPlan names the role and category, counts the channels, and prints planner warnings', () => {
  const out = renderPlan(
    { name: 'Framework' },
    {
      role: { action: 'create', name: 'Framework' },
      category: { action: 'create', name: '📂 FRAMEWORK' },
      channels: [
        { key: 'members', action: 'create', name: 'framework-members' },
        { key: 'meetings', action: 'reuse', name: 'framework-meetings' },
        { key: 'documentation', action: 'move', name: 'framework-documentation' },
      ],
      tasks: [
        { taskId: 't1', action: 'move', name: 'git-sync' },
        { taskId: 't2', action: 'none', name: 'login' },
      ],
      warnings: ['the category is full'],
    }
  )
  assert.match(out, /Preview/)
  assert.match(out, /Role: create \*\*Framework\*\*/)
  assert.match(out, /Category: create \*\*📂 FRAMEWORK\*\*/)
  assert.match(out, /Channels: 1 to create/)
  assert.match(out, /1 to move/)
  assert.match(out, /Task channels: 1 to move/)
  assert.match(out, /the category is full/)
})

test('renderPlan spells out a refused role rather than printing an action word', () => {
  const out = renderPlan(
    { name: 'Project Manager' },
    { role: { action: 'refuse', name: 'Project Manager', reason: '"Project Manager" is a managed role.' } }
  )
  assert.match(out, /refused/)
  assert.match(out, /managed role/)
})

// --- renderResult (pure) ----------------------------------------------------

test('renderResult on an empty result says nothing changed', () => {
  assert.equal(renderResult({ name: 'Framework' }, {}), '**Framework** — nothing to change.')
  assert.equal(renderResult({ name: 'Framework' }), '**Framework** — nothing to change.')
})

test('renderResult counts what was done, the role sync, and the warnings', () => {
  const out = renderResult(
    { name: 'Framework' },
    {
      role: { id: 'r1', name: 'Framework' },
      created: ['a', 'b'],
      renamed: ['c'],
      moved: [],
      tasks: 3,
      warnings: ['channel "x": Missing Permissions'],
      roleSync: { granted: ['u1', 'u2'], revoked: ['u3'], failed: ['u4 (Missing Permissions)'] },
    }
  )
  assert.match(out, /\*\*Framework\*\*/)
  assert.match(out, /2 created/)
  assert.match(out, /1 renamed/)
  assert.match(out, /3 task channels/)
  assert.match(out, /Role \*\*Framework\*\*/)
  assert.match(out, /2 granted/)
  assert.match(out, /1 revoked/)
  assert.match(out, /1 could not be changed/)
  assert.match(out, /Missing Permissions/)
})

// --- the command shape ------------------------------------------------------

test('all three options are optional and project autocompletes', () => {
  const json = data.toJSON()
  assert.equal(json.name, 'project-setup')
  const byName = Object.fromEntries(json.options.map((o) => [o.name, o]))
  assert.equal(byName.project.required ?? false, false)
  assert.equal(byName.project.autocomplete, true)
  assert.equal(byName.all.required ?? false, false)
  assert.equal(byName.preview.required ?? false, false)
})

// --- execute ----------------------------------------------------------------

const PROJECT = { id: 'p1', name: 'Framework', docsSlug: 'framework', guildConfigId: 'g1' }

test('execute with neither project nor all refuses and reads nothing', async () => {
  const db = fakeDb({ projects: [PROJECT] })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild })
  await execute(it, { db, getConfig })
  assert.match(it.replies[0].content, /project/i)
  assert.match(it.replies[0].content, /all/i)
  assert.equal(guild.channels.calls.length, 0)
  assert.equal(db.calls.length, 0)
})

test('execute with a project from another guild refuses, nothing touched', async () => {
  const db = fakeDb({ projects: [{ ...PROJECT, guildConfigId: 'other' }] })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })
  await execute(it, { db, getConfig })
  assert.match(it.replies[0].content, /No project matches/)
  assert.equal(guild.channels.calls.length, 0)
  assert.equal(guild.roles.calls.length, 0)
})

test('preview:true creates nothing, edits nothing, writes nothing, and prints the plan', async () => {
  const strayChannel = fakeChannel('c9', 'framework-members')
  const db = fakeDb({ projects: [PROJECT] })
  const guild = fakeGuild({ channels: [strayChannel] })
  const it = fakeInteraction({ guild, opts: { project: 'p1', preview: true } })

  await execute(it, { db, getConfig })

  assert.equal(guild.channels.calls.length, 0, 'no channel was created')
  assert.equal(guild.roles.calls.length, 0, 'no role was created')
  assert.equal(strayChannel.edits.length, 0, 'no channel was edited')
  assert.equal(strayChannel.sent.length, 0, 'no members panel was posted')
  // A preview DOES fetch the member list: it is a read, and the role decision
  // it prints is decided by how many people hold the same-named role. Reading
  // that off an unfetched cache would print "nobody holds it" for a role
  // twenty people hold, and the real run would then adopt it.
  assert.equal(guild.fetchedAll, 1, 'a preview reads the member list so its role decision is the real one')
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.update'), [], 'nothing was saved')
  const content = it.replies[0].content
  assert.match(content, /Preview/)
  assert.match(content, /Role: create \*\*Framework\*\*/)
  assert.match(content, /Category: create \*\*📂 FRAMEWORK\*\*/)
  assert.match(content, /Channels: 11 to create/)
  assert.match(content, /1 to move/)
})

test('a run with project: applies the plan, syncs the role, and replies with the counts', async () => {
  const on = fakeMember('u1', 'Aashir')
  const off = fakeMember('u2', 'Afaq')
  const db = fakeDb({
    projects: [PROJECT],
    tasks: [{ id: 't1', projectId: 'p1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' }],
    members: [{ projectId: 'p1', discordId: 'u1', role: 'lead' }],
  })
  const taskChannel = fakeChannel('tc1', 'feature-0145e3', { parentId: 'OLD' })
  const guild = fakeGuild({ channels: [taskChannel], members: [on, off] })
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.equal(guild.roles.calls.length, 1, 'the project role was created')
  // One category plus the twelve section channels.
  assert.equal(guild.channels.calls.length, 13)
  assert.equal(taskChannel.edits.length, 1, 'the task channel moved in one edit')
  const category = [...guild.channels.cache.values()].find((c) => c.type === ChannelType.GuildCategory)
  assert.equal(taskChannel.edits[0].parent, category.id, 'it moved into the new category')
  const saved = db.calls.find((c) => c[0] === 'project.update')
  assert.ok(saved, 'the ids were saved')
  assert.equal(saved[1].where.id, 'p1')
  assert.ok(saved[1].data.discordCategoryId)
  assert.ok(saved[1].data.discordChannels.members)
  assert.equal(guild.fetchedAll, 1, 'the member list was fetched before the role sync')
  assert.ok(on.roles.cache.size === 1, 'the member on the project got the role')

  const content = it.replies[0].content
  // The task channel is counted in `moved` AND in `tasks`, so it is named once
  // as a count and once as a breakdown of that count — fourteen objects, not
  // fifteen.
  assert.equal(
    content.split('\n')[0],
    '**Framework** — 13 created, 1 moved (incl. 1 task channel).'
  )
  assert.match(content, /1 granted/)
})

test('a run with project: refreshes the pinned members panel with the roster it holds', async () => {
  const db = fakeDb({ projects: [PROJECT], members: [{ projectId: 'p1', discordId: 'u1', role: 'lead' }] })
  const guild = fakeGuild({ channels: [], members: [fakeMember('u1', 'Aashir')] })
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  const membersChannel = [...guild.channels.cache.values()].find((c) => c.name === 'framework-members')
  assert.ok(membersChannel, 'the members channel exists')
  assert.equal(membersChannel.sent.length, 1, 'the panel was posted')
  const embed = membersChannel.sent[0].embeds[0].toJSON()
  assert.match(embed.title, /Framework/)
  assert.equal(embed.fields[0].value, 'Aashir')
})

test('a client shows on the pinned members panel but never gets the project role', async () => {
  const db = fakeDb({
    projects: [PROJECT],
    members: [
      { projectId: 'p1', discordId: 'u1', role: 'lead' },
      { projectId: 'p1', discordId: 'u2', role: 'client' },
    ],
  })
  const guild = fakeGuild({ channels: [], members: [fakeMember('u1', 'Aashir'), fakeMember('u2', 'Baaji')] })
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  const membersChannel = [...guild.channels.cache.values()].find((c) => c.name === 'framework-members')
  const embed = membersChannel.sent[0].embeds[0].toJSON()
  const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]))
  assert.equal(fields.Lead, 'Aashir')
  assert.equal(fields.Client, 'Baaji', 'the panel keeps the client, labelled Client')

  assert.equal(guild.members.cache.get('u1').roles.cache.size, 1, 'the lead got the project role')
  assert.equal(guild.members.cache.get('u2').roles.cache.size, 0, 'the client never got the project role')
})

test('a project named after a managed role is reported, and the rest of the section is still built', async () => {
  const project = { id: 'p2', name: 'Project Manager', docsSlug: 'project-manager', guildConfigId: 'g1' }
  const db = fakeDb({ projects: [project] })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { project: 'p2' } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.equal(guild.roles.calls.length, 0, 'no role was created for a managed name')
  const content = it.replies[0].content
  assert.match(content, /managed role/)
  assert.match(content, /Project Manager/)
  assert.match(content, /created/)
})

test('the reply carries the planner\'s warnings, not only the applier\'s', async () => {
  // A category already holding enough channels that a task channel cannot move
  // in: that warning is the PLANNER's, and only a merged list shows it.
  const category = fakeChannel('cat1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const filler = Array.from({ length: 45 }, (_, i) =>
    fakeChannel(`f${i}`, `filler-${i}`, { parentId: 'cat1' })
  )
  const taskChannel = fakeChannel('tc1', 'feature-0145e3', { parentId: 'OUTSIDE' })
  const db = fakeDb({
    projects: [{ ...PROJECT, discordCategoryId: 'cat1' }],
    tasks: [{ id: 't1', projectId: 'p1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' }],
  })
  const guild = fakeGuild({ channels: [category, ...filler, taskChannel] })
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.match(it.replies[0].content, /category cap/)
})

test('all:true reports a project that throws and still finishes the others', async () => {
  const projects = [
    { id: 'p1', name: 'Alpha', docsSlug: 'alpha', guildConfigId: 'g1' },
    { id: 'p2', name: 'Bravo', docsSlug: 'bravo', guildConfigId: 'g1' },
    { id: 'p3', name: 'Charlie', docsSlug: 'charlie', guildConfigId: 'g1' },
  ]
  const db = fakeDb({ projects })
  db.task.findMany = async ({ where }) => {
    if (where.projectId === 'p2') throw new Error('database went away')
    return []
  }
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { all: true } })

  await quiet(() => execute(it, { db, getConfig }))

  // `all` posts as it goes, so the whole walk is in the LAST reply.
  const content = it.replies.at(-1).content
  assert.match(content, /\*\*Alpha\*\*/)
  assert.match(content, /\*\*Bravo\*\* — failed: database went away/)
  assert.match(content, /\*\*Charlie\*\*/)
  const updated = db.calls.filter((c) => c[0] === 'project.update').map((c) => c[1].where.id)
  assert.deepEqual(updated, ['p1', 'p3'], 'the failing project did not stop the walk')
})

test('all:true with no projects says so without touching the guild', async () => {
  const db = fakeDb({ projects: [] })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { all: true } })
  await execute(it, { db, getConfig })
  assert.match(it.replies[0].content, /No projects/)
  assert.equal(guild.channels.calls.length, 0)
})

test('a reply for many projects stays inside Discord\'s 2000 characters', async () => {
  const projects = Array.from({ length: 30 }, (_, i) => ({
    id: `p${i}`,
    name: `Project Number ${i}`,
    docsSlug: `project-number-${i}`,
    guildConfigId: 'g1',
  }))
  const db = fakeDb({ projects })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { all: true } })

  await quiet(() => execute(it, { db, getConfig }))

  for (const reply of it.replies) {
    assert.ok(reply.content.length <= 2000, `a reply was ${reply.content.length} characters`)
  }
  assert.match(it.replies.at(-1).content, /more not shown/)
})

// --- incompleteness the reply must never print as success -------------------

/** A role already in the guild, with `holders` on it, for the revoke tests. */
function roleWithHolders(id, name, holders) {
  for (const member of holders) member.roles.cache.add(id)
  return { id, name, members: new Map(holders.map((m) => [m.id, m])) }
}

test('a members.fetch() that rejects warns and runs no revoke pass', async () => {
  const stale = fakeMember('u9', 'Stale')
  const joining = fakeMember('u1', 'Aashir')
  const role = roleWithHolders('r1', 'Framework', [stale])
  const db = fakeDb({
    projects: [{ ...PROJECT, discordRoleId: 'r1' }],
    members: [{ projectId: 'p1', discordId: 'u1', role: 'lead' }],
  })
  const guild = fakeGuild({ roles: [role], members: [stale, joining] })
  const bulk = guild.members.fetch
  guild.members.fetch = async (id) => {
    if (id === undefined) throw new Error('Missing Access')
    return bulk(id)
  }
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  // Without the guard the empty member cache reads as "nobody to remove" and
  // the stale holder quietly keeps the project role.
  assert.ok(stale.roles.cache.has('r1'), 'the stale holder kept the role')
  assert.ok(joining.roles.cache.has('r1'), 'granting is still safe, so it still ran')
  const content = it.replies.at(-1).content
  assert.match(content, /member list could not be read \(Missing Access\)/)
  assert.match(content, /nobody was removed from the project role/)
  assert.match(content, /1 granted, nobody removed — see the warning below/)
})

test('a roster read at its 200-row limit warns and runs no revoke pass', async () => {
  const roster = Array.from({ length: 200 }, (_, i) => ({
    projectId: 'p1',
    discordId: `u${i}`,
    role: 'member',
  }))
  const onProject = roster.map((m) => fakeMember(m.discordId, `Member ${m.discordId}`))
  // Row 201 is a real member the read could not reach: absent from `wanted`,
  // so an unguarded sync would strip the role from someone who belongs here.
  const unseen = fakeMember('u200', 'Row 201')
  const role = roleWithHolders('r1', 'Framework', [...onProject, unseen])
  const db = fakeDb({ projects: [{ ...PROJECT, discordRoleId: 'r1' }], members: roster })
  const guild = fakeGuild({ roles: [role], members: [...onProject, unseen] })
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.ok(unseen.roles.cache.has('r1'), 'the member past the limit kept the role')
  const content = it.replies.at(-1).content
  assert.match(content, /Only the first 200 members of "Framework" could be read/)
  assert.match(content, /nobody removed — see the warning below/)
  assert.doesNotMatch(content, /\d+ revoked/)
})

test('a task read at its 500-row limit says only the newest were considered', async () => {
  const tasks = Array.from({ length: 500 }, (_, i) => ({
    id: `t${i}`,
    projectId: 'p1',
    title: `Task ${i}`,
    type: 'feature',
  }))
  const db = fakeDb({ projects: [PROJECT], tasks })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.match(it.replies.at(-1).content, /Only the newest 500 task channels for "Framework" were read/)
})

test('a preview says the same thing about a task read at its limit', async () => {
  const tasks = Array.from({ length: 500 }, (_, i) => ({
    id: `t${i}`,
    projectId: 'p1',
    title: `Task ${i}`,
    type: 'feature',
  }))
  const db = fakeDb({ projects: [PROJECT], tasks })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { project: 'p1', preview: true } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.match(it.replies.at(-1).content, /Only the newest 500 task channels/)
})

test('renderResult says nothing was synced when the role was never created', () => {
  const out = renderResult(
    { name: 'Framework' },
    {
      role: null,
      created: ['a'],
      warnings: ['role "Framework": Missing Permissions'],
      roleSync: { granted: [], revoked: [], failed: [] },
    }
  )
  assert.match(out, /Role — not created, nothing was synced\./)
  assert.doesNotMatch(out, /nobody to add or remove/)
})

test('renderResult caps the per-member role-sync failures the way it caps warnings', () => {
  const failed = Array.from({ length: 9 }, (_, i) => `u${i} (Missing Permissions)`)
  const out = renderResult(
    { name: 'Framework' },
    { role: { id: 'r1', name: 'Framework' }, created: ['a'], roleSync: { granted: [], revoked: [], failed } }
  )
  assert.equal(out.split('\n').filter((l) => l.startsWith('⚠ role sync: u')).length, 5)
  assert.match(out, /⚠ role sync: …and 4 more member\(s\) could not be changed\./)
})

// --- the reply never hides that it is truncated -----------------------------

test('one oversized project still reports that the others ran', async () => {
  const projects = [
    { id: 'p1', name: 'H'.repeat(2100), docsSlug: 'huge', guildConfigId: 'g1' },
    { id: 'p2', name: 'Bravo', docsSlug: 'bravo', guildConfigId: 'g1' },
    { id: 'p3', name: 'Charlie', docsSlug: 'charlie', guildConfigId: 'g1' },
  ]
  const db = fakeDb({ projects })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { all: true } })

  await quiet(() => execute(it, { db, getConfig }))

  const content = it.replies.at(-1).content
  assert.ok(content.length <= 2000, `reply was ${content.length} characters`)
  assert.match(content, /… and 2 more not shown/)
  const updated = db.calls.filter((c) => c[0] === 'project.update').map((c) => c[1].where.id)
  assert.deepEqual(updated, ['p1', 'p2', 'p3'], 'the later projects still ran')
})

test('truncating an oversized block never splits a surrogate pair', async () => {
  // '📂' sits astride the cut: `**` + 1996 characters puts its high surrogate
  // at the last index the slice would keep.
  const name = `${'A'.repeat(1996)}📂`
  const db = fakeDb({ projects: [{ id: 'p1', name, docsSlug: 'huge', guildConfigId: 'g1' }] })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  const content = it.replies.at(-1).content
  assert.ok(content.length <= 2000, `reply was ${content.length} characters`)
  const lone = [...content].filter((ch) => {
    const code = ch.codePointAt(0)
    return code >= 0xd800 && code <= 0xdfff
  })
  assert.deepEqual(lone, [], 'no half of a surrogate pair survived the cut')
})

test('all:true posts the reply as it goes, once per project, always within the cap', async () => {
  const projects = [
    { id: 'p1', name: 'Alpha', docsSlug: 'alpha', guildConfigId: 'g1' },
    { id: 'p2', name: 'Bravo', docsSlug: 'bravo', guildConfigId: 'g1' },
    { id: 'p3', name: 'Charlie', docsSlug: 'charlie', guildConfigId: 'g1' },
  ]
  const db = fakeDb({ projects })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { all: true } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.equal(it.replies.length, 3, 'one edit per project, and no redundant terminal edit')
  for (const reply of it.replies) {
    assert.ok(reply.content.length <= 2000, `a reply was ${reply.content.length} characters`)
  }
  assert.match(it.replies[0].content, /\*\*Alpha\*\*/)
  assert.doesNotMatch(it.replies[0].content, /\*\*Bravo\*\*/)
  assert.match(it.replies.at(-1).content, /\*\*Charlie\*\*/)
})

test('all:true keeps walking when an editReply fails mid-run', async () => {
  const projects = [
    { id: 'p1', name: 'Alpha', docsSlug: 'alpha', guildConfigId: 'g1' },
    { id: 'p2', name: 'Bravo', docsSlug: 'bravo', guildConfigId: 'g1' },
  ]
  const db = fakeDb({ projects })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { all: true } })
  it.editReply = async () => {
    throw new Error('Unknown Webhook')
  }

  await quiet(() => execute(it, { db, getConfig }))

  const updated = db.calls.filter((c) => c[0] === 'project.update').map((c) => c[1].where.id)
  assert.deepEqual(updated, ['p1', 'p2'], 'a dead token loses the reply, not the walk')
})

test('project: together with all:true says the project was ignored', async () => {
  const projects = [
    { id: 'p1', name: 'Alpha', docsSlug: 'alpha', guildConfigId: 'g1' },
    { id: 'p2', name: 'Bravo', docsSlug: 'bravo', guildConfigId: 'g1' },
  ]
  const db = fakeDb({ projects })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { all: true, project: 'p2' } })

  await quiet(() => execute(it, { db, getConfig }))

  const content = it.replies.at(-1).content
  assert.match(content, /\*\*all:true\*\* was set, so the \*\*project:\*\* you picked was ignored/)
  assert.match(content, /\*\*Alpha\*\*/)
  assert.match(content, /\*\*Bravo\*\*/)
})

// --- autocomplete -----------------------------------------------------------

test('autocomplete offers this guild\'s projects and never a detach entry', async () => {
  const db = fakeDb({ projects: [PROJECT, { id: 'p2', name: 'Bravo', guildConfigId: 'g1' }] })
  const it = fakeInteraction({ guild: fakeGuild(), opts: { focused: '' } })
  await autocomplete(it, { db, getConfig })
  assert.deepEqual(it.responses[0], [
    { name: 'Bravo', value: 'p2' },
    { name: 'Framework', value: 'p1' },
  ])
})

// ---------------------------------------------------------------------------
// The role rules end to end: who can see what, and who keeps their role
// ---------------------------------------------------------------------------

/** A guild role a human made, with `permissions` so the subset test can read it. */
function guildRole(id, name, holders = [], over = {}) {
  for (const member of holders) member.roles.cache.add(id)
  return { id, name, permissions: 0n, managed: false, members: new Map(holders.map((m) => [m.id, m])), ...over }
}

/** A task channel as /create-task makes it: @everyone denied, its assignee allowed. */
function ticket(id, name, parentId, overwriteIds = ['G1', 'assignee']) {
  const ch = fakeChannel(id, name, { parentId })
  ch.topic = 'Feature: Git Sync | Assigner + assignees'
  ch.permissionOverwrites = {
    cache: new Map(overwriteIds.map((i) => [i, { id: i, type: OverwriteType.Role, allow: 0n, deny: 0n }])),
  }
  return ch
}

test('adopt_role is an optional boolean beside the other three', () => {
  const byName = Object.fromEntries(data.toJSON().options.map((o) => [o.name, o]))
  assert.equal(byName.adopt_role.required ?? false, false)
  assert.equal(byName.adopt_role.type, 5, 'boolean')
})

test('a same-named role held by somebody is refused, and the section is built shut', async () => {
  // The backfill's NORMAL path: legacy roles named after projects, handed out
  // by hand, with only five `projectmember` rows across four of nine projects.
  const holder = fakeMember('u1', 'Aashir')
  const role = guildRole('r9', 'Framework', [holder])
  const db = fakeDb({ projects: [PROJECT] })
  const guild = fakeGuild({ roles: [role], members: [holder] })
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.equal(guild.roles.calls.length, 0, 'no second role of the same name was created either')
  assert.ok(holder.roles.cache.has('r9'), 'and nothing was taken off the holder')
  // Fail closed: @everyone denied, nothing allowed. Nobody but the bot.
  const category = guild.channels.calls[0]
  assert.deepEqual(category.permissionOverwrites, [
    { id: 'G1', type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
  ])
  const content = it.replies.at(-1).content
  assert.match(content, /held by 1 member\(s\)/)
  assert.match(content, /visible to nobody but the bot/)
  assert.match(content, /Rename the project or the role/)
  assert.match(content, /adopt_role:true/)
})

test('a preview reads the member list, so a role two people hold is not called empty', async () => {
  const a = fakeMember('u1', 'Aashir')
  const b = fakeMember('u2', 'Afaq')
  const db = fakeDb({ projects: [PROJECT] })
  const guild = fakeGuild({ roles: [guildRole('r9', 'Framework', [a, b])], members: [a, b] })
  const it = fakeInteraction({ guild, opts: { project: 'p1', preview: true } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.equal(guild.fetchedAll, 1)
  assert.equal(guild.channels.calls.length, 0, 'a preview still changes nothing')
  assert.match(it.replies.at(-1).content, /Role: refused — Role "Framework" already exists and is held by 2 member\(s\)/)
})

test('a member fetch that fails during a PREVIEW refuses adoption rather than guessing', async () => {
  // Unfetched, `role.members` is empty and the role looks free to take. A
  // preview that printed "reuse (nobody holds it)" would be telling the
  // operator the opposite of the truth.
  const holder = fakeMember('u1', 'Aashir')
  const db = fakeDb({ projects: [PROJECT] })
  const guild = fakeGuild({ roles: [guildRole('r9', 'Framework', [holder])], members: [holder] })
  guild.members.fetch = async () => {
    throw new Error('Missing Access')
  }
  const it = fakeInteraction({ guild, opts: { project: 'p1', preview: true } })

  await quiet(() => execute(it, { db, getConfig }))

  const content = it.replies.at(-1).content
  assert.match(content, /Role: refused/)
  assert.match(content, /member list could not be read/)
  assert.doesNotMatch(content, /nobody holds it/)
})

test('preview with adopt_role names everyone who would lose the role and everyone who would gain it', async () => {
  const stale1 = fakeMember('u1', 'Aashir')
  const stale2 = fakeMember('u2', 'Afaq')
  const joining = fakeMember('u3', 'Ada')
  const db = fakeDb({
    projects: [PROJECT],
    members: [{ projectId: 'p1', discordId: 'u3', role: 'lead' }],
  })
  const guild = fakeGuild({
    roles: [guildRole('r9', 'Framework', [stale1, stale2])],
    members: [stale1, stale2, joining],
  })
  const it = fakeInteraction({ guild, opts: { project: 'p1', preview: true, adopt_role: true } })

  await quiet(() => execute(it, { db, getConfig }))

  const content = it.replies.at(-1).content
  assert.match(content, /Role: ADOPTING the existing \*\*Framework\*\* — 2 member\(s\) hold it today/)
  // By display name, before anything happens: nobody can consent to "2 revoked".
  assert.match(content, /2 member\(s\) would LOSE it — Aashir, Afaq/)
  assert.match(content, /1 would gain it — Ada/)
  assert.equal(guild.channels.calls.length, 0, 'and still nothing was changed')
  assert.ok(stale1.roles.cache.has('r9'))
})

test('the preview says that a task channel being moved is also opened to the project role', async () => {
  // "22 to rename and move" reads as housekeeping. What it means is that 22
  // channels visible only to their assignees become visible to everyone
  // holding the project role.
  const category = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskChannel = ticket('tc1', 'feature-0145e3', 'OUTSIDE')
  const db = fakeDb({
    projects: [{ ...PROJECT, discordCategoryId: 'c1', discordRoleId: 'r1' }],
    tasks: [{ id: 't1', projectId: 'p1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' }],
  })
  const guild = fakeGuild({ channels: [category, taskChannel], roles: [guildRole('r1', 'Framework')] })
  const it = fakeInteraction({ guild, opts: { project: 'p1', preview: true } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.match(it.replies.at(-1).content, /Task channels: 1 to rename and move \(and open to the project role\)/)
})

test('a real run says how many channels its renames and moves also opened', async () => {
  const category = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskChannel = ticket('tc1', 'feature-0145e3', 'OUTSIDE')
  const db = fakeDb({
    projects: [{ ...PROJECT, discordCategoryId: 'c1', discordRoleId: 'r1' }],
    tasks: [{ id: 't1', projectId: 'p1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' }],
  })
  const guild = fakeGuild({ channels: [category, taskChannel], roles: [guildRole('r1', 'Framework')] })
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.equal(taskChannel.edits.length, 1, 'still one edit carrying everything')
  assert.ok(taskChannel.edits[0].permissionOverwrites.some((o) => o.id === 'r1'))
  assert.match(it.replies.at(-1).content, /1 of those channel\(s\) were also opened to the project role/)
})

// ---------------------------------------------------------------------------
// A4: never revoke against a roster read before a long apply
// ---------------------------------------------------------------------------

test('somebody added to the project WHILE the section is built is not revoked straight back', async () => {
  // A manager runs `/project-members add` during an `all:true` backfill. The
  // row is written and the role granted, so the member is in `role.members`
  // by the time the sync reads it — but the roster the walk started with
  // predates them, and reads them as "a holder who is no longer a member".
  const joined = fakeMember('u1', 'Aashir')
  const role = guildRole('r1', 'Framework', [joined])
  const db = fakeDb({ projects: [{ ...PROJECT, discordRoleId: 'r1' }] })
  let reads = 0
  db.projectMember.findByProject = async () => {
    reads += 1
    // Read once before the apply, and again immediately before the sync.
    return reads === 1 ? [] : [{ projectId: 'p1', discordId: 'u1', role: 'lead' }]
  }
  const guild = fakeGuild({ roles: [role], members: [joined] })
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.ok(reads >= 2, 'the roster is read again after the apply')
  assert.ok(joined.roles.cache.has('r1'), 'the member the manager just added kept the role')
  const content = it.replies.at(-1).content
  assert.doesNotMatch(content, /revoked/)
  assert.match(content, /members of "Framework" changed while its section was being built/)
})

test('a roster that changed mid-run refreshes the pinned panel with the newer list', async () => {
  const joined = fakeMember('u1', 'Aashir')
  const db = fakeDb({ projects: [PROJECT] })
  let reads = 0
  db.projectMember.findByProject = async () => {
    reads += 1
    return reads === 1 ? [] : [{ projectId: 'p1', discordId: 'u1', role: 'lead' }]
  }
  const guild = fakeGuild({ members: [joined] })
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  const panel = [...guild.channels.cache.values()].find((c) => c.name === 'framework-members')
  assert.equal(panel.sent.length, 2, 'posted with the stale list, then again with the fresh one')
  assert.equal(panel.sent.at(-1).embeds[0].toJSON().fields[0].value, 'Aashir')
})

test('a roster read that fails after the apply skips the revoke pass and says so', async () => {
  const stale = fakeMember('u9', 'Stale')
  const db = fakeDb({ projects: [{ ...PROJECT, discordRoleId: 'r1' }] })
  let reads = 0
  db.projectMember.findByProject = async () => {
    reads += 1
    if (reads > 1) throw new Error('database went away')
    return []
  }
  const guild = fakeGuild({ roles: [guildRole('r1', 'Framework', [stale])], members: [stale] })
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.ok(stale.roles.cache.has('r1'), 'a stale roster must never drive a revoke')
  assert.match(it.replies.at(-1).content, /could not be read again after the section was built/)
})

test('a run that DOES revoke names who lost the role', async () => {
  // "3 revoked" cannot be undone by hand.
  const stale = fakeMember('u9', 'Stale Sam')
  const db = fakeDb({ projects: [{ ...PROJECT, discordRoleId: 'r1' }] })
  const guild = fakeGuild({ roles: [guildRole('r1', 'Framework', [stale])], members: [stale] })
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.ok(!stale.roles.cache.has('r1'))
  const content = it.replies.at(-1).content
  assert.match(content, /1 revoked/)
  assert.match(content, /Removed from the role: Stale Sam\./)
})

// ---------------------------------------------------------------------------
// A6: effective slugs
// ---------------------------------------------------------------------------

test('a project whose EFFECTIVE slug collides with another is refused, and nothing is touched', async () => {
  // The legacy row has a NULL `docsSlug`, so its effective slug is
  // `slugify(name)` — the same ten channel names the new one wants.
  const projects = [
    { id: 'p1', name: 'UBS-Doc', docsSlug: 'ubs-doc', guildConfigId: 'g1' },
    { id: 'p2', name: 'UBS Doc', docsSlug: null, guildConfigId: 'g1' },
  ]
  const db = fakeDb({ projects })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  assert.equal(guild.channels.calls.length, 0, 'nothing was created')
  assert.equal(guild.roles.calls.length, 0)
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.update'), [], 'and nothing was saved')
  const content = it.replies.at(-1).content
  assert.match(content, /refused: its channel slug `ubs-doc` is also used by \*\*UBS Doc\*\*/)
  assert.match(content, /Give one of them a different docs folder/)
})

test('all:true reads the project rows again per project, so a mid-walk category is not adopted twice', async () => {
  // Project A stores its brand-new category id partway through the walk. The
  // list the walk started with does not have it, so only a fresh read stops
  // project B adopting that category by name.
  const projects = [
    { id: 'p1', name: 'Framework', docsSlug: 'framework', guildConfigId: 'g1' },
    { id: 'p2', name: 'framework-two', docsSlug: 'framework-two', guildConfigId: 'g1' },
  ]
  const db = fakeDb({ projects })
  const reads = []
  const findMany = db.project.findMany
  db.project.findMany = async (args) => {
    reads.push(args)
    return findMany(args)
  }
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, opts: { all: true } })

  await quiet(() => execute(it, { db, getConfig }))

  // Once to pick the projects, then once per project before observing it.
  assert.ok(reads.length >= 3, `only ${reads.length} reads of the project rows`)
})

// ---------------------------------------------------------------------------
// B3: the bot needs Administrator to see the sections it builds
// ---------------------------------------------------------------------------

/** A guild whose bot member reports a readable permission set. */
function withBotPermissions(guild, admin) {
  guild.members.me = { permissions: { has: () => admin } }
  return guild
}

test('a bot without Administrator is warned that it will not see the sections it creates', async () => {
  const db = fakeDb({ projects: [PROJECT] })
  const guild = withBotPermissions(fakeGuild(), false)
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })

  await quiet(() => execute(it, { db, getConfig }))

  const content = it.replies.at(-1).content
  assert.match(content, /does not have \*\*Administrator\*\*/)
  assert.match(content, /will not be able to see the private sections/)
  // A warning, never a refusal: the section is still built.
  assert.equal(guild.roles.calls.length, 1, 'the role was still created')
  assert.equal(guild.channels.calls.length, 13, 'the category and its twelve channels were still created')
})

test('a bot WITH Administrator is not warned', async () => {
  const db = fakeDb({ projects: [PROJECT] })
  const guild = withBotPermissions(fakeGuild(), true)
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })
  await quiet(() => execute(it, { db, getConfig }))
  assert.doesNotMatch(it.replies.at(-1).content, /Administrator/)
})

test('permissions that cannot be read are not claimed either way', async () => {
  const db = fakeDb({ projects: [PROJECT] })
  const guild = fakeGuild() // no `members.me` at all
  const it = fakeInteraction({ guild, opts: { project: 'p1' } })
  await quiet(() => execute(it, { db, getConfig }))
  assert.doesNotMatch(it.replies.at(-1).content, /Administrator/)
})

// ---------------------------------------------------------------------------
// B5: `project:` takes an id from autocomplete, so no reply may tell an
// operator to type a project NAME into it.
// ---------------------------------------------------------------------------

test('the truncation tail sends the operator to the option\'s suggestions, not to a typed name', async () => {
  const projects = Array.from({ length: 30 }, (_, i) => ({
    id: `p${i}`,
    name: `Project Number ${i}`,
    docsSlug: `project-number-${i}`,
    guildConfigId: 'g1',
  }))
  const db = fakeDb({ projects })
  const it = fakeInteraction({ guild: fakeGuild(), opts: { all: true } })

  await quiet(() => execute(it, { db, getConfig }))

  const content = it.replies.at(-1).content
  assert.match(content, /more not shown/)
  assert.match(content, /pick each remaining project from the \*\*project:\*\* option's suggestions/)
  assert.doesNotMatch(content, /project:<name>/)
})

// ---------------------------------------------------------------------------
// D6: `capReply` keeps blocks from the front, so the last projects' warnings
// are never posted. They have to survive somewhere.
// ---------------------------------------------------------------------------

test('a planner warning reaches the console even when its block is dropped from the reply', async () => {
  const project = { id: 'p2', name: 'Project Manager', docsSlug: 'project-manager', guildConfigId: 'g1' }
  const db = fakeDb({ projects: [project] })
  const logged = []
  const warn = console.warn
  const error = console.error
  console.warn = (...args) => logged.push(args.join(' '))
  console.error = () => {}
  try {
    await execute(fakeInteraction({ guild: fakeGuild(), opts: { project: 'p2' } }), { db, getConfig })
  } finally {
    console.warn = warn
    console.error = error
  }
  assert.ok(
    logged.some((line) => line.startsWith('[project-setup] Project Manager:') && /managed role/.test(line)),
    logged.join(' | ')
  )
})

test('the preview says which voice channels will change and how, so the run is never a surprise', () => {
  const both = renderPlan({ name: 'Framework' }, { voice: { category: ['UseVAD', 'Stream'], channels: [{ id: 'v1', name: 'a', gaps: ['UseVAD', 'Stream'] }, { id: 'v2', name: 'b', gaps: ['Stream'] }] } })
  assert.match(both, /Preview, nothing was changed/)
  assert.match(both, /Voice: 3 voice channel\(s\) \(and the category\) will let the project role use voice activity and screen sharing/)
  const one = renderPlan({ name: 'Framework' }, { voice: { category: [], channels: [{ id: 'v1', name: 'a', gaps: ['Stream'] }] } })
  assert.match(one, /Voice: 1 voice channel\(s\) will let the project role use screen sharing/)
  assert.doesNotMatch(one, /voice activity/)
  assert.doesNotMatch(renderPlan({ name: 'Framework' }, { voice: { category: [], channels: [] } }), /Voice:/)
})

test('a run reports how many places got the voice permissions, and says nothing when there were none', () => {
  assert.match(renderResult({ name: 'Framework' }, { voiceFixed: ['a', 'b'] }), /Voice activity and screen sharing turned on for the project role in 2 place\(s\)/)
  assert.doesNotMatch(renderResult({ name: 'Framework' }, { voiceFixed: [] }), /Voice activity/)
  assert.equal(renderResult({ name: 'Framework' }, {}), '**Framework** — nothing to change.')
})

test('the role-sync roster never contains a client row; clientIdsOf is the complement', () => {
  const rows = [{ discordId: 'a', role: 'lead' }, { discordId: 'c', role: 'client' }, { discordId: 'b', role: 'qa' }]
  assert.deepEqual(staffOnly(rows).map((m) => m.discordId), ['a', 'b'])
  assert.deepEqual(clientIdsOf(rows), ['c'])
  assert.deepEqual(staffOnly(null), [])
})
