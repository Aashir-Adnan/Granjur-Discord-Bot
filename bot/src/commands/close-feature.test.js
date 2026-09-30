// Both seams (db, move) are faked: the root .env points at production.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute } from './close-feature.js'

function harness({ feature = { id: 'T1', title: 'Git Sync', status: 'open', projectId: 'p1', discordChannelId: 'c1', guildConfigId: 'g1' }, project = { id: 'p1', deletedAt: null } } = {}) {
  const log = []
  const channel = { id: 'c1', send: async (p) => { log.push(['send', p.content]) }, delete: async () => { log.push(['delete']) } }
  const interaction = {
    guild: { id: 'G1' }, channel, replies: [],
    options: { getAttachment: () => null },
    editReply: async (p) => { interaction.replies.push(p) },
  }
  const db = {
    feature: {
      findFirst: async ({ where }) => (where.discordChannelId === 'c1' ? feature : null),
      update: async (a) => { log.push(['update', a.data.status]) },
    },
    project: { findFirst: async ({ where }) => (project && where.id === project.id ? project : null) },
    ticketDoc: { findFirst: async () => null, update: async () => {}, create: async () => {} },
  }
  const move = async (a) => { log.push(['move', a.task.id, a.before.status, a.updates.status, a.db === db, a.guild?.id]); return { moved: true, archived: true, reason: null } }
  return { interaction, channel, db, move, log }
}

test('closing writes the status, tells the channel it is read-only for 14 days, and hands the row to the mover — no deletion', async () => {
  const h = harness()
  await execute(h.interaction, { db: h.db, move: h.move })
  assert.deepEqual(h.log, [
    ['update', 'closed'],
    ['send', 'This feature ticket has been closed. This channel is now read-only and will be removed in 14 days.'],
    ['move', 'T1', 'open', 'closed', true, 'G1'],
  ])
  assert.equal(h.interaction.replies[0].embeds[0].data.title, 'Feature ticket closed')
})

test('a mover that throws does not turn a successful close into an error', async () => {
  const h = harness()
  const real = console.warn
  console.warn = () => {}
  try {
    await execute(h.interaction, { db: h.db, move: async () => { throw new Error('boom') } })
  } finally { console.warn = real }
  assert.equal(h.log[0][0], 'update')
  assert.equal(h.interaction.replies.length, 1)
})

test('the issue seam is called with status: closed, and a returned line is sent to the channel', async () => {
  const h = harness()
  const syncCalls = []
  const syncIssue = async (a) => { syncCalls.push(a); h.log.push(['sync']); return { line: 'GitHub issue not closed — No GitHub access to o/r' } }
  await execute(h.interaction, { db: h.db, move: h.move, syncIssue })
  assert.equal(syncCalls.length, 1)
  assert.deepEqual(syncCalls[0].updates, { status: 'closed' })
  assert.equal(syncCalls[0].task.id, 'T1')
  // M4: the issue is synced before `move` locks the channel, and its line is
  // in the reply as well as the channel.
  assert.deepEqual(h.log, [
    ['update', 'closed'],
    ['sync'],
    ['send', 'This feature ticket has been closed. This channel is now read-only and will be removed in 14 days.'],
    ['send', 'GitHub issue not closed — No GitHub access to o/r'],
    ['move', 'T1', 'open', 'closed', true, 'G1'],
  ])
  assert.equal(h.interaction.replies[0].content, 'GitHub issue not closed — No GitHub access to o/r')
  assert.ok(h.interaction.replies[0].embeds[0], 'the embed is still in the reply')
})

test('no line from the issue seam: nothing extra is sent', async () => {
  const h = harness()
  const syncIssue = async () => ({ line: null })
  await execute(h.interaction, { db: h.db, move: h.move, syncIssue })
  assert.equal(h.log.filter((l) => l[0] === 'send').length, 1)
  assert.equal(h.interaction.replies[0].content, undefined, 'no line, no content in the reply')
})

test('outside a feature channel, or when already closed, nothing is written or moved', async () => {
  const h = harness({ feature: null })
  await execute(h.interaction, { db: h.db, move: h.move })
  assert.match(h.interaction.replies[0].content, /feature ticket/)
  const h2 = harness({ feature: { id: 'T1', status: 'closed', discordChannelId: 'c1' } })
  await execute(h2.interaction, { db: h2.db, move: h2.move })
  assert.match(h2.interaction.replies[0].content, /already closed/)
  assert.deepEqual([...h.log, ...h2.log], [])
})

test("a ticket of a deleted project is refused: nothing is written, synced or moved, so its archived channel is never stamped", async () => {
  const h = harness({ project: { id: 'p1', deletedAt: new Date('2026-10-01T09:00:00Z') } })
  let synced = 0
  await execute(h.interaction, { db: h.db, move: h.move, syncIssue: async () => { synced++; return { line: null } } })
  assert.deepEqual(h.interaction.replies, [{ content: 'This project is deleted.' }])
  assert.deepEqual(h.log, [], 'no update, no channel post, no move')
  assert.equal(synced, 0)
})
