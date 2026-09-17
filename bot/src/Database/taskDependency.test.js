import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  taskDependencyInsertSql,
  projectMemberUpsertSql,
  guildMemberUpdateSets,
  guildMemberInsertSql,
} from './index.js'

// Column list and params must come from ONE array. The utterance table's
// insert once had two independent lists that drifted; these tests exist so
// that cannot happen again here.

test('taskdependency insert: placeholders equal params, and params follow column order', () => {
  const { sql, params } = taskDependencyInsertSql({
    id: 'dep1', guildConfigId: 'g1', taskId: 'tA', blockedByTaskId: 'tB', createdBy: 'u1',
  })
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
  assert.equal((sql.match(/\?/g) || []).length, params.length)
  assert.deepEqual(cols, ['id', 'guildConfigId', 'taskId', 'blockedByTaskId', 'createdBy'])
  assert.deepEqual(params, ['dep1', 'g1', 'tA', 'tB', 'u1'])
  assert.match(sql, /INSERT IGNORE INTO `taskdependency`/)
})

test('projectmember upsert: re-adding updates the role and nothing else', () => {
  const { sql, params } = projectMemberUpsertSql({
    id: 'pm1', guildConfigId: 'g1', projectId: 'p1', discordId: 'u1', role: 'lead', addedBy: 'u9',
  })
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
  assert.deepEqual(cols, ['id', 'guildConfigId', 'projectId', 'discordId', 'role', 'addedBy'])
  assert.deepEqual(params, ['pm1', 'g1', 'p1', 'u1', 'lead', 'u9'])
  assert.match(sql, /ON DUPLICATE KEY UPDATE role = VALUES\(role\), addedBy = VALUES\(addedBy\)$/)
})

test('projectmember upsert: role defaults to developer and createdBy may be null', () => {
  const { params } = projectMemberUpsertSql({ id: 'x', guildConfigId: 'g', projectId: 'p', discordId: 'u' })
  assert.equal(params[4], 'developer')
  assert.equal(params[5], null)
})

test('guildmember update sets: name columns are written only when given', () => {
  assert.deepEqual(guildMemberUpdateSets({ displayName: 'Nauraiz', username: 'nauraiz_101104' }), {
    sets: ['displayName = ?', 'username = ?'],
    vals: ['Nauraiz', 'nauraiz_101104'],
  })
  assert.deepEqual(guildMemberUpdateSets({ status: 'holding' }), { sets: ['status = ?'], vals: ['holding'] })
  assert.deepEqual(guildMemberUpdateSets({}), { sets: [], vals: [] })
})

test('guildmember insert: placeholders equal params, and params follow column order', () => {
  const { sql, params } = guildMemberInsertSql({
    id: 'gm1', guildConfigId: 'g1', discordId: 'd1', email: 'a@granjur.com',
    verifiedAt: '2026-09-17 00:00:00', status: 'verified', roleIds: ['r1', 'r2'],
    displayName: 'Nauraiz', username: 'nauraiz_101104',
  })
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
  assert.equal((sql.match(/\?/g) || []).length, params.length)
  assert.deepEqual(cols, ['id', 'guildConfigId', 'discordId', 'email', 'verifiedAt', 'status', 'roleIds', 'displayName', 'username'])
  assert.deepEqual(params, ['gm1', 'g1', 'd1', 'a@granjur.com', '2026-09-17 00:00:00', 'verified', '["r1","r2"]', 'Nauraiz', 'nauraiz_101104'])
  assert.match(sql, /INSERT INTO `guildmember`/)
})

test('guildmember insert: unspecified fields fall back to the insert defaults', () => {
  const { params } = guildMemberInsertSql({ id: 'gm2', guildConfigId: 'g1', discordId: 'd2' })
  assert.deepEqual(params, ['gm2', 'g1', 'd2', null, null, 'pending', '[]', null, null])
})
