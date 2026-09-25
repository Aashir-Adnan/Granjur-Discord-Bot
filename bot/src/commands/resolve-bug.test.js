// Both seams (db, move) are faked: the root .env points at production.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute } from './resolve-bug.js'

function harness({ ticket = { id: 'T1', title: 'Crash on save', status: 'pending', projectId: 'p1', discordChannelId: 'c1', guildConfigId: 'g1' }, attachment = { url: 'https://x/fix.md', name: 'fix.md', contentType: 'text/markdown' } } = {}) {
  const log = []
  const channel = { id: 'c1', send: async (p) => { log.push(['send', p.content]) }, delete: async () => { log.push(['delete']) } }
  const interaction = {
    guild: { id: 'G1' }, channel, replies: [],
    options: { getAttachment: () => attachment },
    editReply: async (p) => { interaction.replies.push(p) },
  }
  const db = {
    bugTicket: {
      findFirst: async ({ where }) => (where.discordChannelId === 'c1' ? ticket : null),
      update: async (a) => { log.push(['update', a.data.status]) },
    },
    ticketDoc: { findFirst: async () => ({ id: 'd1' }), update: async () => {}, create: async () => {} },
  }
  const move = async (a) => { log.push(['move', a.task.id, a.before.status, a.updates.status, a.db === db, a.guild?.id]); return { moved: true, archived: true, reason: null } }
  return { interaction, channel, db, move, log }
}

test('resolving writes the status, tells the channel it is read-only for 14 days, and hands the row to the mover — no deletion', async () => {
  const h = harness()
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ text: async () => '# fix' })
  try {
    await execute(h.interaction, { db: h.db, move: h.move })
  } finally { globalThis.fetch = realFetch }
  assert.deepEqual(h.log, [
    ['update', 'resolved'],
    ['send', 'This bug ticket has been resolved. This channel is now read-only and will be removed in 14 days.'],
    ['move', 'T1', 'pending', 'resolved', true, 'G1'],
  ])
  assert.equal(h.interaction.replies[0].embeds[0].data.title, 'Bug ticket resolved')
})

test('a mover that throws does not turn a successful resolve into an error', async () => {
  const h = harness()
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ text: async () => '# fix' })
  const real = console.warn
  console.warn = () => {}
  try {
    await execute(h.interaction, { db: h.db, move: async () => { throw new Error('boom') } })
  } finally {
    console.warn = real
    globalThis.fetch = realFetch
  }
  assert.equal(h.log[0][0], 'update')
  assert.equal(h.interaction.replies.length, 1)
})

test('outside a bug channel, or when already resolved, nothing is written or moved', async () => {
  const h = harness({ ticket: null })
  await execute(h.interaction, { db: h.db, move: h.move })
  assert.match(h.interaction.replies[0].content, /bug ticket/)
  const h2 = harness({ ticket: { id: 'T1', status: 'resolved', discordChannelId: 'c1' } })
  await execute(h2.interaction, { db: h2.db, move: h2.move })
  assert.match(h2.interaction.replies[0].content, /already resolved/)
  assert.deepEqual([...h.log, ...h2.log], [])
})

test('no attachment: asks for one, nothing written or moved', async () => {
  const h = harness({ attachment: null })
  await execute(h.interaction, { db: h.db, move: h.move })
  assert.match(h.interaction.replies[0].content, /attach/)
  assert.deepEqual(h.log, [])
})
