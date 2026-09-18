import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import {
  planProjectSection,
  projectFromChannel,
  SECTIONS,
  categoryNameFor,
  channelNameFor,
  observeProjectSection,
  applyProjectSection,
  syncProjectRoleMembers,
} from './projectSection.js'

const project = { id: 'p1', name: 'Framework', docsSlug: 'framework' }
const empty = { roleId: null, roleNames: new Map(), categoryId: null, categoryName: null, categoryChannelCount: 0, channels: {}, tasks: [], takenNames: new Set() }

test('names follow the spec', () => {
  assert.equal(categoryNameFor(project), '📂 FRAMEWORK')
  assert.equal(channelNameFor(project, 'frontend-chat'), 'framework-frontend-chat')
  assert.equal(SECTIONS.length, 10)
  assert.deepEqual(SECTIONS.map((s) => s.key).slice(0, 3), ['members', 'documentation', 'meetings'])
})

test('the section table matches the constraints, suffix and type', () => {
  assert.deepEqual(
    SECTIONS.map((s) => [s.key, s.suffix, s.type]),
    [
      ['members', 'members', 'text'],
      ['documentation', 'documentation', 'text'],
      ['meetings', 'meetings', 'text'],
      ['meetingVoice', 'meeting-voice', 'voice'],
      ['frontendChat', 'frontend-chat', 'text'],
      ['frontendVoice', 'frontend-voice', 'voice'],
      ['backendChat', 'backend-chat', 'text'],
      ['backendVoice', 'backend-voice', 'voice'],
      ['databaseChat', 'database-chat', 'text'],
      ['databaseVoice', 'database-voice', 'voice'],
    ]
  )
})

test('a long slug is truncated, the suffix never is, and no hyphen is left dangling', () => {
  const long = { id: 'p3', name: 'Long', docsSlug: 'a'.repeat(120) }
  for (const s of SECTIONS) {
    const name = channelNameFor(long, s.suffix)
    assert.equal(name.length, 100)
    assert.ok(name.endsWith(`-${s.suffix}`), `${name} lost its suffix`)
  }
  // A slug whose cut lands on a hyphen must not produce 'slug--suffix'.
  // 'members' leaves 92 characters for the slug, and character 92 here is the hyphen.
  const hyphen = { id: 'p4', name: 'Hyphen', docsSlug: `${'a'.repeat(91)}-${'b'.repeat(20)}` }
  assert.equal(channelNameFor(hyphen, 'members'), `${'a'.repeat(91)}-members`)
})

test('a fresh project creates the role, the category and all ten channels', () => {
  const plan = planProjectSection(project, empty)
  assert.equal(plan.role.action, 'create')
  assert.equal(plan.role.name, 'Framework')
  assert.equal(plan.category.action, 'create')
  assert.equal(plan.channels.length, 10)
  assert.ok(plan.channels.every((c) => c.action === 'create'))
  assert.equal(plan.warnings.length, 0)
})

test('an existing role of the same name is reused, not created again', () => {
  const plan = planProjectSection(project, { ...empty, roleNames: new Map([['Framework', 'r9']]) })
  assert.deepEqual([plan.role.action, plan.role.id], ['reuse', 'r9'])
})

test('a project named after a job role is refused a role, with a reason', () => {
  const plan = planProjectSection({ id: 'p2', name: 'Database', docsSlug: 'database' }, empty)
  assert.equal(plan.role.action, 'refuse')
  assert.match(plan.role.reason, /managed role/i)
  assert.ok(plan.warnings.some((w) => /Database/.test(w)))
})

test('a category renamed by hand is renamed back, found by id', () => {
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: 'old name' })
  assert.deepEqual([plan.category.action, plan.category.id, plan.category.name], ['rename', 'c1', '📂 FRAMEWORK'])
})

test('everything already correct plans nothing', () => {
  const channels = {}
  for (const s of SECTIONS) channels[s.key] = { id: `id-${s.key}`, name: channelNameFor(project, s.suffix), parentId: 'c1' }
  const plan = planProjectSection(project, { ...empty, roleId: 'r1', categoryId: 'c1', categoryName: '📂 FRAMEWORK', channels })
  assert.equal(plan.category.action, 'reuse')
  assert.ok(plan.channels.every((c) => c.action === 'reuse'))
})

test('a section channel in the wrong category is moved, a misnamed one renamed', () => {
  const channels = { members: { id: 'm1', name: 'framework-members', parentId: 'OTHER' },
                     documentation: { id: 'd1', name: 'wrong-name', parentId: 'c1' } }
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', channels })
  const byKey = Object.fromEntries(plan.channels.map((c) => [c.key, c]))
  assert.equal(byKey.members.action, 'move')
  assert.equal(byKey.documentation.action, 'rename')
  assert.equal(byKey.meetings.action, 'create')
})

test('a task outside its project is moved and renamed in one action', () => {
  const tasks = [{ id: 'tA1b2c3d4e5f6', title: 'Git Sync', type: 'feature', channelId: 'ch1', channelName: 'feature-0145e3', parentId: 'FEATURES' }]
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', tasks })
  assert.deepEqual(plan.tasks, [{ taskId: 'tA1b2c3d4e5f6', channelId: 'ch1', action: 'both', name: 'feature-git-sync' }])
})

test('a task already right plans none', () => {
  const tasks = [{ id: 't1', title: 'Git Sync', type: 'feature', channelId: 'ch1', channelName: 'feature-git-sync', parentId: 'c1' }]
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', tasks })
  assert.equal(plan.tasks[0].action, 'none')
})

test('two tasks with the same title never share a channel name', () => {
  // Both already exist and one of them already carries the name the other wants.
  // Freeing a task's own name must not free a name an earlier task was given.
  const tasks = [
    { id: 'aaaa1111bbbb2222', title: 'Git Sync', type: 'feature', channelId: 'ch1', channelName: 'feature-0145e3', parentId: 'c1' },
    { id: 'cccc3333dddd4444', title: 'Git Sync', type: 'feature', channelId: 'ch2', channelName: 'feature-git-sync', parentId: 'c1' },
  ]
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', tasks })
  const names = plan.tasks.map((t) => t.name)
  assert.equal(names[0], 'feature-git-sync')
  assert.equal(new Set(names).size, 2, `two channels would share a name: ${names.join(', ')}`)
})

test('a task keeps the name it already carries, even when the snapshot lists it as taken', () => {
  const tasks = [{ id: 't1', title: 'Git Sync', type: 'feature', channelId: 'ch1', channelName: 'feature-git-sync', parentId: 'c1' }]
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', tasks, takenNames: new Set(['feature-git-sync']) })
  assert.deepEqual([plan.tasks[0].action, plan.tasks[0].name], ['none', 'feature-git-sync'])
})

test('a task cannot take the name of a section channel this plan creates', () => {
  const slugged = { id: 'p5', name: 'Feature', docsSlug: 'feature' }
  const tasks = [{ id: 'abcd1234ef567890', title: 'Members', type: 'feature', channelId: 'ch1', channelName: 'feature-0145e3', parentId: 'FEATURES' }]
  const plan = planProjectSection(slugged, { ...empty, categoryId: 'c1', categoryName: '📂 FEATURE', tasks })
  assert.ok(plan.channels.some((c) => c.name === 'feature-members' && c.action === 'create'))
  assert.notEqual(plan.tasks[0].name, 'feature-members')
})

test('section channels moved into the category count against the cap, like created ones', () => {
  const channels = {}
  for (const s of SECTIONS) channels[s.key] = { id: `id-${s.key}`, name: channelNameFor(project, s.suffix), parentId: 'ELSEWHERE' }
  const tasks = Array.from({ length: 40 }, (_, i) => ({
    id: `t${String(i).padStart(4, '0')}abcdefgh`,
    title: `Task ${i}`,
    type: 'feature',
    channelId: `ch${i}`,
    channelName: `feature-old-${i}`,
    parentId: 'FEATURES',
  }))
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', channels, tasks })
  assert.ok(plan.channels.every((c) => c.action === 'move'))
  // 49 - 0 already in the category - 10 sections arriving = 39, not 49.
  assert.equal(plan.tasks.filter((t) => t.action === 'both').length, 39)
  assert.equal(plan.tasks.filter((t) => t.action === 'rename').length, 1)
  assert.ok(plan.warnings.some((w) => /full|cap/i.test(w)))
})

test('past the category cap, task moves are dropped with a warning; sections still plan', () => {
  const tasks = [{ id: 't1', title: 'Git Sync', type: 'feature', channelId: 'ch1', channelName: 'feature-0145e3', parentId: 'FEATURES' }]
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', categoryChannelCount: 49, tasks })
  assert.equal(plan.tasks[0].action, 'rename')
  assert.ok(plan.warnings.some((w) => /full|cap/i.test(w)))
})

test('projectFromChannel matches a channel by its parent category', () => {
  const projects = [{ id: 'p1', name: 'Framework', discordCategoryId: 'c1' }, { id: 'p2', name: 'Badar', discordCategoryId: 'c2' }]
  assert.equal(projectFromChannel(projects, { id: 'ch9', parentId: 'c2' }).id, 'p2')
})

test('projectFromChannel matches the category channel itself', () => {
  const projects = [{ id: 'p1', name: 'Framework', discordCategoryId: 'c1' }]
  assert.equal(projectFromChannel(projects, { id: 'c1', parentId: null }).id, 'p1')
})

test('projectFromChannel is null for anything else', () => {
  const projects = [{ id: 'p1', name: 'Framework', discordCategoryId: 'c1' }]
  assert.equal(projectFromChannel(projects, { id: 'ch9', parentId: 'OTHER' }), null)
  assert.equal(projectFromChannel(projects, null), null)
  assert.equal(projectFromChannel([], { id: 'ch9', parentId: 'c1' }), null)
  assert.equal(projectFromChannel([{ id: 'p3', name: 'No section', discordCategoryId: null }], { id: 'ch9', parentId: null }), null)
})

// ---------------------------------------------------------------------------
// The applier: observeProjectSection / applyProjectSection / syncProjectRoleMembers
// ---------------------------------------------------------------------------

/** A stand-in Discord channel that records every `edit` and every `send`. */
function fakeChannel(id, name, opts = {}) {
  const { type = ChannelType.GuildText, parentId = null, fail = null, overwriteIds = null, overwrites = null } = opts
  const c = { id, name, type, parentId, edits: [], sent: [], messages: { fetchPinned: async () => new Map() } }
  c.edit = async (o) => {
    c.edits.push(o)
    if (fail) throw new Error(fail)
    if (o.name !== undefined) c.name = o.name
    if (o.parent !== undefined) c.parentId = o.parent
    return c
  }
  c.send = async (payload) => {
    c.sent.push(payload)
    return { id: `msg-${c.sent.length}`, pin: async () => true }
  }
  // `overwrites` carries whole entries (type/allow/deny), `overwriteIds` only ids.
  if (overwrites) c.permissionOverwrites = { cache: new Map(overwrites.map((o) => [o.id, o])) }
  else if (overwriteIds) c.permissionOverwrites = { cache: new Map(overwriteIds.map((i) => [i, { id: i }])) }
  return c
}

function fakeGuild({ channels = [], roles = [], createFails = null } = {}) {
  const guild = {
    id: 'G1',
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
        if (createFails && createFails(opts)) throw new Error('Missing Permissions')
        const made = fakeChannel(`new-${guild.channels.calls.length}`, opts.name, {
          type: opts.type,
          parentId: opts.parent ?? null,
        })
        guild.channels.cache.set(made.id, made)
        return made
      },
    },
  }
  return guild
}

function fakeDb() {
  const calls = []
  return { calls, project: { update: async (args) => { calls.push(args); return { id: args?.where?.id } } } }
}

/** Run something that is expected to log a warning, without spraying the test output. */
async function quiet(fn) {
  const real = console.warn
  console.warn = () => {}
  try { return await fn() } finally { console.warn = real }
}

// --- observeProjectSection --------------------------------------------------

test('observeProjectSection resolves the stored ids and takes names from the whole guild', () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const mem = fakeChannel('m1', 'framework-members', { parentId: 'c1' })
  const taskCh = fakeChannel('tc1', 'feature-0145e3', { parentId: 'FEATURES' })
  const other = fakeChannel('o1', 'general')
  const guild = fakeGuild({ channels: [cat, mem, taskCh, other], roles: [{ id: 'r1', name: 'Framework' }] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1', discordChannels: { members: 'm1' } }

  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' },
    { id: 't2', title: 'No channel', type: 'feature', discordChannelId: null },
  ])

  assert.equal(observed.roleId, 'r1')
  assert.equal(observed.roleNames.get('Framework'), 'r1')
  assert.equal(observed.categoryId, 'c1')
  assert.equal(observed.categoryName, '📂 FRAMEWORK')
  assert.equal(observed.categoryChannelCount, 1)
  assert.deepEqual(observed.channels.members, { id: 'm1', name: 'framework-members', parentId: 'c1' })
  assert.equal(observed.channels.documentation, undefined)
  assert.deepEqual(observed.tasks, [
    { id: 't1', title: 'Git Sync', type: 'feature', channelId: 'tc1', channelName: 'feature-0145e3', parentId: 'FEATURES' },
  ])
  assert.ok(observed.takenNames.has('general'))
  assert.ok(observed.takenNames.has('framework-members'))
})

test('observeProjectSection falls back to a name match only when a stored id no longer resolves', () => {
  const cat = fakeChannel('c2', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const mem = fakeChannel('m2', 'framework-members', { parentId: 'c2' })
  const guild = fakeGuild({ channels: [cat, mem] })
  const stored = { ...project, discordCategoryId: 'GONE', discordRoleId: 'GONE', discordChannels: '{"members":"GONE"}' }

  const observed = observeProjectSection(guild, stored, [])

  assert.equal(observed.roleId, null)
  assert.equal(observed.categoryId, 'c2')
  assert.equal(observed.channels.members.id, 'm2')
})

// --- applyProjectSection ----------------------------------------------------

test('a fresh section creates the role, the category with its two overwrites, and ten inheriting channels', async () => {
  const guild = fakeGuild()
  const db = fakeDb()
  const plan = planProjectSection(project, empty)

  const out = await applyProjectSection(guild, project, plan, { db })

  assert.equal(guild.roles.calls.length, 1)
  assert.equal(guild.roles.calls[0].name, 'Framework')

  const [catCall, ...chCalls] = guild.channels.calls
  assert.equal(catCall.name, '📂 FRAMEWORK')
  assert.equal(catCall.type, ChannelType.GuildCategory)
  assert.equal(catCall.permissionOverwrites.length, 2)
  assert.deepEqual(catCall.permissionOverwrites[0], {
    id: 'G1',
    type: OverwriteType.Role,
    deny: [PermissionFlagsBits.ViewChannel],
  })
  assert.deepEqual(catCall.permissionOverwrites[1], {
    id: 'role-1',
    type: OverwriteType.Role,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
    ],
  })

  assert.equal(chCalls.length, 10)
  assert.ok(chCalls.every((c) => c.parent === 'new-1'), 'every section channel sits in the new category')
  assert.ok(chCalls.every((c) => c.permissionOverwrites === undefined), 'section channels inherit')
  assert.equal(chCalls[0].name, 'framework-members')
  assert.equal(chCalls[0].type, ChannelType.GuildText)
  assert.equal(chCalls[3].name, 'framework-meeting-voice')
  assert.equal(chCalls[3].type, ChannelType.GuildVoice)
  assert.equal(out.created.length, 11)
  assert.equal(out.warnings.length, 0)
  assert.equal(out.category.id, 'new-1')
  assert.equal(out.role.id, 'role-1')
})

test('a section channel with the wrong name AND the wrong parent gets exactly one edit carrying both', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const mem = fakeChannel('m1', 'old-members-channel', { parentId: 'ELSEWHERE' })
  const guild = fakeGuild({ channels: [cat, mem] })
  const stored = { ...project, discordCategoryId: 'c1', discordChannels: { members: 'm1' } }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, []))

  const out = await applyProjectSection(guild, stored, plan, { db: fakeDb() })

  assert.equal(mem.edits.length, 1, 'one edit, not a rename plus a move')
  assert.deepEqual(mem.edits[0], { name: 'framework-members', parent: 'c1' })
  assert.ok(out.moved.includes('framework-members'))
})

test('a task channel needing a rename and a move gets exactly one edit carrying both', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskCh = fakeChannel('tc1', 'feature-0145e3', { parentId: 'FEATURES' })
  const guild = fakeGuild({ channels: [cat, taskCh] })
  const stored = { ...project, discordCategoryId: 'c1' }
  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' },
  ])
  const plan = planProjectSection(stored, observed)
  assert.equal(plan.tasks[0].action, 'both')

  const out = await applyProjectSection(guild, stored, plan, { db: fakeDb() })

  assert.equal(taskCh.edits.length, 1)
  assert.deepEqual(taskCh.edits[0], { name: 'feature-git-sync', parent: 'c1' })
  assert.equal(out.tasks, 1)
})

test('a task left behind by the category cap is renamed where it stands, never moved', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskCh = fakeChannel('tc1', 'feature-0145e3', { parentId: 'FEATURES' })
  const guild = fakeGuild({ channels: [cat, taskCh] })
  const plan = {
    role: { action: 'reuse', id: 'r1', name: 'Framework' },
    category: { action: 'reuse', id: 'c1', name: '📂 FRAMEWORK' },
    channels: [],
    tasks: [{ taskId: 't1', channelId: 'tc1', action: 'rename', name: 'feature-git-sync' }],
    warnings: [],
  }

  await applyProjectSection(guild, project, plan, { db: fakeDb() })

  assert.equal(taskCh.edits.length, 1)
  assert.deepEqual(taskCh.edits[0], { name: 'feature-git-sync', parent: 'FEATURES' })
})

test('a Discord error on one channel becomes a warning and the rest of the run continues', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const mem = fakeChannel('m1', 'wrong', { parentId: 'ELSEWHERE', fail: 'Missing Permissions' })
  const guild = fakeGuild({ channels: [cat, mem] })
  const db = fakeDb()
  const stored = { ...project, discordCategoryId: 'c1', discordChannels: { members: 'm1' } }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, []))

  const out = await quiet(() => applyProjectSection(guild, stored, plan, { db }))

  assert.ok(out.warnings.some((w) => /Missing Permissions/.test(w)), out.warnings.join(' | '))
  assert.equal(guild.channels.calls.length, 9, 'the other nine section channels were still created')
  assert.equal(db.calls.length, 1)
  assert.equal(db.calls[0].data.discordChannels.members, 'm1', 'the id it already had is still recorded')
})

test('applyProjectSection persists the three columns in ONE update, keeping what already existed', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const doc = fakeChannel('d1', 'framework-documentation', { parentId: 'c1' })
  const guild = fakeGuild({ channels: [cat, doc] })
  const db = fakeDb()
  const stored = { ...project, discordCategoryId: 'c1', discordChannels: { documentation: 'd1' } }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, []))

  await applyProjectSection(guild, stored, plan, { db })

  assert.equal(db.calls.length, 1)
  assert.equal(db.calls[0].where.id, 'p1')
  const data = db.calls[0].data
  assert.deepEqual(Object.keys(data).sort(), ['discordCategoryId', 'discordChannels', 'discordRoleId'])
  assert.equal(data.discordCategoryId, 'c1')
  assert.equal(data.discordRoleId, 'role-1')
  assert.equal(data.discordChannels.documentation, 'd1')
  assert.equal(Object.keys(data.discordChannels).length, 10)
})

test('a refused role with no role to fall back on leaves the category open, and is warned about once', async () => {
  const dbProject = { id: 'p2', name: 'Database', docsSlug: 'database' }
  const guild = fakeGuild()
  const plan = planProjectSection(dbProject, empty)
  assert.equal(plan.role.action, 'refuse')

  const out = await applyProjectSection(guild, dbProject, plan, { db: fakeDb() })

  assert.equal(guild.roles.calls.length, 0, 'no role is created for a managed name')
  assert.equal(out.role, null)
  const catCall = guild.channels.calls[0]
  assert.equal(catCall.type, ChannelType.GuildCategory)
  assert.deepEqual(catCall.permissionOverwrites, [], 'no @everyone deny, or nobody could see it')
  // The planner already said it, in words that tell the operator what to do
  // about it. The applier restating it would burn a second of the five warning
  // slots a caller shows for nothing.
  const planned = plan.warnings.filter((w) => /managed role/i.test(w))
  assert.equal(planned.length, 1, plan.warnings.join(' | '))
  assert.deepEqual(
    out.warnings.filter((w) => /managed role/i.test(w)),
    [],
    out.warnings.join(' | ')
  )
})

test('a refused role whose project still has a real role keeps that role on the category', async () => {
  const renamed = { id: 'p2', name: 'Database', docsSlug: 'database', discordRoleId: 'r7' }
  const guild = fakeGuild({ roles: [{ id: 'r7', name: 'Aurora', members: new Map() }] })
  const plan = planProjectSection(renamed, empty)
  assert.equal(plan.role.action, 'refuse')

  const out = await applyProjectSection(guild, renamed, plan, { db: fakeDb() })

  assert.equal(guild.roles.calls.length, 0)
  assert.equal(out.role.id, 'r7')
  const overwrites = guild.channels.calls[0].permissionOverwrites
  assert.equal(overwrites.length, 2)
  assert.deepEqual(overwrites[0], { id: 'G1', type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] })
  assert.equal(overwrites[1].id, 'r7')
  assert.ok(out.warnings.some((w) => /managed role/i.test(w)), out.warnings.join(' | '))
})

test('a role that FAILED to be created still leaves the category private', async () => {
  const guild = fakeGuild()
  guild.roles.create = async () => { throw new Error('Missing Permissions') }
  const plan = planProjectSection(project, empty)

  const out = await quiet(() => applyProjectSection(guild, project, plan, { db: fakeDb() }))

  assert.equal(out.role, null)
  // Not a refusal — a rerun will make the role — so the section stays shut in
  // the meantime rather than opening to the whole server.
  assert.deepEqual(guild.channels.calls[0].permissionOverwrites, [
    { id: 'G1', type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
  ])
  assert.ok(out.warnings.some((w) => /Missing Permissions/.test(w)))
})

test('with no category, nothing is created or moved out from under its old parent', async () => {
  const guild = fakeGuild({ createFails: (o) => o.type === ChannelType.GuildCategory })
  const plan = planProjectSection(project, empty)

  const out = await quiet(() => applyProjectSection(guild, project, plan, { db: fakeDb() }))

  assert.equal(guild.channels.calls.length, 1, 'only the failed category create was attempted')
  assert.equal(out.created.length, 0)
  assert.equal(out.category, null)
  assert.ok(out.warnings.some((w) => /categor/i.test(w)), out.warnings.join(' | '))
})

test('the applier posts the members panel once the members channel exists', async () => {
  const guild = fakeGuild()
  const plan = planProjectSection(project, empty)

  await applyProjectSection(guild, project, plan, {
    db: fakeDb(),
    members: [{ discordId: 'u1', role: 'lead' }],
    nameFor: () => 'Ada',
    botUserId: 'bot',
  })

  const membersChannel = guild.channels.cache.get('new-2')
  assert.equal(membersChannel.name, 'framework-members')
  assert.equal(membersChannel.sent.length, 1)
  assert.match(membersChannel.sent[0].embeds[0].data.title, /Framework/)
})

test('a members panel failure is a warning at worst, never a throw', async () => {
  const guild = fakeGuild()
  guild.channels.create = async (opts) => {
    guild.channels.calls.push(opts)
    const made = fakeChannel(`new-${guild.channels.calls.length}`, opts.name, { type: opts.type, parentId: opts.parent ?? null })
    made.messages = { fetchPinned: async () => { throw new Error('Missing Access') } }
    guild.channels.cache.set(made.id, made)
    return made
  }
  const plan = planProjectSection(project, empty)

  // `members: []` because the panel step only runs for a caller that brought a
  // roster — without it this test would pass by never reaching the panel.
  const out = await quiet(() => applyProjectSection(guild, project, plan, { db: fakeDb(), members: [] }))

  assert.equal(out.created.length, 11)
  assert.equal(out.tasks, 0)
})

test('repairing an adopted category MERGES its overwrites, in one edit, keeping a hand-added one', async () => {
  // Discord replaces the whole overwrite array, so a member grant someone added
  // by hand must be carried through or the repair silently revokes it.
  const byHand = { id: 'u9', type: OverwriteType.Member, allow: 'ALLOW-BITS', deny: 'DENY-BITS' }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwrites: [byHand] })
  const guild = fakeGuild({ channels: [cat], roles: [{ id: 'r1', name: 'Framework', members: new Map() }] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, []))
  assert.equal(plan.category.action, 'reuse')

  await applyProjectSection(guild, stored, plan, { db: fakeDb() })

  assert.equal(cat.edits.length, 1, 'two channel edits per ten minutes — never split this')
  const sent = cat.edits[0].permissionOverwrites
  assert.deepEqual(
    sent.find((o) => o.id === 'u9'),
    byHand,
    'the hand-added overwrite is passed through untouched'
  )
  assert.deepEqual(sent.find((o) => o.id === 'G1'), {
    id: 'G1',
    type: OverwriteType.Role,
    deny: [PermissionFlagsBits.ViewChannel],
  })
  assert.deepEqual(sent.find((o) => o.id === 'r1'), {
    id: 'r1',
    type: OverwriteType.Role,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
    ],
  })
  assert.equal(sent.length, 3)
})

test('a category that lost its @everyone deny gets it back, role overwrite or not', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['r1'] })
  const guild = fakeGuild({ channels: [cat], roles: [{ id: 'r1', name: 'Framework', members: new Map() }] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, []))

  await applyProjectSection(guild, stored, plan, { db: fakeDb() })

  assert.equal(cat.edits.length, 1)
  assert.deepEqual(cat.edits[0].permissionOverwrites.find((o) => o.id === 'G1'), {
    id: 'G1',
    type: OverwriteType.Role,
    deny: [PermissionFlagsBits.ViewChannel],
  })
})

test('a category already holding both required overwrites is not edited at all', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const guild = fakeGuild({ channels: [cat], roles: [{ id: 'r1', name: 'Framework', members: new Map() }] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, []))

  await applyProjectSection(guild, stored, plan, { db: fakeDb() })

  assert.equal(cat.edits.length, 0)
})

test('omitting `members` leaves the pinned panel alone; `[]` still says "no members yet"', async () => {
  const bare = fakeGuild()
  const plan = planProjectSection(project, empty)

  await applyProjectSection(bare, project, plan, { db: fakeDb() })

  const untouched = bare.channels.cache.get('new-2')
  assert.equal(untouched.name, 'framework-members')
  assert.equal(untouched.sent.length, 0, 'no roster was passed, so the panel is not rewritten')
  assert.equal(untouched.edits.length, 0)

  const withRoster = fakeGuild()
  await applyProjectSection(withRoster, project, planProjectSection(project, empty), {
    db: fakeDb(),
    members: [],
  })

  const posted = withRoster.channels.cache.get('new-2')
  assert.equal(posted.sent.length, 1, 'an empty roster is a real answer, and says so')
  assert.match(posted.sent[0].embeds[0].data.description, /No members yet/)
})

test('a run with no db seam warns that the ids went unsaved, and does not throw', async () => {
  const guild = fakeGuild()
  const plan = planProjectSection(project, empty)

  const out = await applyProjectSection(guild, project, plan, {})

  assert.equal(out.created.length, 11, 'the section is still built')
  assert.ok(
    out.warnings.some((w) => /Framework/.test(w) && /not saved/i.test(w)),
    out.warnings.join(' | ')
  )
})

// --- syncProjectRoleMembers -------------------------------------------------

function roleMember(id, log) {
  return {
    id,
    roles: {
      add: async (r) => { log.push(['add', id, r?.id ?? r]) },
      remove: async (r) => { log.push(['remove', id, r?.id ?? r]) },
    },
  }
}

test('syncProjectRoleMembers grants the role to members who lack it and leaves holders alone', async () => {
  const log = []
  const holder = roleMember('u2', log)
  const role = { id: 'r1', name: 'Framework', members: new Map([['u2', holder]]) }
  const guild = fakeGuild({ roles: [role] })
  guild.members = { fetch: async (id) => roleMember(id, log) }

  const out = await syncProjectRoleMembers(guild, project, [{ discordId: 'u1' }, { discordId: 'u2' }], { roleId: 'r1' })

  assert.deepEqual(out.granted, ['u1'])
  assert.deepEqual(out.revoked, [])
  assert.deepEqual(out.failed, [])
  assert.deepEqual(log, [['add', 'u1', 'r1']])
})

test('syncProjectRoleMembers revokes from a holder who is no longer on the project', async () => {
  const log = []
  const holder = roleMember('u2', log)
  const role = { id: 'r1', name: 'Framework', members: new Map([['u2', holder]]) }
  const guild = fakeGuild({ roles: [role] })
  guild.members = { fetch: async (id) => roleMember(id, log) }

  const out = await syncProjectRoleMembers(guild, project, [{ discordId: 'u1' }], { roleId: 'r1' })

  assert.deepEqual(out.granted, ['u1'])
  assert.deepEqual(out.revoked, ['u2'])
  assert.deepEqual(log, [['add', 'u1', 'r1'], ['remove', 'u2', 'r1']])
})

test('syncProjectRoleMembers collects a per-member failure instead of throwing', async () => {
  const log = []
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const guild = fakeGuild({ roles: [role] })
  guild.members = {
    fetch: async (id) => {
      if (id === 'm3') throw new Error('Unknown Member')
      return roleMember(id, log)
    },
  }

  const out = await quiet(() =>
    syncProjectRoleMembers(guild, project, [{ discordId: 'u1' }, { discordId: 'm3' }], { roleId: 'r1' }),
  )

  assert.deepEqual(out.granted, ['u1'])
  assert.equal(out.failed.length, 1)
  assert.match(out.failed[0], /m3/)
  assert.match(out.failed[0], /Unknown Member/)
})

test('syncProjectRoleMembers does nothing at all without a role id', async () => {
  const out = await syncProjectRoleMembers(fakeGuild(), project, [{ discordId: 'u1' }], { roleId: null })
  assert.deepEqual(out, { granted: [], revoked: [], failed: [] })
})
