import 'dotenv/config'
import mysql from 'mysql2/promise'

let pool = null

export function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL
    if (!url || !url.startsWith('mysql')) {
      throw new Error('DATABASE_URL must be set and use mysql:// protocol')
    }
    const parsed = new URL(url)
    pool = mysql.createPool({
      host: parsed.hostname,
      port: parsed.port || 3306,
      user: parsed.username,
      password: parsed.password,
      database: parsed.pathname?.replace(/^\//, '') || 'granjur',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    })
  }
  return pool
}

export async function query(sql, params = []) {
  const p = getPool()
  const [rows] = await p.execute(sql, params)
  return rows
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params)
  return rows[0] ?? null
}
