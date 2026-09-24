import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUCKETS, bucketFor, isDoneBucket, bucketByKey, bucketNameFor, bucketIdsOf, MAX_CATEGORY_NAME } from './statusBuckets.js'

test('every status maps to its bucket; unknown, empty and null file as open', () => {
  assert.equal(bucketFor('open'), 'open')
  assert.equal(bucketFor('pending'), 'open')
  assert.equal(bucketFor('in_progress'), 'inProgress')
  for (const s of ['done', 'resolved', 'closed', 'abandoned']) assert.equal(bucketFor(s), 'done')
  // Case and whitespace do not matter: a status typed by hand on the site still files.
  assert.equal(bucketFor('IN_PROGRESS'), 'inProgress')
  assert.equal(bucketFor(' Done '), 'done')
  assert.equal(bucketFor(null), 'open')
  assert.equal(bucketFor(undefined), 'open')
  assert.equal(bucketFor(''), 'open')
  assert.equal(bucketFor('whatever'), 'open')
})

test('isDoneBucket is true for done only', () => {
  assert.equal(isDoneBucket('done'), true)
  assert.equal(isDoneBucket('open'), false)
  assert.equal(isDoneBucket('inProgress'), false)
  assert.equal(isDoneBucket(null), false)
})

test('bucketByKey finds the table row, null for anything else', () => {
  assert.equal(bucketByKey('inProgress').storeKey, 'bucketInProgress')
  assert.equal(bucketByKey('nope'), null)
})

test('bucket names: folder emoji, upper-cased name, the label', () => {
  const p = { name: 'Framework' }
  assert.equal(bucketNameFor(p, 'open'), '📂 FRAMEWORK · OPEN')
  assert.equal(bucketNameFor(p, 'inProgress'), '📂 FRAMEWORK · IN PROGRESS')
  assert.equal(bucketNameFor(p, BUCKETS[2]), '📂 FRAMEWORK · DONE')
  assert.equal(bucketNameFor({ name: '  ubs doc ' }, 'done'), '📂 UBS DOC · DONE')
  assert.throws(() => bucketNameFor(p, 'nope'), /unknown bucket/)
})

test('a long project name is cut so the label survives at 100 characters', () => {
  const name = bucketNameFor({ name: 'x'.repeat(120) }, 'inProgress')
  assert.equal(name.length, MAX_CATEGORY_NAME)
  assert.ok(name.endsWith(' · IN PROGRESS'))
  assert.ok(name.startsWith('📂 XXX'))
})

test('bucketIdsOf reads the stored map — object or JSON string — with missing keys as null', () => {
  assert.deepEqual(
    bucketIdsOf({ discordChannels: { bucketOpen: 'a', bucketDone: 'c', members: 'm' } }),
    { open: 'a', inProgress: null, done: 'c' }
  )
  assert.deepEqual(
    bucketIdsOf({ discordChannels: JSON.stringify({ bucketInProgress: 'b' }) }),
    { open: null, inProgress: 'b', done: null }
  )
  assert.deepEqual(bucketIdsOf({ discordChannels: '{not json' }), { open: null, inProgress: null, done: null })
  assert.deepEqual(bucketIdsOf({}), { open: null, inProgress: null, done: null })
  assert.deepEqual(bucketIdsOf(null), { open: null, inProgress: null, done: null })
})

test('store keys are three distinct bucket* keys, so they never collide with a section key', () => {
  const keys = BUCKETS.map((b) => b.storeKey)
  assert.deepEqual(keys, ['bucketOpen', 'bucketInProgress', 'bucketDone'])
  assert.deepEqual(BUCKETS.map((b) => b.key), ['open', 'inProgress', 'done'])
})
