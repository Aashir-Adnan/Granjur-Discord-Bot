import { test } from 'node:test'
import assert from 'node:assert/strict'
import { data, execute } from './client-tracking.js'

const ix = (name, opts = {}) => {
  const i = {
    guild: { id: 'g1', members: { cache: new Map([['u-dev', { displayName: 'Sam' }]]) } },
    user: { id: 'u-c' }, commandName: name, replies: [],
    options: { getString: (n) => opts[n] ?? null },
    editReply: async (p) => { i.replies.push(p) },
  }
  return i
}

test('two builders with the spec\'s names', () => {
  assert.deepEqual(data.map((b) => b.name), ['my-requests', 'request-report'])
})

test('my-requests lists only the caller\'s requests, newest first', async () => {
  const db = { task: { findMany: async (args) => { db.args = args; return [{ id: 't1', type: 'bug', title: 'A', status: 'pending', projectName: 'P', discordChannelId: 'c1' }] } } }
  const i = ix('my-requests')
  await execute(i, { db, getConfig: async () => ({ id: 'cfg1' }) })
  assert.equal(db.args.where.requestedBy, 'u-c')
  assert.equal(db.args.orderBy.createdAt, 'desc')
  assert.match(i.replies[0].embeds[0].toJSON().description, /Waiting on you/)
})

test('another client\'s request is refused identically to a missing one', async () => {
  const db = {
    task: { findFirst: async ({ where }) => (where.id === 'theirs' ? { id: 'theirs', requestedBy: 'u-other', title: 'SECRET' } : null) },
    taskActivity: { findByTask: async () => [] },
  }
  const a = ix('request-report', { request: 'theirs' })
  const b = ix('request-report', { request: 'nope' })
  await execute(a, { db, getConfig: async () => ({ id: 'cfg1' }) })
  await execute(b, { db, getConfig: async () => ({ id: 'cfg1' }) })
  assert.equal(a.replies[0].content, b.replies[0].content)
  assert.ok(!a.replies[0].content.includes('SECRET'))
})

test('request-report renders status, handler, dates and a filtered timeline', async () => {
  const db = {
    task: { findFirst: async () => ({ id: 't1', requestedBy: 'u-c', type: 'feature', title: 'Export', projectName: 'P', status: 'in_progress', assigneeIds: ['u-dev'], createdAt: new Date('2026-09-20T00:00:00Z'), updatedAt: new Date('2026-09-24T00:00:00Z') }) },
    taskActivity: { findByTask: async () => [{ createdAt: new Date('2026-09-21T00:00:00Z'), changes: [{ field: 'estimateMinutes', from: null, to: 60 }, { field: 'status', from: 'open', to: 'in_progress' }] }] },
  }
  const i = ix('request-report', { request: 't1' })
  await execute(i, { db, getConfig: async () => ({ id: 'cfg1' }) })
  const json = i.replies[0].embeds[0].toJSON()
  const text = JSON.stringify(json)
  assert.match(text, /Sam/)
  assert.match(text, /in progress/)
  assert.ok(!text.includes('60'), 'estimate never renders')
})
