import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleStatusRequest } from './internalTaskRoute.js'

const task = { id: 'A', guildConfigId: 'g1', title: 'Git Sync', status: 'open' }
const db = {
  task: { findFirst: async ({ where }) => (where.id === 'A' ? task : null) },
  guildMember: { findByConfigEmail: async ({ where }) => (where.email === 'a@granjur.com' ? { discordId: 'u-aashir' } : null) },
}
const ok = { headers: { 'x-internal-secret': 's3cret' }, body: { taskId: 'A', status: 'in_progress', actor: { email: 'a@granjur.com', name: 'Aashir' } } }

test('503 when no secret is configured, before anything else', async () => {
  const r = await handleStatusRequest({ ...ok, db, client: {}, secret: '' })
  assert.equal(r.status, 503)
})
test('401 on a missing or wrong secret', async () => {
  assert.equal((await handleStatusRequest({ ...ok, headers: {}, db, client: {}, secret: 's3cret' })).status, 401)
  assert.equal((await handleStatusRequest({ ...ok, headers: { 'x-internal-secret': 'nope' }, db, client: {}, secret: 's3cret' })).status, 401)
})
test('400 on an unknown status or missing taskId', async () => {
  assert.equal((await handleStatusRequest({ ...ok, body: { ...ok.body, status: 'flying' }, db, client: {}, secret: 's3cret' })).status, 400)
  const r = await handleStatusRequest({ ...ok, body: { status: 'open' }, db, client: {}, secret: 's3cret' })
  assert.equal(r.status, 400)
  assert.equal(r.body.message, 'taskId is required')
})
test('400 when taskId is over the length cap', async () => {
  const r = await handleStatusRequest({ ...ok, body: { ...ok.body, taskId: 'x'.repeat(65) }, db, client: {}, secret: 's3cret' })
  assert.equal(r.status, 400)
  assert.equal(r.body.message, 'taskId is too long (max 64)')
})
test('a null or non-object body is treated as empty, not a crash', async () => {
  const r1 = await handleStatusRequest({ headers: ok.headers, body: null, db, client: {}, secret: 's3cret' })
  assert.equal(r1.status, 400)
  assert.equal(r1.body.message, 'taskId is required')
  const r2 = await handleStatusRequest({ headers: ok.headers, body: 'x', db, client: {}, secret: 's3cret' })
  assert.equal(r2.status, 400)
  assert.equal(r2.body.message, 'taskId is required')
})
test('404 when the task does not exist', async () => {
  assert.equal((await handleStatusRequest({ ...ok, body: { ...ok.body, taskId: 'Z' }, db, client: {}, secret: 's3cret' })).status, 404)
})
test('same status is a no-op 200', async () => {
  let applied = 0
  const r = await handleStatusRequest({ ...ok, body: { ...ok.body, status: 'open' }, db, client: {}, secret: 's3cret', apply: async () => { applied++ } })
  assert.equal(r.status, 200); assert.equal(r.body.unchanged, true); assert.equal(applied, 0)
})
test('success applies with a "(via the site)" label and returns the warning', async () => {
  let seen
  const r = await handleStatusRequest({ ...ok, db, client: { c: 1 }, secret: 's3cret', apply: async (a) => { seen = a; return { warning: '⛔ x', notified: {} } } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, task: { id: 'A', status: 'in_progress' }, warning: '⛔ x', unchanged: false })
  assert.deepEqual(seen.updates, { status: 'in_progress' })
  assert.equal(seen.actor.label, 'Aashir (via the site)')
})
test('a thrown error becomes 500 without leaking a stack', async () => {
  const errors = []; const orig = console.error; console.error = (...a) => errors.push(a)
  try {
    const r = await handleStatusRequest({ ...ok, db, client: {}, secret: 's3cret', apply: async () => { throw new Error('db down') } })
    assert.equal(r.status, 500); assert.equal(r.body.ok, false); assert.equal(r.body.message, 'db down')
  } finally { console.error = orig }
})

test('the site user is matched to their Discord member by email for the activity log', async () => {
  let seen
  await handleStatusRequest({ ...ok, db, client: {}, secret: 's3cret', apply: async (a) => { seen = a; return { warning: '' } } })
  assert.equal(seen.actor.activityId, 'u-aashir')
  // The mention-triggering id is deliberately not set: a site edit never @mentions.
  assert.equal(seen.actor.discordId, undefined)
})
test('an email with no verified member still applies, with no activity id', async () => {
  let seen
  const other = { ...ok, body: { ...ok.body, actor: { email: 'nobody@granjur.com', name: 'Nobody' } } }
  const r = await handleStatusRequest({ ...other, db, client: {}, secret: 's3cret', apply: async (a) => { seen = a; return { warning: '' } } })
  assert.equal(r.status, 200)
  assert.equal(seen.actor.activityId, null)
})
test('a failing member lookup never blocks the update', async () => {
  const orig = console.error; console.error = () => {}
  try {
    let seen
    const broken = { ...db, guildMember: { findByConfigEmail: async () => { throw new Error('boom') } } }
    const r = await handleStatusRequest({ ...ok, db: broken, client: {}, secret: 's3cret', apply: async (a) => { seen = a; return { warning: '' } } })
    assert.equal(r.status, 200)
    assert.equal(seen.actor.activityId, null)
  } finally { console.error = orig }
})
