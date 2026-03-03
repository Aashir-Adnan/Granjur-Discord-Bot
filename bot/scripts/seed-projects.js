/**
 * Seed projects table with Fittour, Edarete, Framework (from ubs_doc).
 * Run after db:init. Usage: node bot/scripts/seed-projects.js
 */
import 'dotenv/config'
import mysql from 'mysql2/promise'

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

const projects = [
  { name: 'Fittour', owner_email: 'aashir@granjur.com', frontend_repo_link: 'https://github.com/GranjurTech/FitTour_RN.git', backend_repo_link: 'https://github.com/GranjurTech/FitTour_Admin.git' },
  { name: 'Edarete', owner_email: 'aashir@granjur.com', frontend_repo_link: null, backend_repo_link: null },
  { name: 'Framework', owner_email: null, frontend_repo_link: null, backend_repo_link: null },
]

async function run() {
  for (const p of projects) {
    await pool.execute(
      'INSERT IGNORE INTO projects (name, owner_email, frontend_repo_link, backend_repo_link) VALUES (?, ?, ?, ?)',
      [p.name, p.owner_email || null, p.frontend_repo_link || null, p.backend_repo_link || null]
    )
  }
  console.log('Seed projects: Fittour, Edarete, Framework (inserted if not exists).')
  pool.end()
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
