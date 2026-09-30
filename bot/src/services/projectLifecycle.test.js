// Deleting and reactivating a project. Every test passes a fake db, a fake
// guild and (for reactivation) a fake setup — never the default `db`, never a
// real server. The root `.env` points at production; see
// .claude/rules/tests-never-touch-production.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import {
  archiveCategoryName,
  ensureArchiveCategory,
  archiveTaskChannel,
  restoreTaskChannel,
  deleteProject,
  reactivateProject,
  deleteReply,
  reactivateReply,
  ARCHIVE_CATEGORY_LIMIT,
} from './projectLifecycle.js'
import { taskChannelOverwrites } from './taskTicketChannel.js'
import { ARCHIVE_CATEGORY_BASE } from '../utils/projectDeleted.js'

const F = PermissionFlagsBits

// --- fakes ------------------------------------------------------------------

/** An overwrite as discord.js caches it: `allow`/`deny` answer `.has(bit)`. */
function cachedOverwrite({ id, type, allow = [], deny = [] }) {
  const bits = (list) => new Set((list || []).map((b) => BigInt(b)))
  const a = bits(allow)
  const d = bits(deny)
  return { id, type, allow: { has: (b) => a.has(BigInt(b)) }, deny: { has: (b) => d.has(BigInt(b)) } }
}

function unknown(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

/**
 * A guild whose channels and roles record every Discord call into `log` (the
 * same array the fake db writes to, so the tests can assert order).
 */
function fakeGuild({ log = [], channels = [], roles = [], members = {} } = {}) {
  const guild = { id: 'G1', log }
  const chanMap = new Map()
  const roleMap = new Map()

  function makeChannel({ id, name, type = ChannelType.GuildText, parentId = null, topic = null, overwrites = [], failEdit = null, failDelete = null }) {
    const channel = {
      id,
      name,
      type,
      parentId,
      topic,
      edits: [],
      overwriteEdits: [],
      permissionOverwrites: {
        cache: new Map(overwrites.map((o) => [o.id, cachedOverwrite(o)])),
        async edit(oid, opts) {
          log.push(['overwrite.edit', id, oid, opts])
          channel.overwriteEdits.push([oid, opts])
        },
      },
      async edit(opts) {
        log.push(['channel.edit', id, opts])
        if (failEdit) throw new Error(failEdit)
        channel.edits.push(opts)
        if (opts.parent !== undefined) channel.parentId = opts.parent
        if (opts.permissionOverwrites) {
          channel.permissionOverwrites.cache = new Map(opts.permissionOverwrites.map((o) => [o.id, cachedOverwrite(o)]))
        }
        return channel
      },
      async delete() {
        log.push(['channel.delete', id])
        if (failDelete) throw new Error(failDelete)
        chanMap.delete(id)
      },
    }
    chanMap.set(id, channel)
    return channel
  }
  for (const c of channels) makeChannel(c)

  for (const r of roles) {
    const role = {
      ...r,
      async delete() {
        log.push(['role.delete', r.id])
        if (r.failDelete) throw new Error(r.failDelete)
        roleMap.delete(r.id)
      },
    }
    roleMap.set(r.id, role)
  }

  let made = 0
  guild.channels = {
    cache: chanMap,
    created: [],
    async fetch(id) {
      log.push(['channel.fetch', id])
      if (chanMap.has(id)) return chanMap.get(id)
      throw unknown(10003, 'Unknown Channel')
    },
    async create(opts) {
      log.push(['channel.create', opts.name])
      guild.channels.created.push(opts)
      made += 1
      return makeChannel({ id: `made-${made}`, name: opts.name, type: opts.type, parentId: opts.parent ?? null })
    },
  }
  guild.roles = {
    cache: roleMap,
    async fetch(id) {
      log.push(['role.fetch', id])
      if (roleMap.has(id)) return roleMap.get(id)
      throw unknown(10011, 'Unknown Role')
    },
  }
  guild.members = {
    async fetch(id) {
      const m = members[id]
      if (!m) throw unknown(10007, 'Unknown Member')
      return m
    },
  }
  guild.makeChannel = makeChannel
  return guild
}

function fakeMember(id, log) {
  return {
    id,
    roles: {
      async remove(roleId) {
        log.push(['member.roles.remove', id, roleId])
      },
    },
  }
}

const CFG = { id: 'g1', clockedInRoleId: 'clocked' }
const NOW = new Date('2026-10-01T12:00:00Z')

function fakeDb({ project, tasks = [], clocks = [], log = [], failNullIds = false } = {}) {
  const row = { ...project }
  const db = {
    row,
    taskReads: [],
    clockReads: [],
    clockUpdates: [],
    project: {
      async update({ where, data }) {
        log.push(['project.update', data])
        if (failNullIds && data.discordCategoryId === null) throw new Error('db down')
        assert.equal(where.id, row.id)
        Object.assign(row, data)
        return { ...row }
      },
      async findFirst({ where }) {
        return where.id === row.id ? { ...row } : null
      },
    },
    task: {
      async findMany({ where }) {
        db.taskReads.push(where)
        return tasks.filter((t) => t.projectId === where.projectId)
      },
    },
    clockEntry: {
      async findMany({ where }) {
        db.clockReads.push(where)
        return clocks.filter((c) => c.guildConfigId === where.guildConfigId && (!where.openOnly || !c.clockOutAt))
      },
      async update(id, data) {
        log.push(['clockEntry.update', id, data])
        db.clockUpdates.push([id, data])
      },
    },
  }
  return db
}

const ticket = (id, name, extra = {}) => ({
  id,
  name,
  type: ChannelType.GuildText,
  topic: `Feature: ${name} — Task t-${id}`,
  parentId: 'cat-p1',
  ...extra,
})

function liveProject(extra = {}) {
  return {
    id: 'p1',
    guildConfigId: 'g1',
    name: 'Apollo',
    docsSlug: 'apollo',
    discordCategoryId: 'cat-p1',
    discordRoleId: 'role-p1',
    discordChannels: { members: 'sec-members', general: 'sec-general', archiveDivider: 'sec-divider' },
    deletedAt: null,
    deletedBy: null,
    ...extra,
  }
}

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

const isDiscord = (entry) => /^(channel|role|overwrite|member)\./.test(entry[0])

// --- the archive category ---------------------------------------------------

test('archive category names: the base for the first, then numbered', () => {
  assert.equal(ARCHIVE_CATEGORY_BASE, '🗄 ARCHIVED PROJECTS')
  assert.equal(archiveCategoryName(1), '🗄 ARCHIVED PROJECTS')
  assert.equal(archiveCategoryName(2), '🗄 ARCHIVED PROJECTS 2')
  assert.equal(archiveCategoryName(3), '🗄 ARCHIVED PROJECTS 3')
  assert.equal(ARCHIVE_CATEGORY_LIMIT, 50)
})

test('ensureArchiveCategory creates the first one, hidden from @everyone, when there is none', async () => {
  const guild = fakeGuild()
  const category = await ensureArchiveCategory(guild)
  assert.equal(guild.channels.created.length, 1)
  const opts = guild.channels.created[0]
  assert.equal(opts.name, '🗄 ARCHIVED PROJECTS')
  assert.equal(opts.type, ChannelType.GuildCategory)
  assert.deepEqual(opts.permissionOverwrites, [{ id: 'G1', type: OverwriteType.Role, deny: [F.ViewChannel] }])
  assert.equal(category.name, '🗄 ARCHIVED PROJECTS')
})

test('ensureArchiveCategory reuses one with room', async () => {
  const children = Array.from({ length: 49 }, (_, i) => ticket(`c${i}`, `t${i}`, { parentId: 'arch1' }))
  const guild = fakeGuild({
    channels: [{ id: 'arch1', name: '🗄 ARCHIVED PROJECTS', type: ChannelType.GuildCategory }, ...children],
  })
  const category = await ensureArchiveCategory(guild)
  assert.equal(category.id, 'arch1')
  assert.equal(guild.channels.created.length, 0)
})

test('ensureArchiveCategory never lets one exceed 50: a full first one makes the second', async () => {
  const children = Array.from({ length: 50 }, (_, i) => ticket(`c${i}`, `t${i}`, { parentId: 'arch1' }))
  const guild = fakeGuild({
    channels: [{ id: 'arch1', name: '🗄 ARCHIVED PROJECTS', type: ChannelType.GuildCategory }, ...children],
  })
  const category = await ensureArchiveCategory(guild)
  assert.equal(guild.channels.created.length, 1)
  assert.equal(guild.channels.created[0].name, '🗄 ARCHIVED PROJECTS 2')
  assert.equal(category.name, '🗄 ARCHIVED PROJECTS 2')
})

test('ensureArchiveCategory skips a full one to an existing numbered one with room', async () => {
  const full = Array.from({ length: 50 }, (_, i) => ticket(`c${i}`, `t${i}`, { parentId: 'arch1' }))
  const guild = fakeGuild({
    channels: [
      { id: 'arch1', name: '🗄 ARCHIVED PROJECTS', type: ChannelType.GuildCategory },
      { id: 'arch2', name: '🗄 ARCHIVED PROJECTS 2', type: ChannelType.GuildCategory },
      ...full,
    ],
  })
  const category = await ensureArchiveCategory(guild)
  assert.equal(category.id, 'arch2')
  assert.equal(guild.channels.created.length, 0)
})

test('archiving 51 channels into an empty server fills the first category and opens a second', async () => {
  const tasks = Array.from({ length: 51 }, (_, i) => ({ id: `t${i}`, projectId: 'p1', discordChannelId: `tc${i}`, status: 'open' }))
  const log = []
  const guild = fakeGuild({
    log,
    channels: tasks.map((t, i) => ticket(`tc${i}`, `feature-${i}`)),
  })
  const db = fakeDb({ project: liveProject({ discordChannels: null, discordCategoryId: null, discordRoleId: null }), tasks, log })
  const result = await deleteProject({ db, guild, cfg: CFG, project: db.row, actorId: 'u-ceo', now: NOW })
  assert.equal(result.archived, 51)
  const counts = new Map()
  for (const c of guild.channels.cache.values()) if (c.parentId) counts.set(c.parentId, (counts.get(c.parentId) ?? 0) + 1)
  const names = guild.channels.created.map((o) => o.name)
  assert.deepEqual(names, ['🗄 ARCHIVED PROJECTS', '🗄 ARCHIVED PROJECTS 2'])
  assert.deepEqual([...counts.values()].sort((a, b) => a - b), [1, 50])
})

// --- one channel ------------------------------------------------------------

test('archiveTaskChannel moves the channel and replaces its overwrites with @everyone denied view and send', async () => {
  const guild = fakeGuild({
    channels: [
      ticket('tc1', 'feature-login', {
        overwrites: [
          { id: 'G1', type: OverwriteType.Role, deny: [F.ViewChannel] },
          { id: 'role-p1', type: OverwriteType.Role, allow: [F.ViewChannel, F.SendMessages] },
          { id: 'u1', type: OverwriteType.Member, allow: [F.ViewChannel, F.SendMessages] },
        ],
      }),
    ],
  })
  const channel = guild.channels.cache.get('tc1')
  await archiveTaskChannel(guild, channel, { id: 'arch1' })
  assert.equal(channel.edits.length, 1, 'one edit')
  assert.deepEqual(channel.edits[0], {
    parent: 'arch1',
    permissionOverwrites: [{ id: 'G1', type: OverwriteType.Role, deny: [F.ViewChannel, F.SendMessages] }],
  })
})

test('restoreTaskChannel rebuilds an open task channel the way a new one is built, and leaves it writable', async () => {
  const guild = fakeGuild({ channels: [ticket('tc1', 'feature-login', { parentId: 'cat-p1' })], roles: [{ id: 'role-p1' }] })
  const channel = guild.channels.cache.get('tc1')
  const task = { id: 't1', createdBy: 'u-lead', assigneeIds: ['u1', 'u2'], status: 'in_progress', discordChannelId: 'tc1' }
  const project = liveProject()
  await restoreTaskChannel(guild, channel, { task, project })
  assert.equal(channel.edits.length, 1)
  assert.deepEqual(
    channel.edits[0].permissionOverwrites,
    taskChannelOverwrites(guild, { project, memberIds: ['u-lead', 'u1', 'u2'], inSection: true })
  )
  assert.ok(
    channel.edits[0].permissionOverwrites.some((o) => o.id === 'role-p1'),
    'the project role is allowed inside its section'
  )
  assert.deepEqual(channel.overwriteEdits, [], 'an open task is not locked')
})

test('restoreTaskChannel relocks a finished task channel', async () => {
  const guild = fakeGuild({ channels: [ticket('tc1', 'feature-login', { parentId: 'cat-p1' })], roles: [{ id: 'role-p1' }] })
  const channel = guild.channels.cache.get('tc1')
  const task = { id: 't1', createdBy: 'u-lead', assigneeIds: ['u1'], status: 'done', discordChannelId: 'tc1' }
  await restoreTaskChannel(guild, channel, { task, project: liveProject() })
  const locked = channel.overwriteEdits.map(([id, opts]) => [id, opts.SendMessages])
  assert.deepEqual(
    locked.sort(),
    [['role-p1', false], ['u-lead', false], ['u1', false]].sort(),
    'every overwrite that could send was locked'
  )
})

test('restoreTaskChannel does not grant the project role to a channel left outside its section', async () => {
  const guild = fakeGuild({ channels: [ticket('tc1', 'feature-login', { parentId: 'arch1' })], roles: [{ id: 'role-p1' }] })
  const channel = guild.channels.cache.get('tc1')
  await restoreTaskChannel(guild, channel, { task: { id: 't1', createdBy: 'u-lead', assigneeIds: [], status: 'open' }, project: liveProject() })
  assert.ok(!channel.edits[0].permissionOverwrites.some((o) => o.id === 'role-p1'))
})

// --- delete -----------------------------------------------------------------

function deleteFixture({ failures = {}, clocks = [], failNullIds = false } = {}) {
  const log = []
  const tasks = [
    { id: 't1', projectId: 'p1', discordChannelId: 'tc1', status: 'open' },
    { id: 't2', projectId: 'p1', discordChannelId: 'tc2', status: 'done' },
    { id: 't3', projectId: 'p1', discordChannelId: null, status: 'open' },
  ]
  const guild = fakeGuild({
    log,
    channels: [
      { id: 'cat-p1', name: '📂 APOLLO', type: ChannelType.GuildCategory, failDelete: failures.category ?? null },
      { id: 'sec-members', name: 'apollo-members', parentId: 'cat-p1', failDelete: failures.members ?? null },
      { id: 'sec-general', name: 'apollo-general', parentId: 'cat-p1' },
      { id: 'sec-divider', name: '────archive────', parentId: 'cat-p1' },
      ticket('tc1', 'feature-login', { failEdit: failures.tc1 ?? null }),
      ticket('tc2', 'feature-signup'),
    ],
    roles: [{ id: 'role-p1', failDelete: failures.role ?? null }],
    members: { u1: fakeMember('u1', log), u2: fakeMember('u2', log) },
  })
  const db = fakeDb({ project: liveProject(), tasks, clocks, log, failNullIds })
  return { log, guild, db }
}

test('deleteProject marks the row deleted before any Discord call', async () => {
  const { log, guild, db } = deleteFixture()
  await deleteProject({ db, guild, cfg: CFG, project: db.row, actorId: 'u-ceo', now: NOW })
  assert.deepEqual(log[0], ['project.update', { deletedAt: NOW, deletedBy: 'u-ceo' }])
  assert.ok(log.slice(1).some(isDiscord), 'Discord work followed')
})

test('deleteProject archives the task channels, removes the section, the category and the role, and nulls the ids', async () => {
  const { log, guild, db } = deleteFixture()
  const result = await deleteProject({ db, guild, cfg: CFG, project: db.row, actorId: 'u-ceo', now: NOW })

  assert.deepEqual(db.taskReads[0], { guildConfigId: 'g1', projectId: 'p1', includeDeleted: true })
  const archive = [...guild.channels.cache.values()].find((c) => c.name === '🗄 ARCHIVED PROJECTS')
  assert.ok(archive, 'the archive category exists')
  for (const id of ['tc1', 'tc2']) {
    const c = guild.channels.cache.get(id)
    assert.equal(c.parentId, archive.id, `${id} moved into the archive`)
    assert.deepEqual(c.edits.at(-1).permissionOverwrites, [
      { id: 'G1', type: OverwriteType.Role, deny: [F.ViewChannel, F.SendMessages] },
    ])
  }
  for (const id of ['sec-members', 'sec-general', 'sec-divider', 'cat-p1']) {
    assert.ok(!guild.channels.cache.has(id), `${id} deleted`)
  }
  assert.ok(!guild.roles.cache.has('role-p1'), 'role deleted')
  // Channels out of the category before it goes, the category before the role.
  const at = (entry) => log.findIndex((e) => e[0] === entry[0] && e[1] === entry[1])
  assert.ok(at(['channel.edit', 'tc1']) < at(['channel.delete', 'cat-p1']))
  assert.ok(at(['channel.delete', 'sec-members']) < at(['channel.delete', 'cat-p1']))
  assert.ok(at(['channel.delete', 'cat-p1']) < at(['role.delete', 'role-p1']))

  assert.deepEqual(log.at(-1), ['project.update', { discordCategoryId: null, discordRoleId: null, discordChannels: null }])
  assert.equal(db.row.deletedAt, NOW)
  assert.deepEqual(result, { archived: 2, removed: 5, stoppedClocks: 0, failures: [] })
})

test('deleteProject reports a failed step and still leaves the project deleted', async () => {
  const { guild, db } = deleteFixture({ failures: { members: 'Missing Permissions', tc1: 'Missing Access', role: 'Missing Permissions' } })
  const result = await quiet(() => deleteProject({ db, guild, cfg: CFG, project: db.row, actorId: 'u-ceo', now: NOW }))
  assert.equal(db.row.deletedAt, NOW, 'still deleted')
  assert.equal(result.archived, 1)
  assert.equal(result.failures.length, 3)
  assert.match(result.failures.join('\n'), /feature-login.*Missing Access/)
  assert.match(result.failures.join('\n'), /apollo-members.*Missing Permissions/)
  assert.match(result.failures.join('\n'), /role.*Missing Permissions/)
  assert.ok(guild.channels.cache.has('sec-members'), 'the refused channel is still there')
  assert.ok(!guild.channels.cache.has('sec-general'), 'the others were still removed')
})

test('deleteProject skips a channel that is already gone without calling it a failure', async () => {
  const { guild, db } = deleteFixture()
  guild.channels.cache.delete('sec-general')
  guild.channels.cache.delete('tc2')
  const result = await deleteProject({ db, guild, cfg: CFG, project: db.row, actorId: 'u-ceo', now: NOW })
  assert.equal(result.archived, 1)
  assert.deepEqual(result.failures, [])
})

test('deleteProject counts a channel lookup that failed for another reason', async () => {
  const { guild, db } = deleteFixture()
  guild.channels.cache.delete('tc2')
  guild.channels.fetch = async () => {
    throw unknown(50001, 'Missing Access')
  }
  const result = await quiet(() => deleteProject({ db, guild, cfg: CFG, project: db.row, actorId: 'u-ceo', now: NOW }))
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /Missing Access/)
})

test('deleteProject reports a failure to clear the ids and the project stays deleted', async () => {
  const { guild, db } = deleteFixture({ failNullIds: true })
  const result = await quiet(() => deleteProject({ db, guild, cfg: CFG, project: db.row, actorId: 'u-ceo', now: NOW }))
  assert.equal(db.row.deletedAt, NOW)
  assert.match(result.failures.join('\n'), /db down/)
})

test('deleteProject leaves a shared review channel and a non-ticket channel alone', async () => {
  const log = []
  const guild = fakeGuild({
    log,
    channels: [
      { id: 'review', name: 'meeting-review', topic: 'Review the tasks from the meeting' },
      { id: 'shared', name: 'feature-shared', topic: 'Feature: shared — Task x' },
    ],
  })
  const tasks = [
    { id: 't1', projectId: 'p1', discordChannelId: 'review' },
    { id: 't2', projectId: 'p1', discordChannelId: 'shared' },
    { id: 't3', projectId: 'p1', discordChannelId: 'shared' },
  ]
  const db = fakeDb({ project: liveProject({ discordChannels: null, discordCategoryId: null, discordRoleId: null }), tasks, log })
  const result = await deleteProject({ db, guild, cfg: CFG, project: db.row, actorId: 'u-ceo', now: NOW })
  assert.equal(result.archived, 0)
  assert.deepEqual(guild.channels.cache.get('review').edits, [])
  assert.deepEqual(guild.channels.cache.get('shared').edits, [])
  assert.equal(guild.channels.created.length, 0, 'no archive category was made for nothing')
})

test('deleteProject stops every running clock on its tasks, right after marking the row', async () => {
  const clocks = [
    { id: 'e1', guildConfigId: 'g1', discordId: 'u1', taskId: 't1', clockInAt: new Date('2026-10-01T11:00:00Z'), clockOutAt: null },
    { id: 'e2', guildConfigId: 'g1', discordId: 'u2', taskId: 't3', clockInAt: new Date('2026-10-01T11:30:00Z'), clockOutAt: null },
    { id: 'e3', guildConfigId: 'g1', discordId: 'u3', taskId: 'other', clockInAt: new Date('2026-10-01T11:00:00Z'), clockOutAt: null },
    { id: 'e4', guildConfigId: 'g1', discordId: 'u4', taskId: null, clockInAt: new Date('2026-10-01T11:00:00Z'), clockOutAt: null },
  ]
  const { log, guild, db } = deleteFixture({ clocks })
  const result = await deleteProject({ db, guild, cfg: CFG, project: db.row, actorId: 'u-ceo', now: NOW })

  assert.deepEqual(db.clockReads, [{ guildConfigId: 'g1', openOnly: true }])
  assert.deepEqual(
    db.clockUpdates.map(([id, data]) => [id, data]),
    [
      ['e1', { clockOutAt: NOW, minutes: 60, note: 'Project deleted', source: 'auto_stopped' }],
      ['e2', { clockOutAt: NOW, minutes: 30, note: 'Project deleted', source: 'auto_stopped' }],
    ]
  )
  assert.equal(result.stoppedClocks, 2)
  const removed = log.filter((e) => e[0] === 'member.roles.remove').map((e) => [e[1], e[2]])
  assert.deepEqual(removed, [['u1', 'clocked'], ['u2', 'clocked']])
  // Right after the row: before any task channel is touched.
  const firstClock = log.findIndex((e) => e[0] === 'clockEntry.update')
  const firstChannel = log.findIndex((e) => e[0] === 'channel.edit')
  assert.equal(log.findIndex((e) => e[0] === 'project.update'), 0)
  assert.ok(firstClock < firstChannel)
})

test('a clock-in role that cannot be removed is not a failure; a clock that cannot be closed is', async () => {
  const clocks = [
    { id: 'e1', guildConfigId: 'g1', discordId: 'gone', taskId: 't1', clockInAt: new Date('2026-10-01T11:00:00Z'), clockOutAt: null },
    { id: 'e2', guildConfigId: 'g1', discordId: 'u2', taskId: 't2', clockInAt: new Date('2026-10-01T11:00:00Z'), clockOutAt: null },
  ]
  const { guild, db } = deleteFixture({ clocks })
  const update = db.clockEntry.update
  db.clockEntry.update = async (id, data) => {
    if (id === 'e2') throw new Error('lock wait timeout')
    return update(id, data)
  }
  const result = await quiet(() => deleteProject({ db, guild, cfg: CFG, project: db.row, actorId: 'u-ceo', now: NOW }))
  assert.equal(result.stoppedClocks, 1)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /lock wait timeout/)
})

// --- reactivate -------------------------------------------------------------

function reactivateFixture({ archiveExtra = [] } = {}) {
  const log = []
  const tasks = [
    { id: 't1', projectId: 'p1', discordChannelId: 'tc1', status: 'open', createdBy: 'u-lead', assigneeIds: ['u1'] },
    { id: 't2', projectId: 'p1', discordChannelId: 'tc2', status: 'done', createdBy: 'u-lead', assigneeIds: ['u2'] },
    { id: 't3', projectId: 'p1', discordChannelId: 'tc-gone', status: 'open', createdBy: 'u-lead', assigneeIds: [] },
  ]
  const archived = { deny: [F.ViewChannel, F.SendMessages], id: 'G1', type: OverwriteType.Role }
  const guild = fakeGuild({
    log,
    channels: [
      { id: 'arch1', name: '🗄 ARCHIVED PROJECTS', type: ChannelType.GuildCategory },
      { id: 'arch2', name: '🗄 ARCHIVED PROJECTS 2', type: ChannelType.GuildCategory },
      ticket('tc1', 'feature-login', { parentId: 'arch1', overwrites: [archived] }),
      ticket('tc2', 'feature-signup', { parentId: 'arch1', overwrites: [archived] }),
      ...archiveExtra,
    ],
  })
  const project = liveProject({
    deletedAt: new Date('2026-09-30T10:00:00Z'),
    deletedBy: 'u-ceo',
    discordCategoryId: null,
    discordRoleId: null,
    discordChannels: null,
  })
  const db = fakeDb({ project, tasks, log })
  return { log, guild, db }
}

/** A setup that rebuilds the section the way the real one does: a new role and category, task channels moved in. */
function fakeSetup({ guild, db, log, calls }) {
  return async (g, project, deps) => {
    log.push(['setup'])
    calls.push({ g, project, deps })
    guild.roles.cache.set('role-new', { id: 'role-new' })
    guild.makeChannel({ id: 'cat-new', name: '📂 APOLLO', type: ChannelType.GuildCategory })
    Object.assign(db.row, { discordCategoryId: 'cat-new', discordRoleId: 'role-new' })
    for (const id of ['tc1', 'tc2']) guild.channels.cache.get(id).parentId = 'cat-new'
    return { block: 'ok', result: { category: { name: '📂 APOLLO' } } }
  }
}

test('reactivateProject clears the row before the rebuild and hands setup the fresh project', async () => {
  const { log, guild, db } = reactivateFixture()
  const calls = []
  await reactivateProject({ db, guild, cfg: CFG, project: db.row, botUserId: 'bot1', setup: fakeSetup({ guild, db, log, calls }) })
  assert.deepEqual(log[0], ['project.update', { deletedAt: null, deletedBy: null }])
  assert.ok(log.findIndex((e) => e[0] === 'setup') > 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].g, guild)
  assert.equal(calls[0].project.deletedAt, null, 'the fresh, un-marked row')
  assert.equal(calls[0].project.id, 'p1')
  assert.deepEqual(calls[0].deps, { db, cfg: CFG, botUserId: 'bot1' })
})

test('reactivateProject restores each task channel, relocks a finished one, and removes an empty archive category', async () => {
  const { log, guild, db } = reactivateFixture()
  const calls = []
  const result = await reactivateProject({ db, guild, cfg: CFG, project: db.row, botUserId: 'bot1', setup: fakeSetup({ guild, db, log, calls }) })

  const tc1 = guild.channels.cache.get('tc1')
  const tc2 = guild.channels.cache.get('tc2')
  const fresh = { ...db.row }
  assert.deepEqual(tc1.edits.at(-1).permissionOverwrites, taskChannelOverwrites(guild, { project: fresh, memberIds: ['u-lead', 'u1'], inSection: true }))
  assert.ok(tc1.edits.at(-1).permissionOverwrites.some((o) => o.id === 'role-new'), 'the NEW role is allowed')
  assert.deepEqual(tc1.overwriteEdits, [], 'the open one stays writable')
  assert.deepEqual(
    tc2.overwriteEdits.map(([id, o]) => [id, o.SendMessages]).sort(),
    [['role-new', false], ['u-lead', false], ['u2', false]].sort(),
    'the finished one is locked again'
  )
  assert.ok(!guild.channels.cache.has('arch1'), 'the emptied archive category is gone')
  assert.ok(!guild.channels.cache.has('arch2'), 'an already-empty archive category is gone too')
  assert.deepEqual(result, { restored: 2, failures: [] })
})

test('reactivateProject keeps an archive category that still holds another project’s channels', async () => {
  const { log, guild, db } = reactivateFixture({ archiveExtra: [ticket('other', 'feature-other', { parentId: 'arch1' })] })
  const calls = []
  await reactivateProject({ db, guild, cfg: CFG, project: db.row, botUserId: 'bot1', setup: fakeSetup({ guild, db, log, calls }) })
  assert.ok(guild.channels.cache.has('arch1'))
  assert.ok(!guild.channels.cache.has('arch2'))
})

test('reactivateProject with a setup that throws still restores the channels and says to run /project-setup', async () => {
  const { guild, db } = reactivateFixture()
  const setup = async () => {
    throw new Error('Missing Permissions')
  }
  const result = await quiet(() => reactivateProject({ db, guild, cfg: CFG, project: db.row, botUserId: 'bot1', setup }))
  assert.equal(db.row.deletedAt, null, 'still reactivated')
  assert.equal(result.restored, 2)
  assert.deepEqual(result.failures, ['Section rebuild failed — run /project-setup for it.'])
  const tc2 = guild.channels.cache.get('tc2')
  assert.ok(tc2.edits.length >= 1, 'the channel was restored anyway')
  assert.ok(tc2.overwriteEdits.length >= 1, 'and the finished one relocked')
  assert.ok(guild.channels.cache.has('arch1'), 'an archive category still holding channels is kept')
})

// --- replies ----------------------------------------------------------------

test('the delete and reactivate replies', () => {
  assert.equal(
    deleteReply('Apollo', { archived: 3, stoppedClocks: 0, failures: [] }),
    'Deleted **Apollo**. Archived 3 task channels; removed its section and role.'
  )
  assert.equal(
    deleteReply('Apollo', { archived: 3, stoppedClocks: 2, failures: ['a failed', 'b failed'] }),
    'Deleted **Apollo**. Archived 3 task channels; removed its section and role. Stopped 2 running clocks.\na failed\nb failed'
  )
  assert.equal(
    reactivateReply('Apollo', { restored: 4, failures: [] }),
    'Reactivated **Apollo**. Rebuilt its section; restored 4 task channels.'
  )
  assert.equal(
    reactivateReply('Apollo', { restored: 0, failures: ['Section rebuild failed — run /project-setup for it.'] }),
    'Reactivated **Apollo**. Rebuilt its section; restored 0 task channels.\nSection rebuild failed — run /project-setup for it.'
  )
})
