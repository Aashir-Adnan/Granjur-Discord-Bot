import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType } from 'discord.js'
import { moveTicketToBucket } from './ticketBucketMove.js'

const cat = (id) => ({ id, type: ChannelType.GuildCategory, parentId: null })
function ticket(id, parentId, { fail = null } = {}) {
  const c = { id, type: ChannelType.GuildText, parentId, edits: [] }
  c.edit = async (o) => { c.edits.push(o); if (fail) throw new Error(fail); if (o.parent !== undefined) c.parentId = o.parent; return c }
  return c
}
function guildWith(channels) {
  const map = new Map(channels.map((c) => [c.id, c]))
  return { id: 'G1', channels: { cache: { get: (id) => map.get(id) ?? null, values: () => map.values() } } }
}
const project = { id: 'p1', name: 'Framework', discordChannels: { bucketOpen: 'b-open', bucketInProgress: 'b-prog', bucketDone: 'b-done' } }
function deps(over = {}) {
  const log = []
  return {
    log,
    db: { project: { findFirst: async ({ where }) => { log.push(['project', where.id]); return over.project ?? project } } },
    retire: async (a) => { log.push(['retire', a.task.id, a.channel?.id ?? null]) },
    revive: async (a) => { log.push(['revive', a.task.id, a.channel?.id ?? null]) },
    now: () => new Date('2026-09-25T00:00:00Z'),
  }
}
async function quiet(fn) { const r = console.warn; console.warn = () => {}; try { return await fn() } finally { console.warn = r } }

test('no channel, no status, or the same bucket: nothing is read or edited', async () => {
  const d = deps()
  const g = guildWith([cat('b-open'), cat('b-prog'), ticket('c1', 'b-open')])
  assert.deepEqual(await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', status: 'open' }, updates: { status: 'done' }, ...d }), { moved: false, bucket: null, reason: 'no-channel' })
  assert.deepEqual(await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { title: 'x' }, ...d }), { moved: false, bucket: null, reason: 'no-status' })
  assert.deepEqual(await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'pending' }, ...d }), { moved: false, bucket: 'open', reason: 'same-bucket' })
  assert.deepEqual(d.log, [])
})

test('open → in progress moves the channel with a parent-only edit', async () => {
  const d = deps()
  const ch = ticket('c1', 'b-open')
  const g = guildWith([cat('b-open'), cat('b-prog'), cat('b-done'), ch])
  const out = await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'in_progress' }, ...d })
  assert.deepEqual(out, { moved: true, bucket: 'inProgress', reason: null })
  assert.deepEqual(ch.edits, [{ parent: 'b-prog' }])
  assert.deepEqual(d.log, [['project', 'p1']])
})

test('entering Done moves and retires; leaving Done moves and revives', async () => {
  const d = deps()
  const ch = ticket('c1', 'b-prog')
  const g = guildWith([cat('b-open'), cat('b-prog'), cat('b-done'), ch])
  await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'in_progress' }, updates: { status: 'done' }, ...d })
  assert.equal(ch.parentId, 'b-done')
  await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'done' }, updates: { status: 'open' }, ...d })
  assert.equal(ch.parentId, 'b-open')
  assert.deepEqual(d.log.filter((l) => l[0] !== 'project'), [['retire', 'T', 'c1'], ['revive', 'T', 'c1']])
})

test('a project-less ticket is not moved but IS retired when it finishes', async () => {
  const d = deps()
  const ch = ticket('c1', 'FEATURES')
  const g = guildWith([ch])
  const out = await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: null, discordChannelId: 'c1', status: 'open' }, updates: { status: 'closed' }, ...d })
  assert.deepEqual(out, { moved: false, bucket: 'done', reason: 'no-project' })
  assert.deepEqual(ch.edits, [])
  assert.deepEqual(d.log, [['retire', 'T', 'c1']])
})

test('a missing, wrong-typed or full bucket leaves the channel where it is, and Done still retires', async () => {
  const d = deps({ project: { ...project, discordChannels: { bucketOpen: 'b-open' } } })
  const ch = ticket('c1', 'b-open')
  const g = guildWith([cat('b-open'), ch])
  const out = await quiet(() => moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'done' }, ...d }))
  assert.deepEqual(out, { moved: false, bucket: 'done', reason: 'no-bucket' })
  assert.deepEqual(ch.edits, [])
  assert.deepEqual(d.log.at(-1), ['retire', 'T', 'c1'])

  const d2 = deps()
  const packed = Array.from({ length: 49 }, (_, i) => ({ id: `x${i}`, parentId: 'b-prog', type: ChannelType.GuildText }))
  const ch2 = ticket('c2', 'b-open')
  const g2 = guildWith([cat('b-open'), cat('b-prog'), ...packed, ch2])
  const out2 = await quiet(() => moveTicketToBucket({ guild: g2, task: { id: 'T', projectId: 'p1', discordChannelId: 'c2', status: 'open' }, updates: { status: 'in_progress' }, ...d2 }))
  assert.equal(out2.reason, 'full')
  assert.deepEqual(ch2.edits, [])
})

test('a channel already in its bucket is not edited', async () => {
  const d = deps()
  const ch = ticket('c1', 'b-prog')
  const g = guildWith([cat('b-open'), cat('b-prog'), ch])
  const out = await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'in_progress' }, ...d })
  assert.deepEqual(out, { moved: false, bucket: 'inProgress', reason: 'already-there' })
  assert.deepEqual(ch.edits, [])
})

test('an edit that throws, or a project read that throws, is reason error and never a throw', async () => {
  const d = deps()
  const ch = ticket('c1', 'b-open', { fail: 'Missing Permissions' })
  const g = guildWith([cat('b-open'), cat('b-prog'), ch])
  const out = await quiet(() => moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'in_progress' }, ...d }))
  assert.deepEqual(out, { moved: false, bucket: 'inProgress', reason: 'error' })

  const bad = { ...d, db: { project: { findFirst: async () => { throw new Error('db down') } } } }
  const out2 = await quiet(() => moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'in_progress' }, ...bad }))
  assert.equal(out2.reason, 'error')
})

test('a retire that throws is a warning; the move still counts', async () => {
  const d = deps()
  d.retire = async () => { throw new Error('db down') }
  const ch = ticket('c1', 'b-open')
  const g = guildWith([cat('b-open'), cat('b-done'), ch])
  const out = await quiet(() => moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'done' }, ...d }))
  assert.equal(out.moved, true)
})
