// Migration 030 is plain SQL and there is no test database (the root .env is
// production), so this pins its guards instead of running it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sql = readFileSync(fileURLToPath(new URL('./migrations/030_project_repo_scope.sql', import.meta.url)), 'utf8')
const body = sql.replace(/--.*$/gm, '')

test('adds project_repos.scope only when missing', () => {
  assert.match(body, /COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'project_repos' AND COLUMN_NAME = 'scope'/)
  assert.match(body, /ALTER TABLE project_repos ADD COLUMN scope VARCHAR\(16\) DEFAULT NULL/)
})

test('adds the one-repository-per-scope key only when missing', () => {
  assert.match(body, /STATISTICS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'project_repos' AND INDEX_NAME = 'uq_project_repos_scope'/)
  assert.match(body, /ADD UNIQUE KEY uq_project_repos_scope \(project_id, scope\)/)
})

test('no destructive statements', () => {
  assert.ok(!/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i.test(body))
})
