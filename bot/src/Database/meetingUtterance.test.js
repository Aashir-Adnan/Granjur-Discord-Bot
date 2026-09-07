import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  meetingUtteranceInsertSql,
  meetingUtteranceFindManySql,
  meetingUtteranceCountSql,
  meetingUpdateSql,
} from './index.js'

test('the insert names every column the caller can set', () => {
  const { sql } = meetingUtteranceInsertSql()
  for (const col of ['guildConfigId', 'meetingId', 'sequence', 'speakerRef', 'speakerName', 'startedAt', 'durationMs', 'text']) {
    assert.ok(sql.includes(col), `insert is missing ${col}`)
  }
  assert.ok(sql.includes('`meetingutterance`'), 'lowercase table name')
})

test('findMany orders by sequence so capture order is preserved', () => {
  const { sql, params } = meetingUtteranceFindManySql({ meetingId: 'm1' })
  assert.ok(/ORDER BY\s+`?sequence`?\s+ASC/i.test(sql), sql)
  assert.deepEqual(params, ['m1'])
})

test('countWithText ignores empty and whitespace-only rows', () => {
  const { sql, params } = meetingUtteranceCountSql({ meetingId: 'm1' })
  assert.ok(/COUNT\(\*\)/i.test(sql))
  assert.ok(/TRIM\(/i.test(sql), 'whitespace-only text must not count')
  assert.deepEqual(params, ['m1'])
})

test('meetingUpdate persists csaasMeetingId', () => {
  const { sets, vals } = meetingUpdateSql({ csaasMeetingId: 'csaas-9' })
  assert.deepEqual(sets, ['csaasMeetingId = ?'])
  assert.deepEqual(vals, ['csaas-9'])
})

test('meetingUpdate still persists transcript and notes', () => {
  const { sets } = meetingUpdateSql({ transcript: 't', notes: 'n' })
  assert.deepEqual(sets, ['transcript = ?', 'notes = ?'])
})
