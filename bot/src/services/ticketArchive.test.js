import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType } from 'discord.js'
import { ARCHIVE_DIVIDER_NAME, ARCHIVE_DIVIDER_TOPIC } from '../utils/ticketArchive.js'
import { placeTicketForStatus } from './ticketArchive.js'

const CAT = 'c1'

/** A ticket channel: the bot's own `Feature:` topic is what `isTicketChannel` reads. */
function ticket(id, rawPosition, { parentId = CAT } = {}) {
  return { id, name: `feature-${id}`, type: ChannelType.GuildText, parentId, rawPosition, topic: `Feature: Thing — Task ${id}` }
}

const divider = (id = 'div', rawPosition = 5) => ({
  id, name: ARCHIVE_DIVIDER_NAME, type: ChannelType.GuildText, parentId: CAT, rawPosition, topic: ARCHIVE_DIVIDER_TOPIC,
})

function guildWith(channels) {
  const map = new Map(channels.map((c) => [c.id, c]))
  const sent = []
  return {
    _sent: sent,
    id: 'G1',
    channels: {
      cache: { get: (id) => map.get(id) ?? null, values: () => map.values() },
      setPositions: async (list) => { sent.push(list); return undefined },
    },
  }
}

const project = { id: 'p1', name: 'Framework', discordChannels: { archiveDivider: 'div' } }

function deps(over = {}) {
  const log = []
  return {
    log,
    db: { project: { findFirst: async ({ where }) => { log.push(['project', where.id]); return 'project' in over ? over.project : project } } },
    retire: async (a) => { log.push(['retire', a.task.id, a.channel?.id ?? null]) },
    revive: async (a) => { log.push(['revive', a.task.id, a.channel?.id ?? null]) },
    now: () => new Date('2026-09-25T00:00:00Z'),
  }
}

async function quiet(fn) { const r = console.warn; console.warn = () => {}; try { return await fn() } finally { console.warn = r } }

/** The ids in the order one `setPositions` asked for. */
const orderOf = (guild, i = 0) => guild._sent[i].map((e) => e.channel)

test('no channel, no status, or a status that does not cross the line: nothing is read or reordered', async () => {
  const d = deps()
  const g = guildWith([divider(), ticket('t1', 1)])
  const base = { id: 'T', projectId: 'p1', discordChannelId: 't1', status: 'open' }
  assert.deepEqual(
    await placeTicketForStatus({ guild: g, task: { ...base, discordChannelId: null }, updates: { status: 'done' }, ...d }),
    { moved: false, archived: null, reason: 'no-channel' }
  )
  assert.deepEqual(
    await placeTicketForStatus({ guild: g, task: base, updates: { title: 'x' }, ...d }),
    { moved: false, archived: null, reason: 'no-status' }
  )
  // open → in_progress is still live: same zone, no reorder, no Done transition.
  assert.deepEqual(
    await placeTicketForStatus({ guild: g, task: base, updates: { status: 'in_progress' }, ...d }),
    { moved: false, archived: false, reason: 'same-zone' }
  )
  // done → closed is still finished.
  assert.deepEqual(
    await placeTicketForStatus({ guild: g, task: { ...base, status: 'done' }, updates: { status: 'closed' }, ...d }),
    { moved: false, archived: true, reason: 'same-zone' }
  )
  assert.deepEqual(d.log, [])
  assert.deepEqual(g._sent, [])
})

test('becoming finished sends the channel to the bottom of the archive and retires it', async () => {
  const d = deps()
  const g = guildWith([
    { id: 'sec', name: 'framework-members', type: ChannelType.GuildText, parentId: CAT, rawPosition: 0 },
    ticket('t1', 1), ticket('t2', 2), divider('div', 3), ticket('a1', 4),
  ])
  const out = await placeTicketForStatus({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 't1', status: 'open' }, updates: { status: 'done' }, ...d })
  assert.deepEqual(out, { moved: true, archived: true, reason: null })
  assert.equal(g._sent.length, 1, 'exactly one setPositions')
  // t1 lands BELOW the ticket that was already archived, not above it.
  assert.deepEqual(orderOf(g), ['sec', 't2', 'div', 'a1', 't1'])
  assert.deepEqual(d.log, [['project', 'p1'], ['retire', 'T', 't1']])
})

test('becoming live brings the channel back to the bottom of the live group and revives it', async () => {
  const d = deps()
  const g = guildWith([ticket('t1', 1), divider('div', 2), ticket('a1', 3), ticket('a2', 4)])
  const out = await placeTicketForStatus({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'a1', status: 'done' }, updates: { status: 'open' }, ...d })
  assert.deepEqual(out, { moved: true, archived: false, reason: null })
  assert.deepEqual(orderOf(g), ['t1', 'a1', 'div', 'a2'])
  assert.deepEqual(d.log, [['project', 'p1'], ['revive', 'T', 'a1']])
})

test('a channel already on the right side of the line is not reordered, but still crosses the boundary', async () => {
  const d = deps()
  // The last live ticket becomes finished while it is already the last channel
  // below the line — nothing to move, but it must still be locked and stamped.
  const g = guildWith([ticket('t1', 1), divider('div', 2), ticket('a1', 3)])
  const out = await placeTicketForStatus({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'a1', status: 'open' }, updates: { status: 'done' }, ...d })
  assert.deepEqual(out, { moved: false, archived: true, reason: 'already-there' })
  assert.deepEqual(g._sent, [])
  assert.deepEqual(d.log, [['project', 'p1'], ['retire', 'T', 'a1']])
})

test('a project-less ticket is not reordered but IS retired when it finishes', async () => {
  const d = deps()
  const g = guildWith([ticket('t1', 1, { parentId: 'FEATURES' })])
  const out = await placeTicketForStatus({ guild: g, task: { id: 'T', projectId: null, discordChannelId: 't1', status: 'open' }, updates: { status: 'closed' }, ...d })
  assert.deepEqual(out, { moved: false, archived: true, reason: 'no-project' })
  assert.deepEqual(g._sent, [])
  assert.deepEqual(d.log, [['retire', 'T', 't1']])
})

test('no divider — missing, deleted, not a text channel, or in another category — still runs the Done transition', async () => {
  for (const [what, channels, proj] of [
    ['none stored', [ticket('t1', 1)], { ...project, discordChannels: {} }],
    ['id no longer resolves', [ticket('t1', 1)], project],
    ['stored id is a category', [ticket('t1', 1), { id: 'div', type: ChannelType.GuildCategory, parentId: null }], project],
    ['divider sits in another category', [ticket('t1', 1), { ...divider(), parentId: 'ELSEWHERE' }], project],
  ]) {
    const d = deps({ project: proj })
    const g = guildWith(channels)
    const out = await quiet(() => placeTicketForStatus({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 't1', status: 'open' }, updates: { status: 'done' }, ...d }))
    assert.deepEqual(out, { moved: false, archived: true, reason: 'no-divider' }, what)
    assert.deepEqual(g._sent, [], what)
    assert.deepEqual(d.log.at(-1), ['retire', 'T', 't1'], what)
  }
})

test('a channel the task does not own is never reordered, retired or read about', async () => {
  // An unassigned meeting task carries the meeting's REVIEW channel id. Marking
  // it done must not reorder, lock or stamp the channel the whole meeting shares.
  const d = deps()
  const review = { id: 'rev', name: 'standup-review', type: ChannelType.GuildText, parentId: CAT, rawPosition: 1, topic: 'Meeting chat is stored…' }
  const g = guildWith([divider(), review])
  const out = await quiet(() => placeTicketForStatus({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'rev', status: 'open' }, updates: { status: 'done' }, ...d }))
  assert.deepEqual(out, { moved: false, archived: true, reason: 'not-ticket' })
  assert.deepEqual(g._sent, [])
  assert.deepEqual(d.log, [])
})

test('a channel that cannot be resolved still crosses the line, with no project read and no reorder', async () => {
  const d = deps()
  const g = guildWith([divider()])
  const out = await placeTicketForStatus({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'ghost', status: 'open' }, updates: { status: 'done' }, ...d })
  assert.deepEqual(out, { moved: false, archived: true, reason: 'no-channel' })
  assert.deepEqual(d.log, [['retire', 'T', null]])

  const d2 = deps()
  const g2 = guildWith([divider()])
  const out2 = await placeTicketForStatus({ guild: g2, task: { id: 'T', projectId: 'p1', discordChannelId: 'ghost', status: 'done' }, updates: { status: 'open' }, ...d2 })
  assert.deepEqual(out2, { moved: false, archived: false, reason: 'no-channel' })
  assert.deepEqual(d2.log, [['revive', 'T', null]])
})

test('a project read or a reorder that throws is reason error, never a throw, and the boundary still runs', async () => {
  const bad = { ...deps(), db: { project: { findFirst: async () => { throw new Error('db down') } } } }
  const g = guildWith([ticket('t1', 1), divider()])
  const out = await quiet(() => placeTicketForStatus({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 't1', status: 'open' }, updates: { status: 'done' }, ...bad }))
  assert.deepEqual(out, { moved: false, archived: true, reason: 'error' })

  const d = deps()
  const g2 = guildWith([ticket('t1', 1), divider('div', 2), ticket('a1', 3)])
  g2.channels.setPositions = async () => { throw new Error('Missing Permissions') }
  const out2 = await quiet(() => placeTicketForStatus({ guild: g2, task: { id: 'T', projectId: 'p1', discordChannelId: 'a1', status: 'done' }, updates: { status: 'open' }, ...d }))
  assert.deepEqual(out2, { moved: false, archived: false, reason: 'error' })
  assert.deepEqual(d.log.at(-1), ['revive', 'T', 'a1'])
})

test('a retire that throws is a warning; the reorder still counts', async () => {
  const d = deps()
  d.retire = async () => { throw new Error('db down') }
  const g = guildWith([ticket('t1', 1), ticket('t2', 2), divider('div', 3)])
  const out = await quiet(() => placeTicketForStatus({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 't1', status: 'open' }, updates: { status: 'done' }, ...d }))
  assert.equal(out.moved, true)
  assert.deepEqual(orderOf(g), ['t2', 'div', 't1'])
})
