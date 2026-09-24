import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { taskInsertSql, guildMemberInsertSql, guildMemberUpdateSets } from './index.js'
import { ROLE_CLIENT, CATEGORY_SUPPORT, CHANNEL_SUPPORT, CHANNEL_SUPPORT_VOICE, ROLE_COLORS } from '../constants.js'

const here = path.dirname(fileURLToPath(import.meta.url))

test('migration 025 adds every column the client role needs, each behind an information_schema guard', () => {
  const sql = readFileSync(path.join(here, 'migrations', '025_client_role.sql'), 'utf8')
  for (const [table, column] of [
    ['guildconfig', 'clientRoleId'],
    ['guildconfig', 'supportChannelId'],
    ['guildconfig', 'supportVoiceChannelId'],
    ['guildmember', 'kind'],
    ['pendinginvite', 'kind'],
    ['task', 'requestedBy'],
  ]) {
    assert.match(sql, new RegExp(`TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`), `${table}.${column} guard`)
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN ${column} `), `${table}.${column} add`)
  }
  assert.match(sql, /INDEX_NAME = 'idx_task_requestedBy'/)
  assert.match(sql, /ADD INDEX idx_task_requestedBy \(requestedBy\)/)
})

test('task insert carries requestedBy, null by default', () => {
  const { sql, params } = taskInsertSql({ guildConfigId: 'g1', title: 'T' }, 'pk')
  const cols = sql.match(/\((.+?)\) VALUES/)[1].split(',').map((s) => s.trim())
  const at = cols.indexOf('requestedBy')
  assert.ok(at > -1, 'requestedBy column present')
  assert.equal(params[at], null)
  const req = taskInsertSql({ guildConfigId: 'g1', title: 'T', requestedBy: 'u9' }, 'pk')
  assert.equal(req.params[at], 'u9')
})

test('guildmember insert defaults kind to staff and honours client', () => {
  const a = guildMemberInsertSql({ id: 'm1', guildConfigId: 'g1', discordId: 'u1' })
  const cols = a.sql.match(/\((.+?)\) VALUES/)[1].split(',').map((s) => s.trim())
  const at = cols.indexOf('kind')
  assert.ok(at > -1)
  assert.equal(a.params[at], 'staff')
  const b = guildMemberInsertSql({ id: 'm1', guildConfigId: 'g1', discordId: 'u1', kind: 'client' })
  assert.equal(b.params[at], 'client')
})

test('guildmember update sets kind only when given', () => {
  assert.deepEqual(guildMemberUpdateSets({ status: 'approved' }).sets, ['status = ?'])
  const { sets, vals } = guildMemberUpdateSets({ status: 'approved', kind: 'client' })
  assert.deepEqual(sets, ['status = ?', 'kind = ?'])
  assert.deepEqual(vals, ['approved', 'client'])
})

test('the client constants are the names the spec fixes', () => {
  assert.equal(ROLE_CLIENT, 'Client')
  assert.equal(CATEGORY_SUPPORT, '🛟 Support')
  assert.equal(CHANNEL_SUPPORT, 'support')
  assert.equal(CHANNEL_SUPPORT_VOICE, 'support-voice')
  assert.equal(typeof ROLE_COLORS[ROLE_CLIENT], 'number')
})
