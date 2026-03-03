/**
 * Run pending SQL migrations in order. Requires DATABASE_URL in .env (mysql://...)
 * Usage: node bot/scripts/run-migrations.js
 * Or: npm run db:migrate
 *
 * Migrations are .sql files in bot/src/Database/migrations/, run in filename order.
 * Applied migrations are recorded in schema_migrations so each runs only once.
 */
import 'dotenv/config'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import mysql from 'mysql2/promise'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '../src/Database/migrations')

const url = process.env.DATABASE_URL
if (!url || !url.startsWith('mysql')) {
  console.error('DATABASE_URL must be set and use mysql:// protocol')
  process.exit(1)
}

const parsed = new URL(url)
const pool = mysql.createPool({
  host: parsed.hostname,
  port: parsed.port || 3306,
  user: parsed.username,
  password: parsed.password,
  database: parsed.pathname?.replace(/^\//, '') || 'granjur',
  multipleStatements: true,
})

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name VARCHAR(255) PRIMARY KEY,
  run_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
)
`.trim()

async function ensureMigrationsTable(conn) {
  await conn.query(MIGRATIONS_TABLE)
}

async function getAppliedMigrations(conn) {
  const [rows] = await conn.query('SELECT name FROM schema_migrations')
  return new Set(rows.map((r) => r.name))
}

async function recordMigration(conn, name) {
  await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [name])
}

function getMigrationFiles() {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  return files
}

async function run() {
  const conn = await pool.getConnection()
  try {
    await ensureMigrationsTable(conn)
    const applied = await getAppliedMigrations(conn)
    const files = getMigrationFiles()

    if (files.length === 0) {
      console.log('No migration files found in', migrationsDir)
      return
    }

    let runCount = 0
    for (const file of files) {
      const name = file
      if (applied.has(name)) {
        console.log('Skip (already applied):', name)
        continue
      }

      const path = join(migrationsDir, file)
      let sql = readFileSync(path, 'utf8')
      if (!sql.trim()) {
        console.log('Skip (empty):', name)
        await recordMigration(conn, name)
        runCount++
        continue
      }

      // 004_unified_task: only run on DBs that still have Feature table (pre-unified schema)
      if (name === '004_unified_task_bugs_features.sql') {
        const [rows] = await conn.query(
          "SELECT 1 AS ok FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Feature' LIMIT 1"
        )
        if (!rows || rows.length === 0) {
          console.log('Skip (schema already unified):', name)
          await recordMigration(conn, name)
          runCount++
          continue
        }
      }

      try {
        await conn.query(sql)
        await recordMigration(conn, name)
        console.log('Applied:', name)
        runCount++
      } catch (err) {
        console.error('Migration failed:', name, err.message)
        throw err
      }
    }

    if (runCount === 0 && applied.size > 0) {
      console.log('All migrations already applied.')
    } else {
      console.log('Migrations complete. Applied', runCount, 'migration(s).')
    }
  } finally {
    conn.release()
    await pool.end()
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
