/**
 * Run arbitrary SQL queries against the database.
 * Usage:
 *   node bot/scripts/db-query.js "SELECT * FROM guildmember"
 *   node bot/scripts/db-query.js "SELECT * FROM guildconfig" --json
 */
import 'dotenv/config'
import mysql from 'mysql2/promise'

const sql = process.argv[2]
if (!sql) {
  console.error('Usage: node bot/scripts/db-query.js "SQL QUERY" [--json]')
  process.exit(1)
}

const json = process.argv.includes('--json')
const url = process.env.DATABASE_URL
if (!url || !url.startsWith('mysql')) {
  console.error('DATABASE_URL must be set and use mysql:// protocol')
  process.exit(1)
}

const parsed = new URL(url)
const conn = await mysql.createConnection({
  host: parsed.hostname,
  port: parsed.port || 3306,
  user: parsed.username,
  password: parsed.password,
  database: parsed.pathname?.replace(/^\//, '') || 'granjur',
  multipleStatements: true,
})

try {
  const [rows, fields] = await conn.query(sql)

  if (!Array.isArray(rows) || (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0]))) {
    // Multi-statement or non-SELECT result
    const results = Array.isArray(rows[0]) ? rows : [rows]
    for (const r of results) {
      if (!Array.isArray(r)) console.log('OK —', r.affectedRows ?? 0, 'row(s) affected')
    }
  } else if (rows.length === 0) {
    console.log('No rows returned.')
  } else if (json) {
    console.log(JSON.stringify(rows, null, 2))
  } else {
    const cols = fields.map(f => f.name)
    const widths = cols.map(c => c.length)
    const stringRows = rows.map(r => cols.map((c, i) => {
      const val = r[c] == null ? 'NULL' : String(r[c]).slice(0, 60)
      widths[i] = Math.max(widths[i], val.length)
      return val
    }))
    const sep = widths.map(w => '-'.repeat(w)).join('-+-')
    console.log(cols.map((c, i) => c.padEnd(widths[i])).join(' | '))
    console.log(sep)
    stringRows.forEach(r => console.log(r.map((v, i) => v.padEnd(widths[i])).join(' | ')))
    console.log(`\n${rows.length} row(s)`)
  }
} catch (e) {
  console.error('Query failed:', e.message)
  process.exit(1)
} finally {
  await conn.end()
}
