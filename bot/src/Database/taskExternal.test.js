import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTaskInsertValues } from './taskInsert.helpers.js'

test('externalId + meetingId are included and default to null', () => {
  const full = buildTaskInsertValues({ guildConfigId: 'g', title: 't', externalId: 'csaas:1', meetingId: 'm' })
  assert.equal(full.externalId, 'csaas:1')
  assert.equal(full.meetingId, 'm')
  const bare = buildTaskInsertValues({ guildConfigId: 'g', title: 't' })
  assert.equal(bare.externalId, null)
  assert.equal(bare.meetingId, null)
})
