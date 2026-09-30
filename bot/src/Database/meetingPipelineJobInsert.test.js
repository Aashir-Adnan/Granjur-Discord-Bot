import { test } from 'node:test'
import assert from 'node:assert/strict'
import { meetingPipelineJobInsertSql } from './index.js'

test('a job created without dataJson writes exactly the statement it always did', () => {
  const { sql, params } = meetingPipelineJobInsertSql('j1', { guildConfigId: 'cfg1', meetingId: 'm1' })
  assert.equal(sql, 'INSERT INTO `meeting_pipeline_job` (id, guildConfigId, meetingId) VALUES (?, ?, ?)')
  assert.deepEqual(params, ['j1', 'cfg1', 'm1'])
})

test('a dataJson that is already a string is written as given, not serialised twice', () => {
  const { params } = meetingPipelineJobInsertSql('j3', { guildConfigId: 'cfg1', meetingId: 'm3', dataJson: '{"a":1}' })
  assert.equal(params[3], '{"a":1}')
})

test('a job created with dataJson writes it, serialised, in the same INSERT', () => {
  const dataJson = { source: 'document', reviewChannelId: 'c1', title: 'Plan' }
  const { sql, params } = meetingPipelineJobInsertSql('j2', { guildConfigId: 'cfg1', meetingId: 'm2', dataJson })
  assert.equal(sql, 'INSERT INTO `meeting_pipeline_job` (id, guildConfigId, meetingId, dataJson) VALUES (?, ?, ?, ?)')
  assert.deepEqual(params, ['j2', 'cfg1', 'm2', JSON.stringify(dataJson)])
})
