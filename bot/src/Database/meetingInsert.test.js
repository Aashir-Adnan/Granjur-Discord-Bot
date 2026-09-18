import { test } from 'node:test'
import assert from 'node:assert/strict'
import { meetingInsertSql } from './index.js'

test('meeting insert: one ordered array drives the column list and the params', () => {
  const { sql, params } = meetingInsertSql('m1', {
    guildConfigId: 'cfg1', channelId: 'v1', projectId: 'p1',
  })
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
  assert.deepEqual(cols, [
    'id', 'guildConfigId', 'channelId', 'externalId', 'transcript', 'notes', 'projectId', 'repositoryUrl',
  ])
  assert.deepEqual(params, ['m1', 'cfg1', 'v1', null, null, null, 'p1', null])
  assert.equal((sql.match(/\?/g) || []).length, params.length)
  assert.equal(cols.length, params.length)
  assert.match(sql, /^INSERT INTO `meeting` \(/)
})

test('meeting insert: no projectId writes NULL, exactly as before', () => {
  const { params } = meetingInsertSql('m2', { guildConfigId: 'cfg1', channelId: 'v1' })
  assert.deepEqual(params, ['m2', 'cfg1', 'v1', null, null, null, null, null])
})
