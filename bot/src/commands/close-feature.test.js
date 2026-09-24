// Both seams (db, move) are faked: the root .env points at production.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute } from './close-feature.js'

function harness({ feature = { id: 'T1', title: 'Git Sync', status: 'open', projectId: 'p1', discordChannelId: 'c1', guildConfigId: 'g1' } } = {}) {
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
    ticketDoc: { findFirst: async () => null, update: async () => {}, create: async () => {} },
  }
  const move = async (a) => { log.push(['move', a.task.id, a.before.status, a.updates.status, a.db === db, a.guild?.id]); return { moved: true, bucket: 'done', reason: null } }
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

test('outside a feature channel, or when already closed, nothing is written or moved', async () => {
  const h = harness({ feature: null })
  await execute(h.interaction, { db: h.db, move: h.move })
  assert.match(h.interaction.replies[0].content, /feature ticket/)
  const h2 = harness({ feature: { id: 'T1', status: 'closed', discordChannelId: 'c1' } })
  await execute(h2.interaction, { db: h2.db, move: h2.move })
  assert.match(h2.interaction.replies[0].content, /already closed/)
  assert.deepEqual([...h.log, ...h2.log], [])
})
