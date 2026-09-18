import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType } from 'discord.js'
import {
  data,
  execute,
  autocomplete,
  renderPlan,
  renderResult,
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
  assert.equal(guild.fetchedAll, 0, 'a preview does not need the member list')
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.update'), [], 'nothing was saved')
  const content = it.replies[0].content
  assert.match(content, /Preview/)
  assert.match(content, /Role: create \*\*Framework\*\*/)
  assert.match(content, /Category: create \*\*📂 FRAMEWORK\*\*/)
  assert.match(content, /Channels: 9 to create/)
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
  // One category plus the ten section channels.
  assert.equal(guild.channels.calls.length, 11)
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
  assert.match(content, /\*\*Framework\*\*/)
  assert.match(content, /11 created/)
  assert.match(content, /1 task channel/)
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

  const content = it.replies[0].content
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

  const content = it.replies[0].content
  assert.ok(content.length <= 2000, `reply was ${content.length} characters`)
  assert.match(content, /more not shown/)
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
