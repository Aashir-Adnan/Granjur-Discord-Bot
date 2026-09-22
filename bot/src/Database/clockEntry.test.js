import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clockEntryInsertSql, clockEntryUpdateSets, clockEntryRemove, taskInsertSql } from './index.js'

test('clockentry insert: placeholders equal params and follow the column order', () => {
  const { sql, params } = clockEntryInsertSql({
    guildConfigId: 'g1', discordId: 'u1', clockInAt: '2026-09-22 09:00:00',
    clockOutAt: '2026-09-22 10:30:00', taskId: 't1', minutes: 90, note: 'pairing', source: 'timer',
  }, 'ce1')
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
  assert.deepEqual(cols, ['id', 'guildConfigId', 'discordId', 'clockInAt', 'clockOutAt', 'taskId', 'minutes', 'note', 'source'])
  assert.equal((sql.match(/\?/g) || []).length, params.length)
  assert.deepEqual(params, ['ce1', 'g1', 'u1', '2026-09-22 09:00:00', '2026-09-22 10:30:00', 't1', 90, 'pairing', 'timer'])
  assert.match(sql, /INSERT INTO `clockentry`/)
})

test('clockentry insert: an open general-work entry defaults cleanly', () => {
  const { params } = clockEntryInsertSql({ guildConfigId: 'g1', discordId: 'u1', clockInAt: 'X' }, 'ce2')
  assert.deepEqual(params, ['ce2', 'g1', 'u1', 'X', null, null, null, null, 'timer'])
})

test('clockentry update: only the fields given are written, and the table name is lowercase', () => {
  assert.deepEqual(clockEntryUpdateSets({ clockOutAt: 'X', minutes: 42 }), {
    sets: ['clockOutAt = ?', 'minutes = ?'], vals: ['X', 42],
  })
  assert.deepEqual(clockEntryUpdateSets({ remindedAt: 'R' }), { sets: ['remindedAt = ?'], vals: ['R'] })
  assert.deepEqual(clockEntryUpdateSets({ taskId: null, note: 'n', source: 'manual' }), {
    sets: ['taskId = ?', 'note = ?', 'source = ?'], vals: [null, 'n', 'manual'],
  })
  assert.deepEqual(clockEntryUpdateSets({}), { sets: [], vals: [] })
})

test('task insert: estimateMinutes is a column and its value lands in the matching param slot', () => {
  const build = (data) => {
    const { sql, params } = taskInsertSql({ guildConfigId: 'g1', ...data }, 'pk')
    const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
    return params[cols.indexOf('estimateMinutes')]
  }
  const cols = taskInsertSql({ guildConfigId: 'g1' }, 'pk').sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
  assert.ok(cols.includes('estimateMinutes'))
  assert.equal(build({ estimateMinutes: 240 }), 240)
  assert.equal(build({}), null)
})

// The remove test injects the query runner: nothing here touches a database.
test('clockentry remove: deletes by id from the lowercase table and reports how many rows went', async () => {
  const calls = []
  const run = async (sql, params) => { calls.push([sql, params]); return { affectedRows: 1 } }
  assert.deepEqual(await clockEntryRemove('ce1', { run }), { removed: 1 })
  assert.deepEqual(calls, [['DELETE FROM `clockentry` WHERE id = ?', ['ce1']]])
})

test('clockentry remove: an id that is already gone reports zero removed', async () => {
  assert.deepEqual(await clockEntryRemove('nope', { run: async () => ({ affectedRows: 0 }) }), { removed: 0 })
  assert.deepEqual(await clockEntryRemove('nope', { run: async () => undefined }), { removed: 0 })
})
