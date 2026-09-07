import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  meetingUtteranceInsertSql,
  meetingUtteranceFindManySql,
  meetingUtteranceCountSql,
  meetingUpdateSql,
} from './index.js'

test('the insert derives its column order and params from one source, so they cannot drift', () => {
  const startedAt = new Date('2026-01-01T00:00:00Z')
  const { sql, params } = meetingUtteranceInsertSql({
    id: 'u1',
    guildConfigId: 'g1',
    meetingId: 'm1',
    sequence: 3,
    speakerRef: 'spk-1',
    speakerName: 'Alice',
    startedAt,
    durationMs: 1500,
    text: 'hello',
  })
  assert.ok(sql.includes('`meetingutterance`'), 'lowercase table name')
  const columnList = sql.match(/INSERT INTO `meetingutterance` \(([^)]+)\)/)[1]
  const columns = columnList.split(',').map((c) => c.trim())
  assert.deepEqual(
    columns,
    ['id', 'guildConfigId', 'meetingId', '`sequence`', 'speakerRef', 'speakerName', 'startedAt', 'durationMs', 'text'],
    'column order must match the params order exactly',
  )
  assert.deepEqual(params, ['u1', 'g1', 'm1', 3, 'spk-1', 'Alice', startedAt, 1500, 'hello'])
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
