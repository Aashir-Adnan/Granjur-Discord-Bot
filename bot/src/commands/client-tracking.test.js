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

// --- client managers ------------------------------------------------------------------

const T_MINE = { id: 't-mine', type: 'bug', title: 'Mine', status: 'open', projectId: 'p1', projectName: 'P', requestedBy: 'u-c', createdAt: new Date('2026-09-20T00:00:00Z') }
const T_TEAM = { id: 't-team', type: 'feature', title: 'Theirs', status: 'pending', projectId: 'p1', projectName: 'P', requestedBy: 'u-c2', createdAt: new Date('2026-09-21T00:00:00Z') }
const T_STAFF = { id: 't-staff', type: 'feature', title: 'Refactor', status: 'open', projectId: 'p1', projectName: 'P', requestedBy: null, createdAt: new Date('2026-09-22T00:00:00Z') }
const T_OTHER = { id: 't-other', type: 'bug', title: 'Elsewhere', status: 'open', projectId: 'p9', projectName: 'Q', requestedBy: 'u-c3', createdAt: new Date('2026-09-23T00:00:00Z') }

function managerDb({ manages = ['p1'] } = {}) {
  const all = [T_MINE, T_TEAM, T_STAFF, T_OTHER]
  return {
    projectMember: { findByMember: async () => manages.map((projectId) => ({ projectId, role: 'client_manager' })) },
    task: {
      findMany: async ({ where }) => all.filter((t) => (where.requestedBy ? t.requestedBy === where.requestedBy : true) && (where.projectId ? t.projectId === where.projectId : true)),
      findFirst: async ({ where }) => all.find((t) => t.id === where.id) ?? null,
    },
    taskActivity: { findByTask: async () => [] },
  }
}

test('a client manager sees their team\'s requests on the managed project — never a team task, never another project', async () => {
  const i = ix('my-requests')
  i.guild.members.cache.set('u-c2', { displayName: 'Ali' })
  await execute(i, { db: managerDb(), getConfig: async () => ({ id: 'cfg1' }) })
  const text = i.replies[0].embeds[0].toJSON().description
  assert.match(text, /\*\*Theirs\*\* · raised by Ali/)
  assert.match(text, /\*\*Mine\*\*/)
  assert.ok(!text.includes('Refactor'), 'a task the team created is not a request')
  assert.ok(!text.includes('Elsewhere'), 'a request on a project they do not manage')
  assert.ok(text.indexOf('Theirs') < text.indexOf('Mine'), 'newest first across own and team')
})

test('a plain client on the same project still sees only their own', async () => {
  const i = ix('my-requests')
  await execute(i, { db: managerDb({ manages: [] }), getConfig: async () => ({ id: 'cfg1' }) })
  const text = i.replies[0].embeds[0].toJSON().description
  assert.ok(text.includes('Mine') && !text.includes('Theirs'))
})

test('request-report opens a managed project\'s request to the manager, and still refuses the rest identically', async () => {
  const ok = ix('request-report', { request: 't-team' })
  await execute(ok, { db: managerDb(), getConfig: async () => ({ id: 'cfg1' }) })
  assert.match(JSON.stringify(ok.replies[0]), /Theirs/)
  const staff = ix('request-report', { request: 't-staff' })
  const other = ix('request-report', { request: 't-other' })
  const missing = ix('request-report', { request: 'nope' })
  for (const i of [staff, other, missing]) await execute(i, { db: managerDb(), getConfig: async () => ({ id: 'cfg1' }) })
  assert.equal(staff.replies[0].content, missing.replies[0].content, 'a team task is refused like a missing id')
  assert.equal(other.replies[0].content, missing.replies[0].content, 'another project\'s request is refused like a missing id')
})
