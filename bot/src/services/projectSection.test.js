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
  claimedSectionIds,
  projectSlug,
} from './projectSection.js'

const project = { id: 'p1', name: 'Framework', docsSlug: 'framework' }
const empty = { roleId: null, roleCandidate: null, rolesFetched: true, categoryId: null, categoryName: null, categoryChannelCount: 0, channels: {}, tasks: [], takenNames: new Set() }

/**
 * A same-named role the planner may look at: harmless by default, so each test
 * spells out only the one thing it is about.
 */
function candidate(over = {}) {
  return {
    id: 'r9',
    name: 'Framework',
    managed: false,
    isEveryone: false,
    overPermissioned: false,
    holderIds: [],
    elsewhere: [],
    ...over,
  }
}

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

test('an existing role of the same name that NOBODY holds is reused, not created again', () => {
  // The legacy `/create-project-role` role that was made and never assigned.
  // Reusing an empty role can neither strip anyone nor show anyone anything.
  const plan = planProjectSection(project, { ...empty, rolesFetched: true, roleCandidate: candidate() })
  assert.deepEqual([plan.role.action, plan.role.decision, plan.role.id], ['reuse', 'empty', 'r9'])
  assert.equal(plan.warnings.length, 0)
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
  assert.deepEqual(plan.tasks, [
    {
      taskId: 'tA1b2c3d4e5f6',
      channelId: 'ch1',
      action: 'both',
      name: 'feature-git-sync',
      // The rename carries the topic: without it the channel keeps a topic
      // naming a task nothing can match it back to.
      topic: 'Feature: Git Sync — Task tA1b2c3d4e5f6',
    },
  ])
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

test('projectFromChannel resolves a thread to the channel it lives in', () => {
  const projects = [{ id: 'p1', name: 'Framework', discordCategoryId: 'c1' }]
  const parent = { id: 'ch9', parentId: 'c1', isThread: () => false }
  // A thread's own parentId is its text channel, never the category.
  const thread = { id: 't1', parentId: 'ch9', isThread: () => true, parent }
  assert.equal(projectFromChannel(projects, thread).id, 'p1')
  assert.equal(projectFromChannel(projects, { id: 't2', parentId: 'ch9', isThread: () => true, parent: null }), null)
})

test('projectFromChannel refuses to guess when two projects claim one category', () => {
  const projects = [
    { id: 'p1', name: 'Framework', discordCategoryId: 'c1' },
    { id: 'p2', name: 'Framework copy', discordCategoryId: 'c1' },
  ]
  assert.equal(projectFromChannel(projects, { id: 'ch9', parentId: 'c1' }), null)
  assert.equal(projectFromChannel(projects, { id: 'c1', parentId: null }), null)
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

function fakeGuild({ channels = [], roles = [], createFails = null, everyonePermissions = 0n } = {}) {
  const guild = {
    id: 'G1',
    roles: {
      cache: new Map(roles.map((r) => [r.id, r])),
      // Every real guild has one, and it is the yardstick the "is this role
      // also a power role" test measures against.
      everyone: { id: 'G1', name: '@everyone', permissions: everyonePermissions },
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
  assert.equal(observed.roleCandidate.id, 'r1')
  assert.equal(observed.categoryId, 'c1')
  assert.equal(observed.categoryName, '📂 FRAMEWORK')
  assert.equal(observed.categoryChannelCount, 1)
  assert.deepEqual(observed.channels.members, {
    id: 'm1',
    name: 'framework-members',
    parentId: 'c1',
    // Unreadable on this fake, so the planner never plans a permissions edit.
    overwriteIds: null,
  })
  assert.equal(observed.channels.documentation, undefined)
  assert.deepEqual(observed.tasks, [
    { id: 't1', title: 'Git Sync', type: 'feature', channelId: 'tc1', channelName: 'feature-0145e3', parentId: 'FEATURES', overwriteIds: null },
  ])
  assert.ok(observed.takenNames.has('general'))
  assert.ok(observed.takenNames.has('framework-members'))
})

test('a channel more than one task points at is not a task channel', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  // The meeting review channel: every unassigned meeting task's row names it.
  const review = fakeChannel('review', 'pipeline-test', { parentId: 'MEETINGS' })
  const taskCh = fakeChannel('tc1', 'feature-0145e3', { parentId: 'FEATURES' })
  const guild = fakeGuild({ channels: [cat, review, taskCh] })
  const stored = { ...project, discordCategoryId: 'c1' }

  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' },
    { id: 't2', title: 'Do A', type: 'feature', discordChannelId: 'review' },
    { id: 't3', title: 'Do B', type: 'feature', discordChannelId: 'review' },
  ])

  assert.deepEqual(observed.tasks.map((t) => t.id), ['t1'])
  assert.equal(observed.sharedTaskChannels, 1)

  const plan = planProjectSection(stored, observed)
  assert.deepEqual(plan.tasks.map((t) => t.channelId), ['tc1'])
  // Counted and said out loud, not silently dropped.
  assert.ok(plan.warnings.some((w) => /not task channels|not a task channel/.test(w)), plan.warnings.join(' | '))

  const out = await applyProjectSection(guild, stored, plan, { db: fakeDb() })

  // Renaming it to `feature-do-a` and moving it into one project's category
  // would take the whole meeting's review away from everything else using it.
  assert.equal(review.edits.length, 0)
  assert.equal(review.name, 'pipeline-test')
  assert.equal(review.parentId, 'MEETINGS')
  assert.equal(out.tasks, 1)
})

test('a meeting review channel only ONE task points at is still not a task channel', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  // A meeting that produced exactly one unassigned task: its row names the
  // review channel and nothing else does, so a reference count alone passes it.
  const review = fakeChannel('review', 'standup-review', { parentId: 'MEETINGS' })
  review.topic = 'Meeting chat is stored in the database with the sender and timestamp.'
  const guild = fakeGuild({ channels: [cat, review] })
  const stored = { ...project, discordCategoryId: 'c1' }

  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Do A', type: 'feature', discordChannelId: 'review' },
  ])
  assert.deepEqual(observed.tasks, [])
  assert.equal(observed.sharedTaskChannels, 1)

  const plan = planProjectSection(stored, observed)
  assert.deepEqual(plan.tasks, [])
  assert.ok(plan.warnings.some((w) => /^1 channel .* is not a task channel/.test(w)), plan.warnings.join(' | '))

  await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  assert.equal(review.edits.length, 0)
  assert.equal(review.name, 'standup-review')
  assert.equal(review.parentId, 'MEETINGS')
})

test('a task channel renamed by hand is still repaired while its topic says Feature:', () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskCh = fakeChannel('tc1', 'booking', { parentId: 'FEATURES' })
  taskCh.topic = 'Feature: Git Sync | Assigner + assignees'
  const guild = fakeGuild({ channels: [cat, taskCh] })
  const observed = observeProjectSection(guild, { ...project, discordCategoryId: 'c1' }, [
    { id: 't1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' },
  ])
  assert.deepEqual(observed.tasks.map((t) => t.id), ['t1'])
  assert.equal(observed.sharedTaskChannels, 0)
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
      PermissionFlagsBits.UseVAD,
      PermissionFlagsBits.Stream,
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

  // One edit — Discord allows two per channel per ten minutes — and it carries
  // the topic as well as the name and the parent. A rename that left
  // `Feature: Git Sync` behind would leave the channel matching neither its old
  // name nor its task id, and /update-task would build a duplicate beside it.
  assert.equal(taskCh.edits.length, 1)
  assert.deepEqual(taskCh.edits[0], {
    name: 'feature-git-sync',
    parent: 'c1',
    topic: 'Feature: Git Sync — Task t1',
  })
  assert.equal(out.tasks, 1)
})

test('a meeting channel named bug-… is not a task channel, and /project-setup leaves it alone', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  // `/meeting-channel name:"Bug triage"` makes this: a `bug-` name, but the
  // topic — the bot's own signature on every ticket it opens — says meeting.
  const triage = fakeChannel('triage', 'bug-triage-1726650000-text', { parentId: 'MEETINGS' })
  triage.topic = 'Meeting chat is stored in the database with the sender and timestamp.'
  const guild = fakeGuild({ channels: [cat, triage] })
  const stored = { ...project, discordCategoryId: 'c1' }

  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Fix login', type: 'feature', discordChannelId: 'triage' },
  ])
  assert.deepEqual(observed.tasks, [])
  assert.equal(observed.sharedTaskChannels, 1)

  const plan = planProjectSection(stored, observed)
  assert.ok(plan.warnings.some((w) => /^1 channel .* is not a task channel/.test(w)), plan.warnings.join(' | '))

  await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  assert.equal(triage.edits.length, 0)
  assert.equal(triage.name, 'bug-triage-1726650000-text')
  assert.equal(triage.parentId, 'MEETINGS')
})

test('a voice channel named feature-… is not a task channel', () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  // A voice channel has no topic, and `/create-channel` takes any voice name.
  const voice = fakeChannel('v1', 'feature-x', { type: ChannelType.GuildVoice, parentId: 'MEETINGS' })
  const guild = fakeGuild({ channels: [cat, voice] })
  const observed = observeProjectSection(guild, { ...project, discordCategoryId: 'c1' }, [
    { id: 't1', title: 'X', type: 'feature', discordChannelId: 'v1' },
  ])
  assert.deepEqual(observed.tasks, [])
  assert.equal(observed.sharedTaskChannels, 1)
})

// --- the project role on task channels (fix round 2, Fix 3) ----------------

const ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.UseVAD,
  PermissionFlagsBits.Stream,
]

/** A task channel as /create-task makes it: @everyone denied, its assignee allowed. */
function ticketChannel(id, name, parentId, extra = []) {
  const ch = fakeChannel(id, name, {
    parentId,
    overwrites: [
      { id: 'G1', type: OverwriteType.Role, allow: 0n, deny: PermissionFlagsBits.ViewChannel },
      { id: 'assignee', type: OverwriteType.Member, allow: PermissionFlagsBits.ViewChannel, deny: 0n },
      ...extra,
    ],
  })
  ch.topic = 'Feature: Git Sync | Assigner + assignees'
  return ch
}

test('a task channel moved into the section gains the project role, keeps its assignee, in ONE edit', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskCh = ticketChannel('tc1', 'feature-0145e3', 'FEATURES')
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const guild = fakeGuild({ channels: [cat, taskCh], roles: [role] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' },
  ])
  const plan = planProjectSection(stored, observed)
  assert.equal(plan.tasks[0].action, 'both')

  await applyProjectSection(guild, stored, plan, { db: fakeDb() })

  // One edit: Discord allows two per channel per ten minutes.
  assert.equal(taskCh.edits.length, 1)
  const edit = taskCh.edits[0]
  assert.equal(edit.name, 'feature-git-sync')
  assert.equal(edit.parent, 'c1')
  assert.equal(edit.topic, 'Feature: Git Sync — Task t1')
  const byId = new Map(edit.permissionOverwrites.map((o) => [o.id, o]))
  // The project's members can now see their project's task channel...
  assert.deepEqual(byId.get('r1'), { id: 'r1', type: OverwriteType.Role, allow: ALLOW })
  // ...and nothing the channel already carried was dropped: @everyone stays
  // denied, and the assignee who may not be on the project keeps the task.
  assert.equal(byId.get('G1').deny, PermissionFlagsBits.ViewChannel)
  assert.equal(byId.get('G1').type, OverwriteType.Role)
  assert.equal(byId.get('assignee').type, OverwriteType.Member)
  assert.equal(byId.get('assignee').allow, PermissionFlagsBits.ViewChannel)
  assert.equal(edit.permissionOverwrites.length, 3)
})

test('a stale role id adds no allow, and the move still happens in one edit', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskCh = ticketChannel('tc1', 'feature-0145e3', 'FEATURES')
  const guild = fakeGuild({ channels: [cat, taskCh] })
  const plan = {
    // The role was deleted between the read and the write.
    role: { action: 'reuse', id: 'gone', name: 'Framework' },
    category: { action: 'reuse', id: 'c1', name: '📂 FRAMEWORK' },
    channels: [],
    tasks: [{ taskId: 't1', channelId: 'tc1', action: 'both', name: 'feature-git-sync', topic: 'Feature: Git Sync — Task t1' }],
    warnings: [],
  }
  await applyProjectSection(guild, { ...project, discordCategoryId: 'c1' }, plan, { db: fakeDb() })
  assert.equal(taskCh.edits.length, 1)
  assert.deepEqual(taskCh.edits[0], { name: 'feature-git-sync', parent: 'c1', topic: 'Feature: Git Sync — Task t1' })
})

test('a channel whose overwrites cannot be read still moves, without an allow that would replace them', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskCh = fakeChannel('tc1', 'feature-0145e3', { parentId: 'FEATURES' })
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const guild = fakeGuild({ channels: [cat, taskCh], roles: [role] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' },
  ])
  await applyProjectSection(guild, stored, planProjectSection(stored, observed), { db: fakeDb() })
  assert.equal(taskCh.edits.length, 1)
  assert.equal(taskCh.edits[0].permissionOverwrites, undefined)
})

test('a task channel already named, placed and open to the role gets no edit', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'c1', [
    { id: 'r1', type: OverwriteType.Role, allow: PermissionFlagsBits.ViewChannel, deny: 0n },
  ])
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const guild = fakeGuild({ channels: [cat, taskCh], roles: [role] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' },
  ])
  const plan = planProjectSection(stored, observed)
  assert.equal(plan.tasks[0].action, 'none')

  const out = await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  assert.equal(taskCh.edits.length, 0)
  assert.equal(out.tasks, 0)
})

test('a task channel already named and placed but closed to the role is granted it, and only that', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  // Opened while the project's role id was stale: in the section, no allow.
  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'c1')
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const guild = fakeGuild({ channels: [cat, taskCh], roles: [role] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' },
  ])
  const plan = planProjectSection(stored, observed)
  assert.equal(plan.tasks[0].action, 'grant')

  const out = await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  assert.equal(taskCh.edits.length, 1)
  const edit = taskCh.edits[0]
  // Nothing but the overwrites: the name and the parent are already right.
  assert.deepEqual(Object.keys(edit), ['permissionOverwrites'])
  assert.deepEqual(edit.permissionOverwrites.map((o) => o.id).sort(), ['G1', 'assignee', 'r1'])
  assert.deepEqual(out.granted, ['feature-git-sync'])
  assert.equal(out.tasks, 1)
})

test('the planner never plans a grant for a refused role or an unreadable channel', () => {
  const base = { id: 't1', title: 'Git Sync', type: 'feature', channelId: 'tc1', channelName: 'feature-git-sync', parentId: 'c1' }
  const observed = (task) => ({ ...empty, roleId: 'r1', categoryId: 'c1', categoryName: '📂 FRAMEWORK', tasks: [task] })
  assert.equal(planProjectSection(project, observed({ ...base, overwriteIds: null })).tasks[0].action, 'none')
  assert.equal(planProjectSection(project, observed({ ...base, overwriteIds: ['G1'] })).tasks[0].action, 'grant')
  assert.equal(planProjectSection(project, observed({ ...base, overwriteIds: ['G1', 'r1'] })).tasks[0].action, 'none')
  const refused = { id: 'p9', name: 'Frontend', docsSlug: 'frontend' }
  const plan = planProjectSection(refused, { ...observed({ ...base, overwriteIds: ['G1'] }), roleId: null })
  assert.equal(plan.role.action, 'refuse')
  assert.equal(plan.tasks[0].action, 'none')
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

// B4: this test used to assert the opposite — `permissionOverwrites: []`, a
// fully PUBLIC category, on the reasoning that a managed NAME can never have a
// role of its own, so a deny with nothing to allow would hide the section from
// everyone with no way back. Part A made a refused HELD role keep the deny,
// which changed that trade: hidden is recoverable (rename the project, re-run
// /project-setup, get a real role and a repaired section) while public
// silently shows the project's ten channels, and every task channel moved into
// them, to the whole server. Both refusals now fail closed.
test('a refused role with no role to fall back on leaves the category HIDDEN, and is warned about once', async () => {
  const dbProject = { id: 'p2', name: 'Database', docsSlug: 'database' }
  const guild = fakeGuild()
  const plan = planProjectSection(dbProject, empty)
  assert.equal(plan.role.action, 'refuse')
  assert.ok(
    plan.warnings.some((w) => /HIDDEN/.test(w) && /rename the project/i.test(w)),
    plan.warnings.join(' | ')
  )

  const out = await applyProjectSection(guild, dbProject, plan, { db: fakeDb() })

  assert.equal(guild.roles.calls.length, 0, 'no role is created for a managed name')
  assert.equal(out.role, null)
  const catCall = guild.channels.calls[0]
  assert.equal(catCall.type, ChannelType.GuildCategory)
  assert.deepEqual(
    catCall.permissionOverwrites,
    [{ id: 'G1', type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] }],
    'the @everyone deny stands: a hidden section is repairable, a public one is a leak'
  )
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
      PermissionFlagsBits.UseVAD,
      PermissionFlagsBits.Stream,
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

test('syncProjectRoleMembers with revoke: false grants but never revokes', async () => {
  // What /project-setup passes when its roster is known to be incomplete (the
  // member list would not load, or the read hit its row limit): "not in the
  // roster" then means "not read", not "left the project".
  const log = []
  const stale = roleMember('u2', log)
  const role = { id: 'r1', name: 'Framework', members: new Map([['u2', stale]]) }
  const guild = fakeGuild({ roles: [role] })
  guild.members = { fetch: async (id) => roleMember(id, log) }

  const out = await syncProjectRoleMembers(guild, project, [{ discordId: 'u1' }], { roleId: 'r1', revoke: false })

  assert.deepEqual(out.granted, ['u1'])
  assert.deepEqual(out.revoked, [])
  assert.deepEqual(log, [['add', 'u1', 'r1']])
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

// ---------------------------------------------------------------------------
// The role rules: adoption is fail-closed, and every refusal says why.
// ---------------------------------------------------------------------------

test('a same-named role somebody already HOLDS is refused, not adopted', () => {
  // The Task 10 reviewer's case: a guild role `Framework` held by two people,
  // plus a project called `Framework`. Adopting it would show the new section
  // to both of them and then take the role off both, because neither is a
  // `projectmember` row.
  const plan = planProjectSection(project, {
    ...empty,
    roleCandidate: candidate({ holderIds: ['u1', 'u2'] }),
  })
  assert.equal(plan.role.action, 'refuse')
  assert.equal(plan.role.kind, 'role')
  assert.equal(plan.role.gateRoleId, null, 'a refused role gates nothing')
  const text = plan.warnings.join(' | ')
  assert.match(text, /held by 2 member\(s\)/)
  // Both ways out, named.
  assert.match(text, /Rename the project or the role/)
  assert.match(text, /adopt_role:true/)
  assert.match(text, /preview:true/)
})

test('adopt_role adopts a held role and remembers who holds it', () => {
  const plan = planProjectSection(
    project,
    { ...empty, roleCandidate: candidate({ holderIds: ['u1', 'u2'] }) },
    { adoptRole: true }
  )
  assert.deepEqual(
    [plan.role.action, plan.role.decision, plan.role.id, plan.role.gateRoleId],
    ['reuse', 'adopt', 'r9', 'r9']
  )
  assert.deepEqual(plan.role.holderIds, ['u1', 'u2'])
  assert.equal(plan.warnings.length, 0)
})

test('adopt_role does NOT override a managed, @everyone, powerful or door-opening role', () => {
  const cases = [
    [candidate({ managed: true, holderIds: ['u1'] }), /managed by Discord or an integration/],
    [candidate({ isEveryone: true }), /@everyone role/],
    [candidate({ overPermissioned: true }), /permissions beyond @everyone/],
    [candidate({ elsewhere: ['design-private', 'finance'] }), /overwrites on 2 channel\(s\) outside this project/],
  ]
  for (const [roleCandidate, expected] of cases) {
    const plan = planProjectSection(project, { ...empty, roleCandidate }, { adoptRole: true })
    assert.equal(plan.role.action, 'refuse', `${expected} should refuse`)
    assert.equal(plan.role.gateRoleId, null)
    const text = plan.warnings.join(' | ')
    assert.match(text, expected)
    assert.match(text, /adopt_role\*\* does not override this/, text)
  }
})

test('a door-opening role names the channels it would hand over', () => {
  const plan = planProjectSection(project, {
    ...empty,
    roleCandidate: candidate({ elsewhere: ['design-private', 'finance', 'legal', 'exec'] }),
  })
  assert.match(plan.warnings.join(' | '), /design-private, finance, legal, and 1 more/)
})

test('an unfetched member cache refuses adoption instead of reading it as "nobody holds it"', () => {
  // The whole leak in one line: `role.members` is the member cache, so without
  // a fetch every role looks empty, and an empty role is one the planner
  // adopts. The flag, not the count, is what decides.
  const plan = planProjectSection(project, {
    ...empty,
    rolesFetched: false,
    roleCandidate: candidate({ holderIds: [] }),
  })
  assert.equal(plan.role.action, 'refuse')
  assert.match(plan.warnings.join(' | '), /member list could not be read/)
  // With the fetch, the very same snapshot adopts it.
  const fetched = planProjectSection(project, { ...empty, rolesFetched: true, roleCandidate: candidate() })
  assert.equal(fetched.role.decision, 'empty')
})

test("the project's own stored role wins over everything a same-named role could be", () => {
  const plan = planProjectSection(project, {
    ...empty,
    roleId: 'stored1',
    rolesFetched: false,
    roleCandidate: candidate({ managed: true, overPermissioned: true, holderIds: ['u1'] }),
  })
  assert.deepEqual(
    [plan.role.action, plan.role.decision, plan.role.id, plan.role.gateRoleId],
    ['reuse', 'stored', 'stored1', 'stored1']
  )
  assert.equal(plan.warnings.length, 0)
})

test('a refused name that KEPT an old role repairs channels against THAT role', () => {
  // The managed-name refusal: the project was renamed onto `Database`, so no
  // role of that name will ever be made, but the role it already had still
  // gates the section. The planner and the applier have to agree which role
  // that is — before `gateRoleId` the planner said "no role, plan nothing"
  // while the applier put the kept role's allow on every moved channel.
  const renamed = { id: 'p2', name: 'Database', docsSlug: 'database', discordRoleId: 'r7' }
  const task = { id: 't1', title: 'Git Sync', type: 'feature', channelId: 'tc1', channelName: 'feature-git-sync', parentId: 'c1', overwriteIds: ['G1'] }
  const plan = planProjectSection(renamed, {
    ...empty,
    roleId: 'r7',
    categoryId: 'c1',
    categoryName: '📂 DATABASE',
    tasks: [task],
  })
  assert.equal(plan.role.action, 'refuse')
  assert.equal(plan.role.kind, 'managed-name')
  assert.equal(plan.role.gateRoleId, 'r7')
  assert.equal(plan.tasks[0].action, 'grant', 'the kept role reaches the task channel too')
})

test('a refused role with nothing kept plans no channel permission work at all', () => {
  const task = { id: 't1', title: 'Git Sync', type: 'feature', channelId: 'tc1', channelName: 'feature-git-sync', parentId: 'c1', overwriteIds: ['G1'] }
  const channels = { members: { id: 'm1', name: 'framework-members', parentId: 'c1', overwriteIds: ['G1'] } }
  const plan = planProjectSection(project, {
    ...empty,
    categoryId: 'c1',
    categoryName: '📂 FRAMEWORK',
    channels,
    tasks: [task],
    roleCandidate: candidate({ holderIds: ['u1'] }),
  })
  assert.equal(plan.role.action, 'refuse')
  assert.equal(plan.tasks[0].action, 'none')
  assert.equal(plan.channels.find((c) => c.key === 'members').action, 'reuse')
})

// ---------------------------------------------------------------------------
// A1: the ten section channels get the role allow when the role arrives later
// ---------------------------------------------------------------------------

/** The ten section channels as the observer reports them, all right but for perms. */
function placedSections(overwriteIds) {
  const channels = {}
  for (const s of SECTIONS) {
    channels[s.key] = {
      id: `id-${s.key}`,
      name: channelNameFor(project, s.suffix),
      parentId: 'c1',
      overwriteIds,
    }
  }
  return channels
}

test('a section channel that lacks the role allow is planned a standalone grant', () => {
  // Discord copies a category's overwrites onto a channel when the channel is
  // CREATED and never cascades a later change, so ten channels created under a
  // deny-only category keep a deny-only copy forever.
  const plan = planProjectSection(project, {
    ...empty,
    roleId: 'r1',
    categoryId: 'c1',
    categoryName: '📂 FRAMEWORK',
    channels: placedSections(['G1']),
  })
  assert.ok(plan.channels.every((c) => c.action === 'grant'), plan.channels.map((c) => c.action).join(','))
})

test('a section channel that already has the role allow is left completely alone', () => {
  const plan = planProjectSection(project, {
    ...empty,
    roleId: 'r1',
    categoryId: 'c1',
    categoryName: '📂 FRAMEWORK',
    channels: placedSections(['G1', 'r1']),
  })
  assert.ok(plan.channels.every((c) => c.action === 'reuse'))
})

test('a section channel whose overwrites cannot be read skips the repair, not the channel', () => {
  const channels = placedSections(null)
  channels.members = { id: 'm1', name: 'WRONG', parentId: 'c1', overwriteIds: null }
  const plan = planProjectSection(project, {
    ...empty,
    roleId: 'r1',
    categoryId: 'c1',
    categoryName: '📂 FRAMEWORK',
    channels,
  })
  const byKey = Object.fromEntries(plan.channels.map((c) => [c.key, c]))
  assert.equal(byKey.members.action, 'rename', 'the rename still happens')
  assert.equal(byKey.members.opens, undefined, 'but nothing is guessed about its permissions')
  assert.equal(byKey.meetings.action, 'reuse')
})

test('a section channel being moved carries the allow in that SAME edit', () => {
  const channels = placedSections(['G1', 'r1'])
  channels.members = { id: 'm1', name: 'framework-members', parentId: 'ELSEWHERE', overwriteIds: ['G1'] }
  const plan = planProjectSection(project, {
    ...empty,
    roleId: 'r1',
    categoryId: 'c1',
    categoryName: '📂 FRAMEWORK',
    channels,
  })
  const members = plan.channels.find((c) => c.key === 'members')
  assert.equal(members.action, 'move')
  assert.equal(members.opens, true, 'not a second edit — two per channel per ten minutes')
})

test('a role about to be CREATED means every readable section channel needs the allow', () => {
  const plan = planProjectSection(project, {
    ...empty,
    categoryId: 'c1',
    categoryName: '📂 FRAMEWORK',
    channels: placedSections([]),
  })
  assert.equal(plan.role.action, 'create')
  assert.ok(plan.channels.every((c) => c.action === 'grant'))
})

test('a section channel lacking the allow gets exactly ONE merged repair edit', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  // As Discord made it: copied from the category back when it was deny-only,
  // plus a grant somebody added by hand afterwards.
  const mem = fakeChannel('m1', 'framework-members', {
    parentId: 'c1',
    overwrites: [
      { id: 'G1', type: OverwriteType.Role, allow: 0n, deny: PermissionFlagsBits.ViewChannel },
      { id: 'u9', type: OverwriteType.Member, allow: PermissionFlagsBits.ViewChannel, deny: 0n },
    ],
  })
  const role = { id: 'r1', name: 'Framework', members: new Map(), permissions: 0n }
  const guild = fakeGuild({ channels: [cat, mem], roles: [role] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1', discordChannels: { members: 'm1' } }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, [], { rolesFetched: true }))
  assert.equal(plan.channels.find((c) => c.key === 'members').action, 'grant')

  const out = await applyProjectSection(guild, stored, plan, { db: fakeDb() })

  assert.equal(mem.edits.length, 1, 'one edit, and nothing but the overwrites')
  assert.deepEqual(Object.keys(mem.edits[0]), ['permissionOverwrites'])
  const byId = new Map(mem.edits[0].permissionOverwrites.map((o) => [o.id, o]))
  assert.deepEqual(byId.get('r1'), { id: 'r1', type: OverwriteType.Role, allow: ALLOW })
  assert.equal(byId.get('G1').deny, PermissionFlagsBits.ViewChannel, 'the deny stays')
  assert.equal(byId.get('u9').type, OverwriteType.Member, 'the hand-added grant stays')
  assert.equal(mem.edits[0].permissionOverwrites.length, 3)
  assert.ok(out.granted.includes('framework-members'))
  // The name and the parent were already right, so nothing else moved.
  assert.equal(mem.name, 'framework-members')
  assert.equal(mem.parentId, 'c1')
})

test('a section channel already holding the allow gets NO edit', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const mem = fakeChannel('m1', 'framework-members', { parentId: 'c1', overwriteIds: ['G1', 'r1'] })
  const role = { id: 'r1', name: 'Framework', members: new Map(), permissions: 0n }
  const guild = fakeGuild({ channels: [cat, mem], roles: [role] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1', discordChannels: { members: 'm1' } }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, [], { rolesFetched: true }))

  await applyProjectSection(guild, stored, plan, { db: fakeDb() })

  assert.equal(mem.edits.length, 0)
})

test('a section channel renamed, moved AND opened is still exactly one edit', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const mem = fakeChannel('m1', 'old-members-channel', {
    parentId: 'ELSEWHERE',
    overwrites: [{ id: 'G1', type: OverwriteType.Role, allow: 0n, deny: PermissionFlagsBits.ViewChannel }],
  })
  const role = { id: 'r1', name: 'Framework', members: new Map(), permissions: 0n }
  const guild = fakeGuild({ channels: [cat, mem], roles: [role] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1', discordChannels: { members: 'm1' } }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, [], { rolesFetched: true }))

  const out = await applyProjectSection(guild, stored, plan, { db: fakeDb() })

  assert.equal(mem.edits.length, 1, 'two channel edits per ten minutes — never split this')
  assert.equal(mem.edits[0].name, 'framework-members')
  assert.equal(mem.edits[0].parent, 'c1')
  assert.ok(mem.edits[0].permissionOverwrites.some((o) => o.id === 'r1'))
  assert.deepEqual(out.opened, ['framework-members'])
  assert.ok(out.moved.includes('framework-members'))
})

test('a refused same-named role builds the section shut, and a later adopt_role repairs all ten', async () => {
  // The whole A1 path end to end: nine existing projects come out of the
  // backfill like this, and a run that left them permanently invisible with no
  // repair would not be a fix — nothing here may delete a channel.
  const held = { id: 'r9', name: 'Framework', members: new Map([['u1', {}]]), permissions: 0n }
  const guild = fakeGuild({ roles: [held] })
  const fresh = { ...project }
  const plan1 = planProjectSection(fresh, observeProjectSection(guild, fresh, [], { rolesFetched: true }))
  assert.equal(plan1.role.action, 'refuse')

  const db1 = fakeDb()
  await applyProjectSection(guild, fresh, plan1, { db: db1 })

  // The category is shut: @everyone denied, nothing allowed. Not open, and not
  // gated on a role a stranger holds.
  assert.deepEqual(guild.channels.calls[0].permissionOverwrites, [
    { id: 'G1', type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
  ])
  assert.equal(guild.roles.calls.length, 0, 'and no second role of the same name')

  // Discord copies the category's set onto each new channel, so the ten of them
  // now carry the deny and nothing else. Mirror that onto the fakes.
  const saved = db1.calls[0].data
  for (const id of Object.values(saved.discordChannels)) {
    guild.channels.cache.get(id).permissionOverwrites = {
      cache: new Map([['G1', { id: 'G1', type: OverwriteType.Role, allow: 0n, deny: PermissionFlagsBits.ViewChannel }]]),
    }
  }

  // Now the operator adopts the role. Same guild, same channels.
  const stored = { ...fresh, discordCategoryId: saved.discordCategoryId, discordChannels: saved.discordChannels }
  const plan2 = planProjectSection(
    stored,
    observeProjectSection(guild, stored, [], { rolesFetched: true }),
    { adoptRole: true }
  )
  assert.equal(plan2.role.decision, 'adopt')
  assert.equal(plan2.channels.filter((c) => c.action === 'grant').length, 10)

  const out = await applyProjectSection(guild, stored, plan2, { db: fakeDb() })

  assert.equal(out.granted.length, 10, 'every section channel was repaired')
  for (const id of Object.values(saved.discordChannels)) {
    const made = guild.channels.cache.get(id)
    assert.equal(made.edits.length, 1, `${made.name} took more than one edit`)
    const ids = made.edits[0].permissionOverwrites.map((o) => o.id)
    assert.ok(ids.includes('r9'), `${made.name} still cannot be seen`)
    assert.ok(ids.includes('G1'), `${made.name} lost its @everyone deny`)
  }
})

// ---------------------------------------------------------------------------
// A7: say what happened to roles
// ---------------------------------------------------------------------------

test('a role allow on the category that is not the project’s is reported, never removed', async () => {
  // `mergedOverwrites` keeps what it did not add, by design — so a REPLACED
  // role's allow sits on the category forever and its holders keep seeing the
  // section. Removing it silently would itself be an unrequested permission
  // change, so it is said out loud instead.
  const denyAll = { id: 'G1', type: OverwriteType.Role, allow: 0n, deny: PermissionFlagsBits.ViewChannel }
  const mine = { id: 'r1', type: OverwriteType.Role, allow: PermissionFlagsBits.ViewChannel, deny: 0n }
  const stale = { id: 'rOld', type: OverwriteType.Role, allow: PermissionFlagsBits.ViewChannel, deny: 0n }
  const byHand = { id: 'u9', type: OverwriteType.Member, allow: PermissionFlagsBits.ViewChannel, deny: 0n }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', {
    type: ChannelType.GuildCategory,
    overwrites: [denyAll, mine, stale, byHand],
  })
  const guild = fakeGuild({
    channels: [cat],
    roles: [
      { id: 'r1', name: 'Framework', members: new Map(), permissions: 0n },
      { id: 'rOld', name: 'Framework (old)', members: new Map(), permissions: 0n },
    ],
  })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, [], { rolesFetched: true }))

  const out = await applyProjectSection(guild, stored, plan, { db: fakeDb() })

  assert.equal(cat.edits.length, 0, 'nothing was taken off the category')
  const said = out.warnings.filter((w) => /also lets the role/.test(w))
  assert.equal(said.length, 1, out.warnings.join(' | '))
  assert.match(said[0], /Framework \(old\)/)
  assert.doesNotMatch(said[0], /u9/, 'a member overwrite is not a role')
})

test('syncProjectRoleMembers logs every id it takes the role from', async () => {
  const log = []
  const holder = roleMember('u2', log)
  const role = { id: 'r1', name: 'Framework', members: new Map([['u2', holder]]) }
  const guild = fakeGuild({ roles: [role] })
  guild.members = { fetch: async (id) => roleMember(id, log) }
  const lines = []
  const real = console.warn
  console.warn = (line) => lines.push(String(line))
  try {
    await syncProjectRoleMembers(guild, project, [], { roleId: 'r1' })
  } finally {
    console.warn = real
  }
  // "3 revoked" cannot be undone by hand; the ids can.
  assert.ok(lines.some((l) => /removed role r1 from u2/.test(l)), lines.join(' | '))
})

// ---------------------------------------------------------------------------
// The observer: role candidates, and ids another project already claims
// ---------------------------------------------------------------------------

test('observeProjectSection describes a same-named role without trusting it', () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const inside = fakeChannel('in1', 'framework-members', { parentId: 'c1', overwriteIds: ['r9'] })
  const outside = fakeChannel('out1', 'design-private', { parentId: 'OTHER', overwriteIds: ['r9'] })
  const role = { id: 'r9', name: 'Framework', managed: false, permissions: 0n, members: new Map([['u1', {}], ['u2', {}]]) }
  const guild = fakeGuild({ channels: [cat, inside, outside], roles: [role] })

  const observed = observeProjectSection(guild, { ...project, discordCategoryId: 'c1' }, [], { rolesFetched: true })

  assert.equal(observed.rolesFetched, true)
  assert.deepEqual(observed.roleCandidate.holderIds, ['u1', 'u2'])
  assert.equal(observed.roleCandidate.managed, false)
  assert.equal(observed.roleCandidate.isEveryone, false)
  assert.equal(observed.roleCandidate.overPermissioned, false)
  // Inside the project's own category does not count; anywhere else does.
  assert.deepEqual(observed.roleCandidate.elsewhere, ['design-private'])
})

test('observeProjectSection defaults rolesFetched to FALSE, so a forgetful caller refuses', () => {
  const role = { id: 'r9', name: 'Framework', permissions: 0n, members: new Map() }
  const guild = fakeGuild({ roles: [role] })
  const observed = observeProjectSection(guild, project, [])
  assert.equal(observed.rolesFetched, false)
  assert.equal(planProjectSection(project, observed).role.action, 'refuse')
})

test('a role carrying one permission @everyone lacks is over-permissioned', () => {
  const only = (roles, everyonePermissions = 0n) =>
    observeProjectSection(fakeGuild({ roles, everyonePermissions }), project, [], { rolesFetched: true })
      .roleCandidate.overPermissioned

  assert.equal(only([{ id: 'r9', name: 'Framework', permissions: PermissionFlagsBits.ManageMessages, members: new Map() }]), true)
  assert.equal(only([{ id: 'r8', name: 'Framework', permissions: 0n, members: new Map() }]), false)
  // Exactly what @everyone holds — what Discord makes by default, and what the
  // legacy /create-project-role roles are.
  assert.equal(
    only([{ id: 'r7', name: 'Framework', permissions: PermissionFlagsBits.SendMessages, members: new Map() }], PermissionFlagsBits.SendMessages),
    false
  )
  // An unreadable bitfield cannot prove the role is harmless, so it is not.
  assert.equal(only([{ id: 'r6', name: 'Framework', members: new Map() }]), true)
})

test('a category or section channel another project stores is never adopted by name', () => {
  // `Framework` and `framework` both want '📂 FRAMEWORK', and two projects
  // whose effective slugs collide want the same ten channel names.
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const mem = fakeChannel('m1', 'framework-members', { parentId: 'c1' })
  const guild = fakeGuild({ channels: [cat, mem] })
  const other = { id: 'pOther', discordCategoryId: 'c1', discordChannels: { members: 'm1' } }
  const mine = { id: 'p1', name: 'framework', docsSlug: 'framework' }

  const claimedIds = claimedSectionIds([other, mine], 'p1')
  assert.deepEqual([...claimedIds].sort(), ['c1', 'm1'])

  const observed = observeProjectSection(guild, mine, [], { rolesFetched: true, claimedIds })
  assert.equal(observed.categoryId, null, 'the other project keeps its category')
  assert.equal(observed.channels.members, undefined, 'and its members channel')

  // Without the guard, the second project merges its own role's allow into the
  // first project's category and plans a move, and the two trade the same
  // channels back and forth on every run.
  assert.equal(observeProjectSection(guild, mine, [], { rolesFetched: true }).categoryId, 'c1')
})

test('claimedSectionIds skips the project being set up and survives a JSON string column', () => {
  const rows = [
    { id: 'p1', discordCategoryId: 'cMine', discordChannels: { members: 'mMine' } },
    { id: 'p2', discordCategoryId: 'cOther', discordChannels: '{"meetings":"mOther"}' },
    { id: 'p3', discordCategoryId: null, discordChannels: null },
    null,
  ]
  assert.deepEqual([...claimedSectionIds(rows, 'p1')].sort(), ['cOther', 'mOther'])
})

test('projectSlug is the EFFECTIVE slug: the column, else one from the name', () => {
  assert.equal(projectSlug({ name: 'UBS Doc', docsSlug: null }), 'ubs-doc')
  assert.equal(projectSlug({ name: 'UBS Doc', docsSlug: 'ubs-documentation' }), 'ubs-documentation')
})

test('a section channel is never adopted by name from a channel the bot signed as a ticket', () => {
  // A project slugged `feature` wants `feature-members`; a task titled
  // "Members" in some other project is named exactly that. The topic decides —
  // the bot's own section channels carry none.
  const slugged = { id: 'p5', name: 'Feature', docsSlug: 'feature' }
  const someoneElses = fakeChannel('tc9', 'feature-members', { parentId: 'OTHER' })
  someoneElses.topic = 'Feature: Members — Task tzzz'
  const plain = fakeChannel('s9', 'feature-documentation', { parentId: 'OTHER' })
  const guild = fakeGuild({ channels: [someoneElses, plain] })

  const observed = observeProjectSection(guild, slugged, [], { rolesFetched: true })

  assert.equal(observed.channels.members, undefined, "another project's task channel is left alone")
  assert.equal(observed.channels.documentation.id, 's9', 'a topicless one is still adopted')
})

// ---------------------------------------------------------------------------
// D1: a permission change is counted only once Discord has accepted it
// ---------------------------------------------------------------------------

test('a section channel whose opening edit THROWS is not reported as opened', async () => {
  // The push used to happen before the await, so a `Missing Permissions`
  // throw landed in the catch and the reply said the channel had been opened
  // to the project role, beside "nothing to change". In a feature whose whole
  // point is telling an operator which permissions changed, that is the worst
  // possible lie.
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const stray = fakeChannel('m1', 'wrong-name', {
    parentId: 'OUTSIDE',
    overwriteIds: ['G1'],
    fail: 'Missing Permissions',
  })
  const guild = fakeGuild({ channels: [cat, stray], roles: [{ id: 'r1', name: 'Framework', members: new Map() }] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1', discordChannels: { members: 'm1' } }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, []))
  assert.equal(plan.channels.find((c) => c.key === 'members').opens, true, 'the plan does open it')

  const out = await quiet(() => applyProjectSection(guild, stored, plan, { db: fakeDb() }))

  assert.equal(stray.edits.length, 1, 'the one edit was attempted')
  assert.deepEqual(out.opened, [], 'and nothing was claimed for it')
  assert.deepEqual(out.moved, [])
  assert.ok(out.warnings.some((w) => /Missing Permissions/.test(w)), out.warnings.join(' | '))
})

test('a task channel whose opening edit THROWS is not reported as opened either', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskChannel = fakeChannel('tc1', 'feature-0145e3', {
    parentId: 'OUTSIDE',
    overwriteIds: ['G1'],
    fail: 'Missing Permissions',
  })
  const guild = fakeGuild({ channels: [cat, taskChannel], roles: [{ id: 'r1', name: 'Framework', members: new Map() }] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const tasks = [{ id: 't1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' }]
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, tasks))

  const out = await quiet(() => applyProjectSection(guild, stored, plan, { db: fakeDb() }))

  assert.deepEqual(out.opened, [])
  assert.equal(out.tasks, 0, 'a task channel that threw is not counted as done')
})

test('an edit that SUCCEEDS still reports the channel as opened', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const stray = fakeChannel('m1', 'wrong-name', { parentId: 'OUTSIDE', overwriteIds: ['G1'] })
  const guild = fakeGuild({ channels: [cat, stray], roles: [{ id: 'r1', name: 'Framework', members: new Map() }] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1', discordChannels: { members: 'm1' } }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, []))

  const out = await quiet(() => applyProjectSection(guild, stored, plan, { db: fakeDb() }))

  assert.deepEqual(out.opened, ['framework-members'])
  assert.equal(stray.edits.length, 1, 'name, parent and overwrites in ONE edit')
  assert.ok(stray.edits[0].permissionOverwrites)
})

// ---------------------------------------------------------------------------
// D2: a channel with a topic is never adopted by name
// ---------------------------------------------------------------------------

test('a hand-made channel that happens to match a section name is not adopted', async () => {
  // The guard used to read `!(c.topic && isTicketChannel(c))`, so only a
  // channel whose topic was a TICKET signature was refused. A private
  // `framework-meetings` a human made, with a human topic, was adopted by
  // name — and adoption merges the project role's allow into it, so everyone
  // holding the role could suddenly read it.
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const handMade = fakeChannel('h1', 'framework-meetings', {
    parentId: 'PRIVATE',
    overwriteIds: ['G1'],
  })
  handMade.topic = 'Leads only — do not add anyone'
  const guild = fakeGuild({ channels: [cat, handMade], roles: [{ id: 'r1', name: 'Framework', members: new Map() }] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }

  const observed = observeProjectSection(guild, stored, [])
  assert.equal(observed.channels.meetings, undefined, 'it was not adopted')

  const plan = planProjectSection(stored, observed)
  assert.equal(plan.channels.find((c) => c.key === 'meetings').action, 'create')

  await quiet(() => applyProjectSection(guild, stored, plan, { db: fakeDb() }))
  assert.equal(handMade.edits.length, 0, 'and it was never touched')
})

test('a topicless channel of the right name is still adopted, as before', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const ours = fakeChannel('h1', 'framework-meetings', { parentId: 'c1' })
  const guild = fakeGuild({ channels: [cat, ours], roles: [{ id: 'r1', name: 'Framework', members: new Map() }] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const observed = observeProjectSection(guild, stored, [])
  assert.equal(observed.channels.meetings?.id, 'h1')
})

// --- push-to-talk / screen-share repair (voice activity + Video for the project role) ---

const VOICE_ALLOW = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak
const BOTH = PermissionFlagsBits.UseVAD | PermissionFlagsBits.Stream
const roleOw = (allow, deny = 0n) => ({ id: 'r1', type: OverwriteType.Role, allow, deny })

/** A channel that records the overwrite edits made through permissionOverwrites.edit. */
function vadChannel(id, name, { type = ChannelType.GuildVoice, parentId = 'c1', overwrites = [roleOw(VOICE_ALLOW)], failVad = false } = {}) {
  const ch = fakeChannel(id, name, { type, parentId, overwrites })
  ch.vadEdits = []
  ch.permissionOverwrites.edit = async (...args) => {
    ch.vadEdits.push(args)
    if (failVad) throw new Error('Missing Permissions')
  }
  return ch
}

const vadGuild = (channels) => fakeGuild({ channels, roles: [{ id: 'r1', name: 'Framework', members: new Map() }] })
const vadProject = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }

test('the role allow set includes Use Voice Activity and Video, so a new section is neither push-to-talk nor unable to share a screen', async () => {
  const guild = fakeGuild()
  const out = await applyProjectSection(guild, project, planProjectSection(project, empty), { db: fakeDb() })
  const cat = guild.channels.calls.find((c) => c.type === ChannelType.GuildCategory)
  const roleAllow = cat.permissionOverwrites.find((o) => o.id === out.role.id).allow
  assert.ok(roleAllow.includes(PermissionFlagsBits.UseVAD))
  assert.ok(roleAllow.includes(PermissionFlagsBits.Stream))
})

test('observe lists voice channels in the category whose project-role overwrite lacks either permission, with which', () => {
  const cat = vadChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, parentId: null })
  const stuck = vadChannel('v1', 'meeting-abc-voice')
  const both = vadChannel('v2', 'framework-backend-voice', { overwrites: [roleOw(VOICE_ALLOW | BOTH)] })
  const onlyVideo = vadChannel('v3', 'framework-half-voice', { overwrites: [roleOw(VOICE_ALLOW | PermissionFlagsBits.UseVAD)] })
  const chosen = vadChannel('v4', 'framework-quiet-voice', { overwrites: [roleOw(VOICE_ALLOW, BOTH)] })
  const denyPtt = vadChannel('v5', 'framework-ptt-voice', { overwrites: [roleOw(VOICE_ALLOW, PermissionFlagsBits.UseVAD)] })
  const noRole = vadChannel('v6', 'hand-made-voice', { overwrites: [{ id: 'G1', type: OverwriteType.Role, allow: 0n, deny: PermissionFlagsBits.ViewChannel }] })
  const text = vadChannel('t1', 'framework-chat', { type: ChannelType.GuildText })
  const elsewhere = vadChannel('v7', 'lounge', { parentId: 'OTHER' })
  const unreadable = fakeChannel('v8', 'unreadable-voice', { type: ChannelType.GuildVoice, parentId: 'c1' })
  const guild = vadGuild([cat, stuck, both, onlyVideo, chosen, denyPtt, noRole, text, elsewhere, unreadable])

  const observed = observeProjectSection(guild, vadProject, [])

  assert.deepEqual(observed.voiceActivity.channels, [
    { id: 'v1', name: 'meeting-abc-voice', gaps: ['UseVAD', 'Stream'] },
    { id: 'v3', name: 'framework-half-voice', gaps: ['Stream'] },
    { id: 'v5', name: 'framework-ptt-voice', gaps: ['Stream'] }, // the explicit deny of voice activity is left alone
  ])
  assert.deepEqual(observed.voiceActivity.category, ['UseVAD', 'Stream'], 'the category carries the same gap')
})

test('nothing is listed without a project role, or when the category already allows both', () => {
  const cat = vadChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, parentId: null, overwrites: [roleOw(VOICE_ALLOW | BOTH)] })
  const stuck = vadChannel('v1', 'meeting-abc-voice')
  const noRoleGuild = fakeGuild({ channels: [cat, stuck] })
  assert.deepEqual(observeProjectSection(noRoleGuild, { ...project, discordCategoryId: 'c1' }, []).voiceActivity, { category: [], channels: [] })
  const guild = vadGuild([cat, stuck])
  assert.deepEqual(observeProjectSection(guild, vadProject, []).voiceActivity.category, [])
})

test('the plan carries the voice repairs through, and defaults to none', () => {
  const voiceActivity = { category: ['UseVAD'], channels: [{ id: 'v1', name: 'a', gaps: ['Stream'] }] }
  const observed = { ...empty, roleId: 'r1', categoryId: 'c1', categoryName: '📂 FRAMEWORK', voiceActivity }
  assert.deepEqual(planProjectSection(project, observed).voice, voiceActivity)
  assert.deepEqual(planProjectSection(project, empty).voice, { category: [], channels: [] })
})

test('applying the plan adds ONLY the missing permissions to the project role, merged, on the category and each listed channel', async () => {
  const cat = vadChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, parentId: null })
  const v1 = vadChannel('v1', 'meeting-abc-voice')
  const v2 = vadChannel('v2', 'meeting-def-voice', { overwrites: [roleOw(VOICE_ALLOW | PermissionFlagsBits.UseVAD)] })
  const guild = vadGuild([cat, v1, v2])
  const plan = planProjectSection(vadProject, observeProjectSection(guild, vadProject, []))

  const out = await applyProjectSection(guild, vadProject, plan, { db: fakeDb() })

  const sent = (ch) => { assert.equal(ch.vadEdits.length, 1, `${ch.name}: exactly one overwrite edit`); return ch.vadEdits[0] }
  for (const ch of [cat, v1]) {
    const [roleId, changes, options] = sent(ch)
    assert.equal(roleId, 'r1')
    assert.deepEqual(changes, { UseVAD: true, Stream: true }, 'nothing else about the role\'s overwrite is touched')
    assert.ok(options.reason)
  }
  assert.deepEqual(sent(v2)[1], { Stream: true }, 'a permission it already has is not re-sent')
  assert.deepEqual(out.voiceFixed.sort(), ['meeting-abc-voice', 'meeting-def-voice', '📂 FRAMEWORK'].sort())
})

test('a channel that is not in the plan, or that left the category since, gets no edit', async () => {
  const cat = vadChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, parentId: null, overwrites: [roleOw(VOICE_ALLOW | BOTH)] })
  const moved = vadChannel('v1', 'meeting-abc-voice', { parentId: 'SOMEWHERE-ELSE' })
  const unplanned = vadChannel('v9', 'never-listed-voice')
  const guild = vadGuild([cat, moved, unplanned])
  const plan = { ...planProjectSection(vadProject, observeProjectSection(guild, vadProject, [])), voice: { category: [], channels: [{ id: 'v1', name: 'meeting-abc-voice', gaps: ['UseVAD'] }] } }

  const out = await applyProjectSection(guild, vadProject, plan, { db: fakeDb() })

  assert.equal(moved.vadEdits.length, 0)
  assert.equal(unplanned.vadEdits.length, 0)
  assert.deepEqual(out.voiceFixed, [])
})

test('one channel refusing the edit becomes a warning and the rest are still repaired', async () => {
  const cat = vadChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, parentId: null, overwrites: [roleOw(VOICE_ALLOW | BOTH)] })
  const bad = vadChannel('v1', 'a-voice', { failVad: true })
  const good = vadChannel('v2', 'b-voice')
  const guild = vadGuild([cat, bad, good])
  const plan = planProjectSection(vadProject, observeProjectSection(guild, vadProject, []))

  const out = await quiet(() => applyProjectSection(guild, vadProject, plan, { db: fakeDb() }))

  assert.deepEqual(out.voiceFixed, ['b-voice'])
  assert.ok(out.warnings.some((w) => /voice activity on "a-voice"/.test(w) && /Missing Permissions/.test(w)), out.warnings.join(' | '))
})

test('a run with no project role never edits voice overwrites', async () => {
  const cat = vadChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, parentId: null })
  const v1 = vadChannel('v1', 'a-voice')
  const guild = fakeGuild({ channels: [cat, v1] })
  const plan = { ...planProjectSection(project, empty), role: { action: 'refuse', name: 'Framework' }, category: { action: 'reuse', id: 'c1', name: '📂 FRAMEWORK' }, channels: [], tasks: [], voice: { category: ['UseVAD'], channels: [{ id: 'v1', name: 'a-voice', gaps: ['UseVAD'] }] } }
  const out = await applyProjectSection(guild, { ...project, discordCategoryId: 'c1' }, plan, { db: fakeDb() })
  assert.equal(v1.vadEdits.length + cat.vadEdits.length, 0)
  assert.deepEqual(out.voiceFixed, [])
})
