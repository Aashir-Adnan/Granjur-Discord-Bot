/**
 * Seed Task table with dummy data for dashboard/testing.
 * Run after db:init and after at least one GuildConfig exists (e.g. after /init in Discord).
 * Usage: node bot/scripts/seed-tasks.js
 */
import 'dotenv/config'
import mysql from 'mysql2/promise'
import { randomUUID } from 'crypto'

const url = process.env.DATABASE_URL
if (!url || !url.startsWith('mysql')) {
  console.error('DATABASE_URL must be set (mysql://...)')
  process.exit(1)
}

const parsed = new URL(url)
const pool = mysql.createPool({
  host: parsed.hostname,
  port: parsed.port || 3306,
  user: parsed.username,
  password: parsed.password,
  database: parsed.pathname?.replace(/^\//, '') || 'granjur',
})

function id() {
  return randomUUID().replace(/-/g, '').slice(0, 25)
}

const DUMMY_TASKS = [
  { type: 'feature', modules: ['api', 'frontend'], handlerId: null, scope: 'User auth flow', implementationStatus: 'done', passedApiTests: 1, passedQaTests: 1, passedAcceptanceCriteria: 1 },
  { type: 'feature', modules: ['api'], handlerId: null, scope: 'Export CSV endpoint', implementationStatus: 'in_progress', passedApiTests: 1, passedQaTests: null, passedAcceptanceCriteria: null },
  { type: 'feature', modules: ['frontend', 'ui'], handlerId: null, scope: 'Dark mode toggle', implementationStatus: 'not_started', passedApiTests: null, passedQaTests: null, passedAcceptanceCriteria: null },
  { type: 'bug', modules: ['api'], handlerId: null, scope: 'Fix 500 on empty payload', implementationStatus: 'done', passedApiTests: 1, passedQaTests: 1, passedAcceptanceCriteria: 1 },
  { type: 'bug', modules: ['frontend'], handlerId: null, scope: 'Mobile menu overflow', implementationStatus: 'in_progress', passedApiTests: null, passedQaTests: 0, passedAcceptanceCriteria: null },
  { type: 'feature', modules: ['database'], handlerId: null, scope: 'Migrations for v2', implementationStatus: 'not_started', passedApiTests: null, passedQaTests: null, passedAcceptanceCriteria: null },
  { type: 'bug', modules: ['api', 'database'], handlerId: null, scope: 'Race condition on concurrent updates', implementationStatus: 'done', passedApiTests: 1, passedQaTests: 1, passedAcceptanceCriteria: 1 },
  { type: 'feature', modules: [], handlerId: null, scope: 'General refactor', implementationStatus: 'in_progress', passedApiTests: null, passedQaTests: null, passedAcceptanceCriteria: null },
]

async function run() {
  const [rows] = await pool.query('SELECT id FROM GuildConfig LIMIT 1')
  if (!rows?.length) {
    console.log('No GuildConfig found. Run /init in Discord first, or create a guild config.')
    pool.end()
    return
  }
  const guildConfigId = rows[0].id
  for (const t of DUMMY_TASKS) {
    const pk = id()
    await pool.execute(
      `INSERT INTO Task (id, guildConfigId, type, featureId, bugTicketId, modules, handlerId, scope, implementationStatus, passedApiTests, passedQaTests, passedAcceptanceCriteria)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pk,
        guildConfigId,
        t.type,
        JSON.stringify(t.modules),
        t.handlerId,
        t.scope,
        t.implementationStatus,
        t.passedApiTests,
        t.passedQaTests,
        t.passedAcceptanceCriteria,
      ]
    )
  }
  console.log(`Seeded ${DUMMY_TASKS.length} dummy tasks for guildConfigId ${guildConfigId}.`)
  pool.end()
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
