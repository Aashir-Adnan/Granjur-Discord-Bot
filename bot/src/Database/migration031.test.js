// Migration 031 is plain SQL and there is no test database (the root .env is
// production), so this pins its guards instead of running it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sql = readFileSync(fileURLToPath(new URL('./migrations/031_project_soft_delete.sql', import.meta.url)), 'utf8')
const body = sql.replace(/--.*$/gm, '')

test('adds project.deletedAt only when missing', () => {
  assert.match(body, /COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'project' AND COLUMN_NAME = 'deletedAt'/)
  assert.match(body, /ALTER TABLE project ADD COLUMN deletedAt DATETIME\(3\) NULL/)
})

test('adds project.deletedBy only when missing', () => {
  assert.match(body, /COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'project' AND COLUMN_NAME = 'deletedBy'/)
  assert.match(body, /ALTER TABLE project ADD COLUMN deletedBy VARCHAR\(64\) NULL/)
})

test('adds the (guildConfigId, deletedAt) key only when missing', () => {
  assert.match(body, /STATISTICS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'project' AND INDEX_NAME = 'idx_project_guild_deleted'/)
  assert.match(body, /ADD KEY idx_project_guild_deleted \(guildConfigId, deletedAt\)/)
})

test('no destructive statements', () => {
  assert.ok(!/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i.test(body))
})

test('schema.sql mirrors the columns', () => {
  const schema = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8')
  const table = schema.match(/CREATE TABLE IF NOT EXISTS project \([\s\S]*?\n\);/)[0]
  assert.match(table, /deletedAt DATETIME\(3\) NULL/)
  assert.match(table, /deletedBy VARCHAR\(64\) NULL/)
  assert.match(table, /KEY idx_project_guild_deleted \(guildConfigId, deletedAt\)/)
})
