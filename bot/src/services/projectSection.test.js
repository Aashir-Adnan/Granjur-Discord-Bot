import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { ARCHIVE_DIVIDER_NAME, ARCHIVE_DIVIDER_TOPIC, ARCHIVE_STORE_KEY } from '../utils/ticketArchive.js'
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
  DIVIDER_ROLE_ALLOW,
  DIVIDER_ROLE_DENY,
} from './projectSection.js'

const project = { id: 'p1', name: 'Framework', docsSlug: 'framework' }
const empty = { roleId: null, roleCandidate: null, rolesFetched: true, categoryId: null, categoryName: null, categoryChannelCount: 0, channels: {}, tasks: [], takenNames: new Set() }

/** The archive divider as the observer reports it once it exists, in the category. */
const seenDivider = (parentId = 'c1') => ({ id: 'div', name: ARCHIVE_DIVIDER_NAME, parentId })

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
  assert.equal(SECTIONS.length, 13)
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
      ['support', 'support', 'text'],
      ['supportVoice', 'support-voice', 'voice'],
      ['casual', 'casual-chat', 'text'],
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

test('a fresh project creates the role, the category and all thirteen channels', () => {
  const plan = planProjectSection(project, empty)
  assert.equal(plan.role.action, 'create')
  assert.equal(plan.role.name, 'Framework')
  assert.equal(plan.category.action, 'create')
  assert.equal(plan.channels.length, 13)
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
      // No status at all is live, so it belongs above the divider.
      archived: false,
    },
  ])
})

test('a task already right plans none', () => {
  // "Already right" is the section category again: a ticket's parent is the
  // project's own category, and only its ORDER says whether it is finished.
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

test('every channel this plan brings into the category takes a ticket slot, the divider included', () => {
  // Tickets share the section category with the thirteen section channels and
  // the divider again, so the room left for them is the cap minus everything
  // this plan is about to put in there.
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
  // 13 section channels arriving plus the divider being created leaves 35 slots
  // of the 49; the other 5 tickets keep a readable name where they stand.
  assert.equal(plan.divider.action, 'create')
  assert.equal(plan.tasks.filter((t) => t.action === 'both').length, 35)
  assert.equal(plan.tasks.filter((t) => t.action === 'rename').length, 5)
  assert.ok(plan.warnings.some((w) => /category cap/.test(w)))
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

test('projectFromChannel matches a ticket channel through its section category, not a leftover bucket', () => {
  // Ticket channels are parented to the section category again, so the category
  // id is the whole answer — and a leftover bucket id in `discordChannels` is
  // not one of the ways in any more.
  const projects = [
    { id: 'p1', name: 'Framework', discordCategoryId: 'c1', discordChannels: { bucketOpen: 'b-open' } },
    { id: 'p2', name: 'Badar', discordCategoryId: 'c2' },
  ]
  assert.equal(projectFromChannel(projects, { id: 'tc1', parentId: 'c1' }).id, 'p1')
  assert.equal(projectFromChannel(projects, { id: 'tc2', parentId: 'b-open' }), null)
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
  const { type = ChannelType.GuildText, parentId = null, fail = null, overwriteIds = null, overwrites = null, position = 0, rawPosition = 0, topic = null } = opts
  // `position` is discord.js's sorted index; `rawPosition` is the raw gateway
  // value `textChannelsOf` sorts a category's text channels by.
  const c = { id, name, type, parentId, position, rawPosition, topic, edits: [], sent: [], messages: { fetchPinned: async () => new Map() } }
  c.edit = async (o) => {
    c.edits.push(o)
    if (fail) throw new Error(fail)
    if (o.name !== undefined) c.name = o.name
    if (o.parent !== undefined) c.parentId = o.parent
    if (o.position !== undefined) c.position = o.position
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
      cache: new Map(channels.map((c, i) => [c.id, Object.assign(c, { rawPosition: c.rawPosition ?? i })])),
      calls: [],
      // Every reorder this feature makes goes through one of these.
      positions: [],
      async setPositions(list) {
        guild.channels.positions.push(list)
        return undefined
      },
      async create(opts) {
        guild.channels.calls.push(opts)
        if (createFails && createFails(opts)) throw new Error('Missing Permissions')
        const made = fakeChannel(`new-${guild.channels.calls.length}`, opts.name, {
          type: opts.type,
          parentId: opts.parent ?? null,
          topic: opts.topic ?? null,
          // Discord puts a new channel last in its category.
          rawPosition: guild.channels.cache.size,
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
    // Unreadable bits are never "incomplete" either.
    roleAllowIncomplete: false,
    membersIncomplete: false,
  })
  assert.equal(observed.channels.documentation, undefined)
  assert.deepEqual(observed.tasks, [
    // A row with no status and no stamp reads as nulls: it files as open, and
    // the planner is free to stamp it if its status ever puts it in Done.
    { id: 't1', title: 'Git Sync', type: 'feature', channelId: 'tc1', channelName: 'feature-0145e3', parentId: 'FEATURES', status: null, retireAt: null, overwriteIds: null, roleAllowIncomplete: false, membersIncomplete: false },
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

test('a fresh section creates the role, the category with its two overwrites, and thirteen inheriting channels', async () => {
  const guild = fakeGuild()
  const db = fakeDb()
  const plan = planProjectSection(project, empty)

  const out = await applyProjectSection(guild, project, plan, { db })

  assert.equal(guild.roles.calls.length, 1)
  assert.equal(guild.roles.calls[0].name, 'Framework')

  // The category, then the thirteen channels, then the archive divider.
  const [catCall, ...rest] = guild.channels.calls
  const chCalls = rest.slice(0, 13)
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
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AddReactions,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
      PermissionFlagsBits.UseVAD,
      PermissionFlagsBits.Stream,
    ],
  })

  assert.equal(chCalls.length, 13)
  assert.ok(chCalls.every((c) => c.parent === 'new-1'), 'every section channel sits in the new category')
  assert.ok(chCalls.every((c) => c.permissionOverwrites === undefined), 'section channels inherit')
  assert.equal(chCalls[0].name, 'framework-members')
  assert.equal(chCalls[0].type, ChannelType.GuildText)
  assert.equal(chCalls[3].name, 'framework-meeting-voice')
  assert.equal(chCalls[3].type, ChannelType.GuildVoice)
  // The category, the thirteen section channels and the archive divider.
  assert.equal(out.created.length, 15)
  assert.equal(guild.channels.calls.at(-1).name, ARCHIVE_DIVIDER_NAME)
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
  // Into the section category itself — a ticket's parent is the project's
  // category again, and only its order says whether it is finished.
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
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.UseVAD,
  PermissionFlagsBits.Stream,
]

/** `ALLOW` as one bitfield: a role overwrite the text repair has nothing to add to. */
const ROLE_FULL = ALLOW.reduce((a, b) => a | b, 0n)
/** The six text bits: a member overwrite the text repair has nothing to add to. */
const TEXT_SIX = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
].reduce((a, b) => a | b, 0n)

/** A task channel as /create-task makes it: @everyone denied, its assignee allowed. */
function ticketChannel(id, name, parentId, extra = []) {
  const ch = fakeChannel(id, name, {
    parentId,
    overwrites: [
      { id: 'G1', type: OverwriteType.Role, allow: 0n, deny: PermissionFlagsBits.ViewChannel },
      { id: 'assignee', type: OverwriteType.Member, allow: TEXT_SIX, deny: 0n },
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
  assert.equal(byId.get('assignee').allow, TEXT_SIX)
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
    divider: { action: 'reuse', id: 'div', name: ARCHIVE_DIVIDER_NAME },
    channels: [],
    tasks: [{ taskId: 't1', channelId: 'tc1', action: 'both', archived: false, name: 'feature-git-sync', topic: 'Feature: Git Sync — Task t1' }],
    warnings: [],
  }
  await quiet(() => applyProjectSection(guild, { ...project, discordCategoryId: 'c1' }, plan, { db: fakeDb() }))
  assert.equal(taskCh.edits.length, 1)
  assert.deepEqual(taskCh.edits[0], { name: 'feature-git-sync', parent: 'c1', topic: 'Feature: Git Sync — Task t1' })
})

test('a backfill move is parent-only: the name and topic it already has are not rewritten', async () => {
  // The planner only chooses `move` when the name is already right, so sending
  // it back re-writes what was just read. The live mover's edit is parent-only
  // for the same reason; the allow still rides along when one is due.
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'FEATURES')
  const guild = fakeGuild({ channels: [cat, taskCh] })
  const plan = {
    role: { action: 'reuse', id: 'gone', name: 'Framework' },
    category: { action: 'reuse', id: 'c1', name: '📂 FRAMEWORK' },
    divider: { action: 'reuse', id: 'div', name: ARCHIVE_DIVIDER_NAME },
    channels: [],
    tasks: [{ taskId: 't1', channelId: 'tc1', action: 'move', archived: false, name: 'feature-git-sync', topic: 'Feature: Git Sync — Task t1' }],
    warnings: [],
  }
  await quiet(() => applyProjectSection(guild, { ...project, discordCategoryId: 'c1' }, plan, { db: fakeDb() }))
  assert.deepEqual(taskCh.edits, [{ parent: 'c1' }])
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
  // "Placed" is the section category: a ticket's parent is the project's own.
  // "Open" is the full allow: a role entry short of a text bit is upgraded.
  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'c1', [
    { id: 'r1', type: OverwriteType.Role, allow: ROLE_FULL, deny: 0n },
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
  // Opened while the project's role id was stale: in place, but no allow.
  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'c1')
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const guild = fakeGuild({ channels: [cat, taskCh], roles: [role] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Git Sync', type: 'feature', discordChannelId: 'tc1' },
  ])
  const plan = planProjectSection(stored, observed)
  assert.equal(plan.tasks[0].action, 'grant')
  assert.equal(plan.tasks[0].archived, false)

  // The ticket stays where it is and the applier only opens it to the role.
  const out = await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  assert.equal(taskCh.parentId, 'c1')
  assert.equal(taskCh.edits.length, 1)
  const edit = taskCh.edits[0]
  // Nothing but the overwrites: the name and the parent are already right.
  assert.deepEqual(Object.keys(edit), ['permissionOverwrites'])
  assert.deepEqual(edit.permissionOverwrites.map((o) => o.id).sort(), ['G1', 'assignee', 'r1'])
  assert.deepEqual(out.granted, ['feature-git-sync'])
  assert.equal(out.tasks, 1)
})

test('the planner never plans a grant for a refused role or an unreadable channel', () => {
  // Already named and inside the category, so the only question left is the role.
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
  assert.equal(
    guild.channels.calls.filter((c) => c.type !== ChannelType.GuildCategory).length,
    13,
    'the other twelve section channels, and the archive divider, were still created'
  )
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
  // Thirteen section channels plus the archive divider, one map, one write.
  assert.equal(Object.keys(data.discordChannels).length, 14)
  assert.equal(data.discordChannels[ARCHIVE_STORE_KEY], 'new-13')
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

  // new-1 is the category, new-2 is #…-members, and the divider comes last.
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

  // The category, the thirteen section channels and the archive divider.
  assert.equal(out.created.length, 15)
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
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AddReactions,
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

  // new-1 is the category, new-2 is #…-members, and the divider comes last.
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

  assert.equal(out.created.length, 15, 'the section and its divider are still built')
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

test('a refused same-named role builds the section shut, and a later adopt_role repairs all thirteen', async () => {
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
  const sectionIds = Object.entries(saved.discordChannels)
    .filter(([key]) => key !== ARCHIVE_STORE_KEY)
    .map(([, id]) => id)
  const dividerId = saved.discordChannels[ARCHIVE_STORE_KEY]
  for (const id of [...sectionIds, dividerId]) {
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
  assert.equal(plan2.channels.filter((c) => c.action === 'grant').length, 13)

  const out = await applyProjectSection(guild, stored, plan2, { db: fakeDb() })

  assert.equal(out.granted.length, 14, 'every section channel was repaired, and the divider with them')
  for (const id of sectionIds) {
    const made = guild.channels.cache.get(id)
    assert.equal(made.edits.length, 1, `${made.name} took more than one edit`)
    const ids = made.edits[0].permissionOverwrites.map((o) => o.id)
    assert.ok(ids.includes('r9'), `${made.name} still cannot be seen`)
    assert.ok(ids.includes('G1'), `${made.name} lost its @everyone deny`)
  }
  // The divider was built shut too, and the same adoption reopens it — one
  // overwrites-only edit built from the READ-ONLY set, never `ROLE_ALLOW`: the
  // role may see the line, not write in it.
  const made = guild.channels.cache.get(dividerId)
  assert.equal(made.edits.length, 1)
  assert.deepEqual(Object.keys(made.edits[0]), ['permissionOverwrites'])
  const entry = made.edits[0].permissionOverwrites.find((ow) => ow.id === 'r9')
  assert.deepEqual(entry.allow, DIVIDER_ROLE_ALLOW)
  assert.deepEqual(entry.deny, DIVIDER_ROLE_DENY)
  assert.ok(made.edits[0].permissionOverwrites.some((ow) => ow.id === 'G1'), 'the @everyone deny is kept')
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
  // The project's own entry already carries the full allow, so the only
  // thing a run could do to this category is the thing it must not.
  const mine = { id: 'r1', type: OverwriteType.Role, allow: ROLE_FULL, deny: 0n }
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


// ---- the archive divider ---------------------------------------------------
const staleCat = (id, name) => fakeChannel(id, name, { type: ChannelType.GuildCategory })
const withDivider = (p, over = {}) => ({
  ...p,
  discordCategoryId: 'c1',
  discordChannels: { ...(p.discordChannels ?? {}), [ARCHIVE_STORE_KEY]: 'div', ...over },
})

test('observe finds the divider by stored id, else by exact name in this category, never one another project claims', () => {
  const guild = fakeGuild({
    channels: [
      fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory }),
      fakeChannel('div', 'renamed-by-hand', { parentId: 'c1' }),
    ],
  })
  const observed = observeProjectSection(guild, withDivider(project), [])
  assert.deepEqual(observed.divider, { id: 'div', name: 'renamed-by-hand', parentId: 'c1' })

  // No stored id: the exact name, inside this category, unclaimed.
  const byName = fakeGuild({
    channels: [
      fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory }),
      fakeChannel('found', ARCHIVE_DIVIDER_NAME, { parentId: 'c1' }),
      fakeChannel('elsewhere', ARCHIVE_DIVIDER_NAME, { parentId: 'OTHER' }),
    ],
  })
  const bare = { ...project, discordCategoryId: 'c1' }
  assert.equal(observeProjectSection(byName, bare, []).divider.id, 'found')
  assert.equal(observeProjectSection(byName, bare, [], { claimedIds: new Set(['found']) }).divider, null)
})

test('observe: a stored divider id that is not a text channel is treated as missing', () => {
  const guild = fakeGuild({ channels: [fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory }), staleCat('div', 'oops')] })
  assert.equal(observeProjectSection(guild, withDivider(project), []).divider, null)
})

test("observe carries each ticket's status and stamp", () => {
  const guild = fakeGuild({ channels: [ticketChannel('tc1', 'feature-x', 'c1')] })
  const stamp = new Date('2026-10-01T00:00:00Z')
  const observed = observeProjectSection(guild, withDivider(project), [
    { id: 't1', title: 'X', type: 'feature', status: 'done', discordChannelId: 'tc1', channelRetireAt: stamp },
  ])
  assert.equal(observed.tasks[0].status, 'done')
  assert.equal(observed.tasks[0].retireAt, stamp)
})

test('observe reports a leftover status-bucket category that still resolves, and ignores one that does not', () => {
  const guild = fakeGuild({
    channels: [
      fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory }),
      staleCat('b-open', '📂 FRAMEWORK · OPEN'),
      fakeChannel('t1', 'feature-x', { parentId: 'b-open' }),
      // A stored bucket id that is now a text channel is not a leftover category.
      fakeChannel('b-done', 'someone-reused-the-id'),
    ],
  })
  const stored = { ...project, discordCategoryId: 'c1', discordChannels: { bucketOpen: 'b-open', bucketInProgress: 'gone', bucketDone: 'b-done' } }
  assert.deepEqual(observeProjectSection(guild, stored, []).staleBuckets, [
    { id: 'b-open', name: '📂 FRAMEWORK · OPEN', channelCount: 1 },
  ])
})

test('plan: the divider is created, reused, renamed or moved exactly like a section channel', () => {
  const base = { categoryId: 'c1', categoryName: '📂 FRAMEWORK' }
  assert.deepEqual(planProjectSection(project, base).divider, { action: 'create', name: ARCHIVE_DIVIDER_NAME })
  assert.deepEqual(
    planProjectSection(project, { ...base, divider: seenDivider() }).divider,
    { action: 'reuse', id: 'div', name: ARCHIVE_DIVIDER_NAME }
  )
  assert.deepEqual(
    planProjectSection(project, { ...base, divider: { id: 'div', name: 'renamed-by-hand', parentId: 'c1' } }).divider,
    { action: 'rename', id: 'div', name: ARCHIVE_DIVIDER_NAME }
  )
  assert.deepEqual(
    planProjectSection(project, { ...base, divider: { id: 'div', name: ARCHIVE_DIVIDER_NAME, parentId: 'ELSEWHERE' } }).divider,
    { action: 'move', id: 'div', name: ARCHIVE_DIVIDER_NAME }
  )
})

test('plan: every ticket files into the section category, and `archived` says which side of the line it lands on', () => {
  const observed = {
    categoryId: 'c1', categoryName: '📂 FRAMEWORK', categoryChannelCount: 15, divider: seenDivider(),
    tasks: [
      { id: 't1', title: 'Git Sync', type: 'feature', status: 'open', channelId: 'tc1', channelName: 'feature-git-sync', parentId: 'b-open' },
      { id: 't2', title: 'Login', type: 'bug', status: 'in_progress', channelId: 'tc2', channelName: 'bug-login', parentId: 'c1' },
      { id: 't3', title: 'Old', type: 'feature', status: 'done', channelId: 'tc3', channelName: 'feature-old', parentId: 'c1', retireAt: null },
      { id: 't4', title: 'Older', type: 'feature', status: 'closed', channelId: 'tc4', channelName: 'feature-older', parentId: 'c1', retireAt: new Date() },
    ],
    takenNames: new Set(),
  }
  const plan = planProjectSection(project, observed)
  const byId = Object.fromEntries(plan.tasks.map((t) => [t.taskId, t]))
  // Pulled back out of a leftover bucket by an ordinary move.
  assert.equal(byId.t1.action, 'move'); assert.equal(byId.t1.archived, false)
  assert.equal(byId.t2.action, 'none'); assert.equal(byId.t2.archived, false)
  assert.equal(byId.t3.action, 'none'); assert.equal(byId.t3.archived, true); assert.equal(byId.t3.retire, true)
  // Already stamped: the fourteen days must not restart on every run.
  assert.equal(byId.t4.action, 'none'); assert.equal(byId.t4.archived, true); assert.equal(byId.t4.retire, undefined)
})

test('plan: a stale bucket this run empties is named, one this run only half-empties is not', () => {
  const observed = (channelCount) => ({
    categoryId: 'c1', categoryName: '📂 FRAMEWORK', divider: seenDivider(),
    staleBuckets: [{ id: 'b-open', name: '📂 FRAMEWORK · OPEN', channelCount }],
    tasks: [{ id: 't1', title: 'Git Sync', type: 'feature', status: 'open', channelId: 'tc1', channelName: 'feature-git-sync', parentId: 'b-open' }],
    takenNames: new Set(),
  })
  const emptied = planProjectSection(project, observed(1))
  assert.ok(emptied.warnings.some((w) => /📂 FRAMEWORK · OPEN.*leftover from the old layout/.test(w)))
  assert.ok(emptied.warnings.some((w) => /never deletes a category/.test(w)))
  // A hand-made channel is still in there: not safe to delete, so not named.
  assert.deepEqual(planProjectSection(project, observed(2)).warnings, [])
})

test('a ticket left behind by the category cap is never reported as opened to the role', () => {
  // Dropped to `rename` by the cap, and a rename that lands nowhere new opens
  // the channel to nobody — saying otherwise would be a permission change the
  // run never made.
  const task = { id: 't1', title: 'Git Sync', type: 'feature', status: 'open', channelId: 'tc1', channelName: 'feature-0145e3', parentId: 'FEATURES', overwriteIds: ['G1'] }
  const plan = planProjectSection(project, { ...empty, roleId: 'r1', categoryId: 'c1', categoryName: '📂 FRAMEWORK', categoryChannelCount: 49, tasks: [task] })
  assert.equal(plan.tasks[0].action, 'rename')
  assert.equal(plan.tasks[0].opens, undefined)
})

// --- The applier: the divider, filing, ordering and retirement ---------------

test('apply creates the divider after the section channels, read-only for the project role, and stores its id', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const guild = fakeGuild({ roles: [role] })
  const db = fakeDb()
  const plan = planProjectSection(project, { roleId: 'r1', rolesFetched: true })
  const result = await applyProjectSection(guild, { ...project, discordRoleId: 'r1' }, plan, { db })

  const call = guild.channels.calls.at(-1)
  assert.equal(call.name, ARCHIVE_DIVIDER_NAME)
  assert.equal(call.type, ChannelType.GuildText)
  assert.equal(call.parent, 'new-1')
  assert.equal(call.topic, ARCHIVE_DIVIDER_TOPIC)
  // @everyone denied as everywhere in the section; the role may read the line
  // and nothing else. Every entry carries an explicit type.
  assert.deepEqual(call.permissionOverwrites, [
    { id: 'G1', type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: 'r1', type: OverwriteType.Role, allow: DIVIDER_ROLE_ALLOW, deny: DIVIDER_ROLE_DENY },
  ])
  // "Read-only" is the whole posting surface, not just SendMessages: a reaction
  // or a thread started on the line is a post too, and a thread under it would
  // sit in the sidebar between the live tickets and the archived ones.
  assert.deepEqual(DIVIDER_ROLE_ALLOW, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])
  assert.deepEqual(DIVIDER_ROLE_DENY, [
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.CreatePublicThreads,
    PermissionFlagsBits.CreatePrivateThreads,
    PermissionFlagsBits.AddReactions,
  ])
  assert.ok(result.created.includes(ARCHIVE_DIVIDER_NAME))
  // new-1 is the category, new-2..new-14 the thirteen channels, new-15 the line.
  assert.equal(db.calls[0].data.discordChannels[ARCHIVE_STORE_KEY], 'new-15')
})

test('apply repairs a divider found under an old name or in the wrong category in ONE edit', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const div = fakeChannel('div', 'old-line', { parentId: 'ELSEWHERE', overwriteIds: ['G1', 'r1'] })
  const guild = fakeGuild({ channels: [cat, div], roles: [role] })
  const stored = { ...withDivider(project), discordRoleId: 'r1' }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, [], { rolesFetched: true }))
  const result = await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  assert.equal(div.edits.length, 1)
  // The topic rides in the same edit: a divider with the wrong topic tells a
  // reader nothing, and is one step away from looking like a ticket.
  assert.deepEqual(div.edits[0], { name: ARCHIVE_DIVIDER_NAME, parent: 'c1', topic: ARCHIVE_DIVIDER_TOPIC })
  assert.deepEqual(result.moved, [ARCHIVE_DIVIDER_NAME])
})

test('a grant on the divider builds from the READ-ONLY set, never ROLE_ALLOW', async () => {
  // The one repair that could hand the project role SendMessages on the one
  // channel in the section that must never take a message.
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const div = fakeChannel('div', ARCHIVE_DIVIDER_NAME, { parentId: 'c1', topic: ARCHIVE_DIVIDER_TOPIC, overwriteIds: ['G1'] })
  const guild = fakeGuild({ channels: [cat, div], roles: [role] })
  const stored = { ...withDivider(project), discordRoleId: 'r1' }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, [], { rolesFetched: true }))
  assert.equal(plan.divider.action, 'reuse')
  const result = await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  // Nothing but the overwrites: the name, the parent and the topic are right.
  assert.equal(div.edits.length, 1)
  assert.deepEqual(Object.keys(div.edits[0]), ['permissionOverwrites'])
  const entry = div.edits[0].permissionOverwrites.find((o) => o.id === 'r1')
  assert.deepEqual(entry.allow, DIVIDER_ROLE_ALLOW)
  assert.deepEqual(entry.deny, DIVIDER_ROLE_DENY)
  assert.deepEqual(result.granted, [ARCHIVE_DIVIDER_NAME])
})

test('a divider whose repair edit is refused is one warning; the tickets are still filed and ordered', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const div = fakeChannel('div', 'old-line', { parentId: 'c1', overwriteIds: ['G1', 'r1'], fail: 'Missing Permissions', rawPosition: 1 })
  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'FEATURES')
  const guild = fakeGuild({ channels: [cat, div, taskCh], roles: [role] })
  const stored = { ...withDivider(project), discordRoleId: 'r1' }
  const observed = observeProjectSection(guild, stored, [{ id: 't1', title: 'Git Sync', type: 'feature', status: 'open', discordChannelId: 'tc1' }], { rolesFetched: true })
  const result = await quiet(() => applyProjectSection(guild, stored, planProjectSection(stored, observed), { db: fakeDb() }))
  assert.ok(result.warnings.some((w) => w.startsWith(`archive divider "${ARCHIVE_DIVIDER_NAME}": Missing Permissions`)))
  assert.equal(taskCh.edits.at(-1).parent, 'c1')
  assert.deepEqual(result.moved, ['feature-git-sync'])
  // The line is still the line: the reorder ran around it anyway.
  assert.equal(result.reordered, true)
})

/**
 * The thirteen section channels already in place, so a run creates none of them
 * and the only text channels in the category are the ones a test put there.
 * `rawPosition` counts up from 1, leaving room for later arrivals.
 */
function seededSection() {
  const channels = []
  const ids = {}
  SECTIONS.forEach((sec, i) => {
    const id = `sec${i}`
    ids[sec.key] = id
    channels.push(
      fakeChannel(id, channelNameFor(project, sec.suffix), {
        parentId: 'c1',
        type: sec.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
        overwriteIds: ['G1', 'r1'],
        rawPosition: i + 1,
      })
    )
  })
  return { channels, ids, textIds: SECTIONS.filter((sec) => sec.type !== 'voice').map((sec) => ids[sec.key]) }
}

test('apply orders the category once: live tickets above the line, finished ones below it', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const section = seededSection()
  // The line sits above both tickets today, so both are on the wrong side of it.
  const div = fakeChannel('div', ARCHIVE_DIVIDER_NAME, { parentId: 'c1', overwriteIds: ['G1', 'r1'], rawPosition: 20 })
  const ROLE_SEEN = [{ id: 'r1', type: OverwriteType.Role, allow: PermissionFlagsBits.ViewChannel, deny: 0n }]
  const doneCh = ticketChannel('tc1', 'feature-old', 'c1', ROLE_SEEN)
  doneCh.rawPosition = 21
  const liveCh = ticketChannel('tc2', 'feature-new', 'c1', ROLE_SEEN)
  liveCh.rawPosition = 22
  const guild = fakeGuild({ channels: [cat, ...section.channels, div, doneCh, liveCh], roles: [role] })
  const stored = { ...withDivider(project, section.ids), discordRoleId: 'r1' }
  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Old', type: 'feature', status: 'done', discordChannelId: 'tc1', channelRetireAt: new Date() },
    { id: 't2', title: 'New', type: 'feature', status: 'open', discordChannelId: 'tc2' },
  ], { rolesFetched: true })
  const plan = planProjectSection(stored, observed)
  const result = await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  assert.equal(guild.channels.positions.length, 1, 'exactly one setPositions')
  // Section channels keep the top, then the live ticket, the line, the finished
  // one. Voice channels are never in the list: Discord renders them below every
  // text channel whatever their position says.
  assert.deepEqual(
    guild.channels.positions[0].map((e) => e.channel),
    [...section.textIds, 'tc2', 'div', 'tc1']
  )
  assert.deepEqual(guild.channels.positions[0].map((e) => e.position), section.textIds.map((_, i) => i).concat([section.textIds.length, section.textIds.length + 1, section.textIds.length + 2]))
  assert.equal(result.reordered, true)
})

test('apply sends no reorder at all when the order is already right, and one refusal is a warning', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const ROLE_SEEN = [{ id: 'r1', type: OverwriteType.Role, allow: PermissionFlagsBits.ViewChannel, deny: 0n }]

  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const section = seededSection()
  const stored = { ...withDivider(project, section.ids), discordRoleId: 'r1' }
  const div = fakeChannel('div', ARCHIVE_DIVIDER_NAME, { parentId: 'c1', overwriteIds: ['G1', 'r1'], rawPosition: 20 })
  const doneCh = ticketChannel('tc1', 'feature-old', 'c1', ROLE_SEEN)
  doneCh.rawPosition = 21
  const guild = fakeGuild({ channels: [cat, ...section.channels, div, doneCh], roles: [role] })
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, [
    { id: 't1', title: 'Old', type: 'feature', status: 'done', discordChannelId: 'tc1', channelRetireAt: new Date() },
  ], { rolesFetched: true }))
  const ok = await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  assert.deepEqual(guild.channels.positions, [])
  assert.equal(ok.reordered, false)

  const cat2 = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const section2 = seededSection()
  const div2 = fakeChannel('div', ARCHIVE_DIVIDER_NAME, { parentId: 'c1', overwriteIds: ['G1', 'r1'], rawPosition: 20 })
  const live = ticketChannel('tc9', 'feature-live', 'c1', ROLE_SEEN)
  live.rawPosition = 21
  const refusing = fakeGuild({ channels: [cat2, ...section2.channels, div2, live], roles: [role] })
  refusing.channels.setPositions = async () => { throw new Error('Missing Permissions') }
  const plan2 = planProjectSection(stored, observeProjectSection(refusing, stored, [
    { id: 't9', title: 'Live', type: 'feature', status: 'open', discordChannelId: 'tc9' },
  ], { rolesFetched: true }))
  const bad = await quiet(() => applyProjectSection(refusing, stored, plan2, { db: fakeDb() }))
  assert.equal(bad.reordered, false)
  assert.ok(bad.warnings.some((w) => /ordering the channels of "Framework": Missing Permissions/.test(w)))
})

test('apply retires a finished ticket that has no stamp — from THIS run, through the seam — and counts it', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskCh = ticketChannel('tc1', 'feature-old', 'c1')
  const guild = fakeGuild({ channels: [cat, taskCh], roles: [role] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Old', type: 'feature', status: 'done', discordChannelId: 'tc1', channelRetireAt: null },
  ], { rolesFetched: true })
  const plan = planProjectSection(stored, observed)
  const retired = []
  const db = { ...fakeDb(), task: { update: async () => {} } }
  const NOW = new Date('2026-09-25T00:00:00Z')
  const result = await applyProjectSection(guild, stored, plan, {
    db,
    now: () => NOW,
    retire: async (a) => { retired.push([a.task.id, a.channel?.id, a.db === db, a.now()]) },
  })
  assert.deepEqual(retired, [['t1', 'tc1', true, NOW]])
  assert.equal(result.retired, 1)
})

test('apply: without a database, finished tickets are not stamped and the reply says so', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskCh = ticketChannel('tc1', 'feature-old', 'c1')
  const guild = fakeGuild({ channels: [cat, taskCh] })
  const stored = { ...project, discordCategoryId: 'c1' }
  const observed = observeProjectSection(guild, stored, [{ id: 't1', title: 'Old', type: 'feature', status: 'done', discordChannelId: 'tc1' }])
  const plan = planProjectSection(stored, observed)
  let called = 0
  const result = await applyProjectSection(guild, stored, plan, { retire: async () => { called += 1 } })
  assert.equal(called, 0)
  assert.equal(result.retired, 0)
  assert.ok(result.warnings.some((w) => /not stamped for removal/.test(w)))
})

test('apply drops the three bucket* keys from the stored map without touching the categories', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const openBucket = staleCat('b-open', '📂 FRAMEWORK · OPEN')
  const guild = fakeGuild({ channels: [cat, openBucket], roles: [role] })
  const db = fakeDb()
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1', discordChannels: { bucketOpen: 'b-open', bucketInProgress: 'b-prog', bucketDone: 'b-done' } }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, [], { rolesFetched: true }))
  await applyProjectSection(guild, stored, plan, { db })
  const saved = db.calls[0].data.discordChannels
  assert.deepEqual(Object.keys(saved).filter((k) => k.startsWith('bucket')), [])
  assert.ok(saved[ARCHIVE_STORE_KEY], 'the divider it just made is recorded instead')
  // Nothing deleted the leftover category, and nothing edited it either.
  assert.ok(guild.channels.cache.has('b-open'))
  assert.deepEqual(openBucket.edits, [])
})

const DENY_BITS = DIVIDER_ROLE_DENY.reduce((a, b) => a | b, 0n)
const ALLOW_BITS = DIVIDER_ROLE_ALLOW.reduce((a, b) => a | b, 0n)

/** A divider already in place, with whatever the project role currently holds on it. */
function dividerWith(roleOverwrite, { topic = ARCHIVE_DIVIDER_TOPIC } = {}) {
  return fakeChannel('div', ARCHIVE_DIVIDER_NAME, {
    parentId: 'c1',
    topic,
    rawPosition: 20,
    overwrites: [
      { id: 'G1', type: OverwriteType.Role, allow: 0n, deny: PermissionFlagsBits.ViewChannel },
      ...(roleOverwrite ? [{ id: 'r1', type: OverwriteType.Role, ...roleOverwrite }] : []),
    ],
  })
}

async function runDividerRepair(div) {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const section = seededSection()
  const guild = fakeGuild({ channels: [cat, ...section.channels, div], roles: [role] })
  const stored = { ...withDivider(project, section.ids), discordRoleId: 'r1' }
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, [], { rolesFetched: true }))
  assert.equal(plan.divider.action, 'reuse')
  return applyProjectSection(guild, stored, plan, { db: fakeDb() })
}

test('a divider the project role can post in is repaired: the deny comes back, merged, in one edit', async () => {
  // How it happens in practice: somebody clicks "Sync Now" on the category in
  // the Discord client, which copies the category's own overwrite — ROLE_ALLOW,
  // SendMessages included — onto every child. The role's overwrite is then
  // still PRESENT, so a presence-only check sees nothing wrong and the line
  // silently becomes a chat channel forever.
  const div = dividerWith({ allow: ALLOW_BITS | PermissionFlagsBits.SendMessages, deny: 0n })
  const result = await runDividerRepair(div)
  assert.equal(div.edits.length, 1)
  assert.deepEqual(Object.keys(div.edits[0]), ['permissionOverwrites'])
  const entry = div.edits[0].permissionOverwrites.find((o) => o.id === 'r1')
  assert.deepEqual(entry.allow, DIVIDER_ROLE_ALLOW)
  assert.deepEqual(entry.deny, DIVIDER_ROLE_DENY)
  // Merged, never replaced: the @everyone deny the section depends on is kept.
  assert.ok(div.edits[0].permissionOverwrites.some((o) => o.id === 'G1'))
  assert.deepEqual(result.granted, [ARCHIVE_DIVIDER_NAME])
})

test('a divider missing only one bit of the deny set is still repaired', async () => {
  // AddReactions alone left open is enough: a row of reactions on the line is
  // content on a channel that is supposed to carry none.
  const div = dividerWith({ allow: ALLOW_BITS, deny: DENY_BITS & ~PermissionFlagsBits.AddReactions })
  const result = await runDividerRepair(div)
  assert.equal(div.edits.length, 1)
  assert.deepEqual(result.granted, [ARCHIVE_DIVIDER_NAME])
})

test('a divider that is already read-only gets no edit at all', async () => {
  const div = dividerWith({ allow: ALLOW_BITS, deny: DENY_BITS })
  const result = await runDividerRepair(div)
  assert.deepEqual(div.edits, [])
  assert.deepEqual(result.granted, [])
})

test('a divider whose overwrite bits cannot be read is left alone, never rewritten every run', async () => {
  // The same rule the rest of this file follows: an overwrite that cannot be
  // inspected is not guessed at. `overwriteIds` builds entries with no bits.
  const div = fakeChannel('div', ARCHIVE_DIVIDER_NAME, {
    parentId: 'c1', topic: ARCHIVE_DIVIDER_TOPIC, rawPosition: 20, overwriteIds: ['G1', 'r1'],
  })
  const result = await runDividerRepair(div)
  assert.deepEqual(div.edits, [])
  assert.deepEqual(result.granted, [])
})

test('a reused divider whose topic was cleared by hand gets the topic back in its one edit', async () => {
  const div = dividerWith({ allow: ALLOW_BITS, deny: DENY_BITS }, { topic: null })
  const result = await runDividerRepair(div)
  assert.equal(div.edits.length, 1)
  assert.deepEqual(div.edits[0], { topic: ARCHIVE_DIVIDER_TOPIC })
  // Only the topic changed, so it is neither a grant nor a rename.
  assert.deepEqual(result.granted, [])
  assert.deepEqual(result.renamed, [])
})

test('a reused divider needing both the topic and the deny gets ONE edit carrying both', async () => {
  const div = dividerWith({ allow: ALLOW_BITS | PermissionFlagsBits.SendMessages, deny: 0n }, { topic: 'something else' })
  await runDividerRepair(div)
  assert.equal(div.edits.length, 1)
  assert.deepEqual(Object.keys(div.edits[0]).sort(), ['permissionOverwrites', 'topic'])
  assert.equal(div.edits[0].topic, ARCHIVE_DIVIDER_TOPIC)
})

test('a ticket channel with no plan entry keeps whichever side of the line it is on', async () => {
  // Several real channels have no plan entry: one past TASK_LIMIT, one two task
  // rows point at, one whose row was deleted. Sorting those to the live side
  // put a locked, retired channel back above the divider on every run.
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const section = seededSection()
  const above = ticketChannel('orphan-live', 'feature-orphan-live', 'c1')
  above.rawPosition = 20
  const div = dividerWith({ allow: ALLOW_BITS, deny: DENY_BITS })
  const below = ticketChannel('orphan-done', 'feature-orphan-done', 'c1')
  below.rawPosition = 21
  const guild = fakeGuild({ channels: [cat, ...section.channels, above, div, below], roles: [role] })
  const stored = { ...withDivider(project, section.ids), discordRoleId: 'r1' }
  // No tasks at all: neither ticket has a plan entry.
  const plan = planProjectSection(stored, observeProjectSection(guild, stored, [], { rolesFetched: true }))
  assert.deepEqual(plan.tasks, [])
  const result = await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  assert.equal(result.reordered, false, 'nothing to change, so no request is spent')
  assert.deepEqual(guild.channels.positions, [])
})

test('an unplanned ticket below the line stays below even when the order has to change', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const section = seededSection()
  const div = dividerWith({ allow: ALLOW_BITS, deny: DENY_BITS })
  const orphan = ticketChannel('orphan-done', 'feature-orphan-done', 'c1')
  orphan.rawPosition = 21
  // A planned, live ticket sitting below the line is what forces the reorder.
  const planned = ticketChannel('tc1', 'feature-live', 'c1', [
    { id: 'r1', type: OverwriteType.Role, allow: PermissionFlagsBits.ViewChannel, deny: 0n },
  ])
  planned.rawPosition = 22
  const guild = fakeGuild({ channels: [cat, ...section.channels, div, orphan, planned], roles: [role] })
  const stored = { ...withDivider(project, section.ids), discordRoleId: 'r1' }
  const plan = planProjectSection(
    stored,
    observeProjectSection(guild, stored, [{ id: 't1', title: 'Live', type: 'feature', status: 'open', discordChannelId: 'tc1' }], { rolesFetched: true })
  )
  const result = await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  assert.equal(result.reordered, true)
  assert.deepEqual(
    guild.channels.positions[0].map((e) => e.channel),
    [...section.textIds, 'tc1', 'div', 'orphan-done']
  )
})

// ---- the six-bit text allow: bit-aware repair of what the bot owns ----------
// An overwrite the bot owns whose allow lacks a text bit gets the missing bits
// OR-ed in; its deny is kept; nothing is removed. Everything else stays
// presence-only, and the divider never gains SendMessages or AddReactions.

const P = PermissionFlagsBits
const OLD_TEXT = P.ViewChannel | P.SendMessages | P.ReadMessageHistory
const NEW_TEXT = P.AttachFiles | P.EmbedLinks | P.AddReactions
const SIX = OLD_TEXT | NEW_TEXT
const VOICE4 = P.Connect | P.Speak | P.UseVAD | P.Stream
const bitsIn = (v) => (Array.isArray(v) ? v.reduce((a, b) => a | b, 0n) : BigInt(v ?? 0n))

/**
 * A whole section, category and divider in place, every channel carrying the
 * given role overwrite (bits), so a test only varies what it is about.
 */
function sixBitSection({ catRole, secRole, extraOn = {}, tasks = [] } = {}) {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const everyone = { id: 'G1', type: OverwriteType.Role, allow: 0n, deny: P.ViewChannel }
  const roleOw = (bits) => ({ id: 'r1', type: OverwriteType.Role, allow: bits.allow, deny: bits.deny ?? 0n })
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwrites: [everyone, roleOw(catRole)] })
  const ids = {}
  const channels = SECTIONS.map((sec, i) => {
    const id = `sec${i}`
    ids[sec.key] = id
    return fakeChannel(id, channelNameFor(project, sec.suffix), {
      parentId: 'c1',
      type: sec.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
      overwrites: [everyone, roleOw(secRole), ...(extraOn[sec.key] ?? [])],
      rawPosition: i + 1,
    })
  })
  const div = dividerWith({ allow: ALLOW_BITS, deny: DENY_BITS })
  const guild = fakeGuild({ channels: [cat, ...channels, ...tasks, div], roles: [role] })
  const stored = { ...withDivider(project, ids), discordRoleId: 'r1' }
  return { guild, stored, cat, channels, ids, div }
}

const oldRole = { allow: OLD_TEXT | VOICE4 }
const newRole = { allow: SIX | VOICE4 }

test('a section channel whose role overwrite has the old three bits is planned grant; the edit carries all six and the old deny', async () => {
  const s = sixBitSection({ catRole: newRole, secRole: newRole })
  // One section channel carries the old allow plus a deny an admin set by hand.
  const members = s.channels[0]
  members.permissionOverwrites.cache.set('r1', { id: 'r1', type: OverwriteType.Role, allow: OLD_TEXT | VOICE4, deny: P.CreatePublicThreads })
  const observed = observeProjectSection(s.guild, s.stored, [], { rolesFetched: true })
  assert.equal(observed.channels.members.roleAllowIncomplete, true)
  assert.equal(observed.channels.members.membersIncomplete, false)
  assert.equal(observed.channels.documentation.roleAllowIncomplete, false)
  const plan = planProjectSection(s.stored, observed)
  assert.equal(plan.channels.find((c) => c.key === 'members').action, 'grant')
  assert.equal(plan.channels.find((c) => c.key === 'documentation').action, 'reuse')

  const result = await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  assert.equal(members.edits.length, 1)
  const entry = members.edits[0].permissionOverwrites.find((o) => o.id === 'r1')
  assert.equal(entry.type, OverwriteType.Role)
  assert.equal(bitsIn(entry.allow) & SIX, SIX, 'all six text bits allowed')
  assert.equal(bitsIn(entry.allow) & VOICE4, VOICE4, 'nothing it had is removed')
  assert.equal(bitsIn(entry.deny), P.CreatePublicThreads, 'the deny is kept exactly')
  assert.ok(members.edits[0].permissionOverwrites.some((o) => o.id === 'G1'), 'merged, never replaced')
  assert.deepEqual(result.granted, [members.name])
})

test('a task channel whose role and assignee entries carry three bits gets both upgraded in ONE edit', async () => {
  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'c1', [
    { id: 'r1', type: OverwriteType.Role, allow: OLD_TEXT, deny: 0n },
  ])
  taskCh.permissionOverwrites.cache.set('assignee', { id: 'assignee', type: OverwriteType.Member, allow: OLD_TEXT, deny: 0n })
  const s = sixBitSection({ catRole: newRole, secRole: newRole, tasks: [taskCh] })
  const observed = observeProjectSection(s.guild, s.stored, [{ id: 't1', title: 'Git Sync', type: 'feature', status: 'open', discordChannelId: 'tc1' }], { rolesFetched: true })
  assert.equal(observed.tasks[0].roleAllowIncomplete, true)
  assert.equal(observed.tasks[0].membersIncomplete, true)
  const plan = planProjectSection(s.stored, observed)
  assert.equal(plan.tasks[0].action, 'grant')

  await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  assert.equal(taskCh.edits.length, 1)
  const sent = taskCh.edits[0].permissionOverwrites
  const roleEntry = sent.find((o) => o.id === 'r1')
  const assignee = sent.find((o) => o.id === 'assignee')
  assert.equal(bitsIn(roleEntry.allow) & SIX, SIX)
  assert.equal(assignee.type, OverwriteType.Member)
  assert.equal(bitsIn(assignee.allow), SIX)
  assert.equal(bitsIn(assignee.deny), 0n)
  // The @everyone deny rides through untouched.
  assert.equal(bitsIn(sent.find((o) => o.id === 'G1').deny), P.ViewChannel)
})

test('a task channel whose only gap is its assignee is still upgraded; a member who cannot view is never touched', async () => {
  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'c1', [
    { id: 'r1', type: OverwriteType.Role, allow: SIX | VOICE4, deny: 0n },
    // Somebody an admin shut out of this one channel: a deny-only member entry.
    { id: 'shut-out', type: OverwriteType.Member, allow: 0n, deny: P.ViewChannel },
  ])
  taskCh.permissionOverwrites.cache.set('assignee', { id: 'assignee', type: OverwriteType.Member, allow: OLD_TEXT, deny: 0n })
  const s = sixBitSection({ catRole: newRole, secRole: newRole, tasks: [taskCh] })
  const observed = observeProjectSection(s.guild, s.stored, [{ id: 't1', title: 'Git Sync', type: 'feature', status: 'open', discordChannelId: 'tc1' }], { rolesFetched: true })
  assert.equal(observed.tasks[0].roleAllowIncomplete, false)
  assert.equal(observed.tasks[0].membersIncomplete, true)
  const plan = planProjectSection(s.stored, observed)
  assert.equal(plan.tasks[0].action, 'grant')
  await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  assert.equal(taskCh.edits.length, 1)
  const sent = taskCh.edits[0].permissionOverwrites
  assert.equal(bitsIn(sent.find((o) => o.id === 'assignee').allow), SIX)
  const shut = sent.find((o) => o.id === 'shut-out')
  assert.equal(bitsIn(shut.allow), 0n, 'a deny-only member entry gains nothing')
  assert.equal(bitsIn(shut.deny), P.ViewChannel)
})

test('a locked ticket is upgraded without re-opening it: SendMessages stays denied, never re-allowed', async () => {
  // lockTicketChannel moved SendMessages from allow to deny on every entry.
  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'c1', [
    { id: 'r1', type: OverwriteType.Role, allow: (OLD_TEXT | VOICE4) & ~P.SendMessages, deny: P.SendMessages },
  ])
  taskCh.permissionOverwrites.cache.set('assignee', { id: 'assignee', type: OverwriteType.Member, allow: OLD_TEXT & ~P.SendMessages, deny: P.SendMessages })
  const s = sixBitSection({ catRole: newRole, secRole: newRole, tasks: [taskCh] })
  const rows = [{ id: 't1', title: 'Git Sync', type: 'feature', status: 'done', channelRetireAt: new Date(), discordChannelId: 'tc1' }]
  const plan = planProjectSection(s.stored, observeProjectSection(s.guild, s.stored, rows, { rolesFetched: true }))
  assert.equal(plan.tasks[0].action, 'grant')
  await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  const sent = taskCh.edits[0].permissionOverwrites
  for (const id of ['r1', 'assignee']) {
    const e = sent.find((o) => o.id === id)
    assert.equal(bitsIn(e.allow) & P.SendMessages, 0n, `${id} is still read-only`)
    assert.equal(bitsIn(e.deny), P.SendMessages, `${id} keeps its lock`)
    assert.equal(bitsIn(e.allow) & NEW_TEXT, NEW_TEXT, `${id} gains the new bits`)
  }
})

test('a locked ticket already carrying the new bits plans nothing: a denied bit is not a missing one', () => {
  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'c1', [
    { id: 'r1', type: OverwriteType.Role, allow: (SIX | VOICE4) & ~P.SendMessages, deny: P.SendMessages },
  ])
  taskCh.permissionOverwrites.cache.set('assignee', { id: 'assignee', type: OverwriteType.Member, allow: SIX & ~P.SendMessages, deny: P.SendMessages })
  const s = sixBitSection({ catRole: newRole, secRole: newRole, tasks: [taskCh] })
  const rows = [{ id: 't1', title: 'Git Sync', type: 'feature', status: 'done', channelRetireAt: new Date(), discordChannelId: 'tc1' }]
  const plan = planProjectSection(s.stored, observeProjectSection(s.guild, s.stored, rows, { rolesFetched: true }))
  assert.equal(plan.tasks[0].action, 'none')
})

test('a category whose role entry has the old bits is repaired: allow upgraded, deny and @everyone kept', async () => {
  const s = sixBitSection({ catRole: { allow: OLD_TEXT | VOICE4, deny: P.MentionEveryone }, secRole: newRole })
  const observed = observeProjectSection(s.guild, s.stored, [], { rolesFetched: true })
  assert.equal(observed.categoryRoleAllowIncomplete, true)
  const plan = planProjectSection(s.stored, observed)
  assert.equal(plan.category.opens, true)
  await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  assert.equal(s.cat.edits.length, 1)
  const sent = s.cat.edits[0].permissionOverwrites
  const entry = sent.find((o) => o.id === 'r1')
  assert.equal(bitsIn(entry.allow) & (SIX | VOICE4), SIX | VOICE4)
  assert.equal(bitsIn(entry.deny), P.MentionEveryone)
  const everyone = sent.find((o) => o.id === 'G1')
  assert.equal(everyone.type, OverwriteType.Role)
  assert.equal(bitsIn(everyone.deny), P.ViewChannel)
})

test('a client whose support-channel entry has three bits is re-granted', async () => {
  const oldClient = { id: 'client1', type: OverwriteType.Member, allow: OLD_TEXT, deny: 0n }
  const s = sixBitSection({ catRole: newRole, secRole: newRole, extraOn: { support: [oldClient] } })
  const grants = []
  // The client is on the project, so the voice and casual channels owe them a
  // grant too; each channel records what it was sent.
  for (const key of ['support', 'supportVoice', 'casual']) {
    const ch = s.channels[SECTIONS.findIndex((x) => x.key === key)]
    ch.permissionOverwrites.edit = async (id, allow, opts) => grants.push({ key, id, allow, opts })
  }
  const observed = observeProjectSection(s.guild, s.stored, [], { rolesFetched: true, clientIds: ['client1'] })
  assert.deepEqual(observed.clientAccess.support.missing, ['client1'])
  const plan = planProjectSection(s.stored, observed)
  assert.ok(plan.clients.grant.some((g) => g.key === 'support' && g.memberId === 'client1'))
  await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  // An existing entry gets ONLY the bits it lacks (edit merges; the rest stays).
  const g = grants.find((x) => x.key === 'support' && x.id === 'client1')
  assert.deepEqual(g.allow, { AttachFiles: true, EmbedLinks: true, AddReactions: true })
  assert.equal(g.opts.type, OverwriteType.Member)
})

/** The three client channels of a `sixBitSection`, each recording the member edits it is sent. */
function recordClientGrants(s) {
  const grants = []
  for (const key of ['support', 'supportVoice', 'casual']) {
    const ch = s.channels[SECTIONS.findIndex((x) => x.key === key)]
    ch.permissionOverwrites.edit = async (id, allow, opts) => grants.push({ key, id, allow, opts })
  }
  return grants
}

test('a muted client keeps SendMessages denied and gains only attach, embed and react', async () => {
  const muted = { id: 'client1', type: OverwriteType.Member, allow: OLD_TEXT & ~P.SendMessages, deny: P.SendMessages }
  const s = sixBitSection({ catRole: newRole, secRole: newRole, extraOn: { support: [muted], supportVoice: [muted], casual: [muted] } })
  const grants = recordClientGrants(s)
  const plan = planProjectSection(s.stored, observeProjectSection(s.guild, s.stored, [], { rolesFetched: true, clientIds: ['client1'] }))
  await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  const mine = grants.filter((g) => g.id === 'client1')
  assert.equal(mine.length, 3)
  for (const g of mine) {
    assert.deepEqual(g.allow, { AttachFiles: true, EmbedLinks: true, AddReactions: true }, g.key)
    assert.equal(g.allow.SendMessages, undefined, 'never unmuted')
  }
  // The same channels' merged grant edits (the member upgrade) keep the mute too.
  for (const ch of s.channels) {
    for (const e of ch.edits) {
      const entry = e.permissionOverwrites?.find((o) => o.id === 'client1')
      if (entry) assert.equal(bitsIn(entry.allow) & P.SendMessages, 0n)
    }
  }
})

test('a client shut out of a support channel (ViewChannel denied) is left exactly as they are', async () => {
  const shut = { id: 'client1', type: OverwriteType.Member, allow: 0n, deny: P.ViewChannel }
  const six = { id: 'client1', type: OverwriteType.Member, allow: SIX, deny: 0n }
  const sixVoice = { id: 'client1', type: OverwriteType.Member, allow: SIX | VOICE4, deny: 0n }
  const s = sixBitSection({ catRole: newRole, secRole: newRole, extraOn: { support: [shut], supportVoice: [sixVoice], casual: [six] } })
  const grants = recordClientGrants(s)
  const observed = observeProjectSection(s.guild, s.stored, [], { rolesFetched: true, clientIds: ['client1'] })
  assert.deepEqual(observed.clientAccess.support.missing, [])
  assert.equal(observed.channels.support.membersIncomplete, false)
  const plan = planProjectSection(s.stored, observed)
  assert.deepEqual(plan.clients.grant, [])
  await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  assert.deepEqual(grants, [])
  for (const ch of s.channels) assert.deepEqual(ch.edits, [], ch.name)
})

test('a client with no overwrite yet gets the full client allow', async () => {
  const s = sixBitSection({ catRole: newRole, secRole: newRole })
  const grants = recordClientGrants(s)
  const plan = planProjectSection(s.stored, observeProjectSection(s.guild, s.stored, [], { rolesFetched: true, clientIds: ['client1'] }))
  await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  const text = grants.find((g) => g.key === 'support')
  assert.deepEqual(text.allow, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true, AddReactions: true })
  const voice = grants.find((g) => g.key === 'supportVoice')
  assert.equal(voice.allow.Connect, true)
  assert.equal(voice.allow.AttachFiles, true)
})

test('a role entry that only denies is never given allow bits (section channel and category)', async () => {
  const s = sixBitSection({ catRole: { allow: 0n, deny: P.ViewChannel }, secRole: newRole })
  const members = s.channels[0]
  members.permissionOverwrites.cache.set('r1', { id: 'r1', type: OverwriteType.Role, allow: 0n, deny: P.ViewChannel })
  // The voice-activity pass (untouched here) still offers the role UseVAD/Stream on the
  // category; record it rather than let the fake throw.
  s.cat.permissionOverwrites.edit = async () => {}
  // Make the category due an edit for another reason: its @everyone deny is gone.
  s.cat.permissionOverwrites.cache.delete('G1')
  const observed = observeProjectSection(s.guild, s.stored, [], { rolesFetched: true })
  assert.equal(observed.channels.members.roleAllowIncomplete, false)
  assert.equal(observed.categoryRoleAllowIncomplete, false)
  const plan = planProjectSection(s.stored, observed)
  assert.equal(plan.channels.find((c) => c.key === 'members').action, 'reuse')
  assert.equal(plan.category.opens, undefined)
  await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  assert.deepEqual(members.edits, [])
  assert.equal(s.cat.edits.length, 1, 'the @everyone deny comes back')
  const role = s.cat.edits[0].permissionOverwrites.find((o) => o.id === 'r1')
  assert.equal(bitsIn(role.allow), 0n, 'the deny-only role entry is carried exactly')
  assert.equal(bitsIn(role.deny), P.ViewChannel)
})

test('the category repair MERGES a present @everyone entry: a hand-cleared deny is not restored', async () => {
  // Since the text upgrade, an entry already on the category is upgraded, not
  // replaced — and @everyone has no allow to upgrade, so it is carried as is.
  const s = sixBitSection({ catRole: newRole, secRole: newRole })
  s.cat.permissionOverwrites.cache.set('G1', { id: 'G1', type: OverwriteType.Role, allow: 0n, deny: 0n })
  s.cat.permissionOverwrites.cache.delete('r1')
  const plan = planProjectSection(s.stored, observeProjectSection(s.guild, s.stored, [], { rolesFetched: true }))
  await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  assert.equal(s.cat.edits.length, 1, 'the missing role entry is added')
  const everyone = s.cat.edits[0].permissionOverwrites.find((o) => o.id === 'G1')
  assert.equal(bitsIn(everyone.deny), 0n, 'the cleared @everyone deny stays cleared')
  assert.ok(s.cat.edits[0].permissionOverwrites.some((o) => o.id === 'r1'))
})

test('a ticket left outside the section by the category cap still has its short member entries upgraded', async () => {
  const plan = planProjectSection(project, {
    ...empty,
    roleId: 'r1',
    categoryId: 'c1',
    categoryName: '📂 FRAMEWORK',
    categoryChannelCount: 49,
    channels: placedSections(['G1', 'r1']),
    tasks: [{
      id: 't1', title: 'Git Sync', type: 'feature', channelId: 'tc1', channelName: 'feature-git-sync',
      parentId: 'FEATURES', overwriteIds: ['G1', 'assignee'], roleAllowIncomplete: false, membersIncomplete: true,
    }],
  })
  assert.equal(plan.tasks[0].action, 'grant')

  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'FEATURES')
  taskCh.permissionOverwrites.cache.set('assignee', { id: 'assignee', type: OverwriteType.Member, allow: OLD_TEXT, deny: 0n })
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const guild = fakeGuild({ channels: [cat, taskCh], roles: [{ id: 'r1', name: 'Framework', members: new Map() }] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  await applyProjectSection(guild, stored, { ...plan, channels: [], divider: null }, { db: fakeDb() })
  assert.equal(taskCh.edits.length, 1)
  assert.deepEqual(Object.keys(taskCh.edits[0]), ['permissionOverwrites'], 'stays where it is')
  const sent = taskCh.edits[0].permissionOverwrites
  assert.equal(bitsIn(sent.find((o) => o.id === 'assignee').allow), SIX)
  assert.equal(sent.find((o) => o.id === 'r1'), undefined, 'no role allow outside the section')
})

/**
 * Make a fake channel's overwrite cache follow what it is sent, the way a real
 * discord.js cache does after an edit: a whole-array `edit` replaces it, a
 * `permissionOverwrites.edit` merges the named flags into one entry.
 */
function live(ch) {
  const cache = ch.permissionOverwrites.cache
  const edit = ch.edit
  ch.edit = async (o) => {
    const r = await edit(o)
    if (o.permissionOverwrites) {
      cache.clear()
      for (const e of o.permissionOverwrites) cache.set(e.id, { id: e.id, type: e.type, allow: bitsIn(e.allow), deny: bitsIn(e.deny) })
    }
    return r
  }
  ch.permissionOverwrites.edit = async (id, flags, opts) => {
    ch.edits.push({ member: id, flags })
    const cur = cache.get(id) ?? { id, type: opts?.type, allow: 0n, deny: 0n }
    let { allow, deny } = cur
    for (const [k, v] of Object.entries(flags)) {
      if (v === true) { allow |= P[k]; deny &= ~P[k] } else if (v === false) { deny |= P[k]; allow &= ~P[k] }
    }
    cache.set(id, { ...cur, allow, deny })
  }
  return ch
}

test('two passes: after one run on three-bit channels, a second run plans reuse/none everywhere and edits nothing', async () => {
  const oldClient = { id: 'client1', type: OverwriteType.Member, allow: OLD_TEXT, deny: 0n }
  const oldVoiceClient = { id: 'client1', type: OverwriteType.Member, allow: OLD_TEXT | VOICE4, deny: 0n }
  const live1 = ticketChannel('tc1', 'feature-git-sync', 'c1', [{ id: 'r1', type: OverwriteType.Role, allow: OLD_TEXT, deny: 0n }])
  live1.permissionOverwrites.cache.set('assignee', { id: 'assignee', type: OverwriteType.Member, allow: OLD_TEXT, deny: 0n })
  const locked = ticketChannel('tc2', 'feature-old-work', 'c1', [
    { id: 'r1', type: OverwriteType.Role, allow: (OLD_TEXT | VOICE4) & ~P.SendMessages, deny: P.SendMessages },
  ])
  locked.permissionOverwrites.cache.set('assignee', { id: 'assignee', type: OverwriteType.Member, allow: OLD_TEXT & ~P.SendMessages, deny: P.SendMessages })
  locked.rawPosition = 21
  const s = sixBitSection({
    catRole: oldRole,
    secRole: oldRole,
    extraOn: { support: [oldClient], supportVoice: [oldVoiceClient], casual: [oldClient] },
    tasks: [live1, locked],
  })
  for (const ch of [s.cat, ...s.channels, live1, locked, s.div]) live(ch)
  const rows = [
    { id: 't1', title: 'Git Sync', type: 'feature', status: 'open', discordChannelId: 'tc1' },
    { id: 't2', title: 'Old Work', type: 'feature', status: 'done', channelRetireAt: new Date(), discordChannelId: 'tc2' },
  ]
  const opts = { rolesFetched: true, clientIds: ['client1'] }

  const first = planProjectSection(s.stored, observeProjectSection(s.guild, s.stored, rows, opts))
  assert.ok(first.channels.every((c) => c.action === 'grant'))
  assert.equal(first.category.opens, true)
  await applyProjectSection(s.guild, s.stored, first, { db: fakeDb() })
  assert.ok(s.cat.edits.length && live1.edits.length && locked.edits.length, 'the first run edits')

  for (const ch of [s.cat, ...s.channels, live1, locked, s.div]) ch.edits.length = 0
  const observed = observeProjectSection(s.guild, s.stored, rows, opts)
  const second = planProjectSection(s.stored, observed)
  assert.equal(second.category.action, 'reuse')
  assert.equal(second.category.opens, undefined)
  assert.ok(second.channels.every((c) => c.action === 'reuse'), JSON.stringify(second.channels.map((c) => c.action)))
  assert.deepEqual(second.tasks.map((t) => t.action), ['none', 'none'])
  assert.deepEqual(second.clients.grant, [])
  assert.equal(second.divider.action, 'reuse')
  const result = await applyProjectSection(s.guild, s.stored, second, { db: fakeDb() })
  for (const ch of [s.cat, ...s.channels, live1, locked, s.div]) assert.deepEqual(ch.edits, [], `${ch.name} is not edited on the second run`)
  assert.deepEqual(result.granted, [])
  assert.deepEqual(result.clientGranted, [])
  // And the locked ticket is still locked.
  assert.equal(locked.permissionOverwrites.cache.get('assignee').allow & P.SendMessages, 0n)
  assert.equal(locked.permissionOverwrites.cache.get('r1').allow & P.SendMessages, 0n)
})

test('a section already carrying all six bits plans reuse/none everywhere and makes no edit (idempotent)', async () => {
  const sixClient = { id: 'client1', type: OverwriteType.Member, allow: SIX, deny: 0n }
  const sixVoiceClient = { id: 'client1', type: OverwriteType.Member, allow: SIX | VOICE4, deny: 0n }
  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'c1', [{ id: 'r1', type: OverwriteType.Role, allow: SIX | VOICE4, deny: 0n }])
  taskCh.permissionOverwrites.cache.set('assignee', { id: 'assignee', type: OverwriteType.Member, allow: SIX, deny: 0n })
  taskCh.rawPosition = 15
  const s = sixBitSection({
    catRole: newRole,
    secRole: newRole,
    extraOn: { support: [sixClient], supportVoice: [sixVoiceClient], casual: [sixClient] },
    tasks: [taskCh],
  })
  const rows = [{ id: 't1', title: 'Git Sync', type: 'feature', status: 'open', discordChannelId: 'tc1' }]
  const observed = observeProjectSection(s.guild, s.stored, rows, { rolesFetched: true, clientIds: ['client1'] })
  assert.equal(observed.categoryRoleAllowIncomplete, false)
  const plan = planProjectSection(s.stored, observed)
  assert.equal(plan.category.action, 'reuse')
  assert.equal(plan.category.opens, undefined)
  assert.ok(plan.channels.every((c) => c.action === 'reuse'), 'every section channel is reuse')
  assert.equal(plan.tasks[0].action, 'none')
  assert.deepEqual(plan.clients.grant, [])
  assert.equal(plan.divider.action, 'reuse')

  const result = await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  for (const ch of [s.cat, ...s.channels, taskCh, s.div]) assert.deepEqual(ch.edits, [], `${ch.name} is not edited`)
  assert.deepEqual(result.granted, [])
  assert.deepEqual(result.opened, [])
})

test('a run that upgrades every section channel leaves a correct divider alone: it never gains SendMessages or AddReactions', async () => {
  const s = sixBitSection({ catRole: oldRole, secRole: oldRole })
  const plan = planProjectSection(s.stored, observeProjectSection(s.guild, s.stored, [], { rolesFetched: true }))
  assert.ok(plan.channels.every((c) => c.action === 'grant'), 'every section channel is upgraded')
  assert.equal(plan.divider.action, 'reuse')
  await applyProjectSection(s.guild, s.stored, plan, { db: fakeDb() })
  assert.deepEqual(s.div.edits, [], 'the divider is not edited')
  const onDivider = s.div.permissionOverwrites.cache.get('r1')
  assert.equal(bitsIn(onDivider.allow) & (P.SendMessages | P.AddReactions), 0n)
  assert.equal(bitsIn(onDivider.deny) & (P.SendMessages | P.AddReactions), P.SendMessages | P.AddReactions)
})

test('a divider repair still REPLACES the role entry with the read-only set, never OR-ing into it', async () => {
  // The upgrade merge ORs allow bits into an existing entry; the divider must
  // not take that path, or a Sync-Now'd SendMessages would survive the repair.
  const div = dividerWith({ allow: SIX | VOICE4, deny: 0n })
  await runDividerRepair(div)
  const entry = div.edits[0].permissionOverwrites.find((o) => o.id === 'r1')
  assert.deepEqual(entry.allow, DIVIDER_ROLE_ALLOW)
  assert.deepEqual(entry.deny, DIVIDER_ROLE_DENY)
})
