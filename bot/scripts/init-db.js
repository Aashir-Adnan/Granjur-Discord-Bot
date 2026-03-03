/**
 * Run once to create MySQL tables. Requires DATABASE_URL in .env (mysql://...)
 * Usage: node bot/scripts/init-db.js
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import mysql from 'mysql2/promise'

const __dirname = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(__dirname, '../src/Database/schema.sql')

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

const sql = readFileSync(schemaPath, 'utf8')
await pool.query(sql)
console.log('Database tables created successfully.')
pool.end()
