/**
 * Seed Project, project_schemas, dump_versions, project_repos, and Repository with real repo URLs.
 * Run after schema/init-db. Requires DATABASE_URL. Optional: SEED_GUILD_ID (default 000000000000000001)
 * Usage: node bot/scripts/seed-data.js
 */
import 'dotenv/config'
import mysql from 'mysql2/promise'
import { randomUUID } from 'crypto'

const url = process.env.DATABASE_URL
if (!url || !url.startsWith('mysql')) {
  console.error('DATABASE_URL must be set (mysql://...)')
  process.exit(1)
}

const SEED_GUILD_ID = process.env.SEED_GUILD_ID || '000000000000000001'

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

const REPOS = [
  { name: 'Framework_Node', url: 'https://github.com/UBS-Dev-Org/Framework_Node' },
  { name: 'Edarete_Node', url: 'https://github.com/ITULahore/Edarete_Node' },
  { name: 'Edarete_React', url: 'https://github.com/ITULahore/Edarete_React' },
  { name: 'FrameworkScript', url: 'https://github.com/UBS-Dev-Org/FrameworkScript' },
  { name: 'Badar_HMS_Node', url: 'https://github.com/GranjurTech/Badar_HMS_Node' },
  { name: 'Framework_React', url: 'https://github.com/UBS-Dev-Org/Framework_React' },
  { name: 'Ilmversity_aicredits_node_v2', url: 'https://github.com/ilmversity/Ilmversity_aicredits_node_v2' },
  { name: 'CSAAS_Backend', url: 'https://github.com/Aashir-Adnan/CSAAS_Backend' },
  { name: 'UBS-Doc', url: 'https://github.com/Aashir-Adnan/UBS-Doc' },
  { name: 'ScholarSpace-UBS-Framework', url: 'https://github.com/Aashir-Adnan/ScholarSpace-UBS-Framework' },
]

const PROJECTS = [
  { name: 'Fittour', readme: '# Fittour\nDummy readme for testing.', owner_emails: ['aashir@granjur.com', 'dev@granjur.com'] },
  { name: 'Edarete', readme: '# Edarete\nProject documentation.', owner_emails: ['aashir@granjur.com'] },
  { name: 'Framework', readme: '# UBS Framework\nShared framework.', owner_emails: ['team@granjur.com'] },
  { name: 'UBS-Doc', readme: '# UBS Doc\nDocumentation site (Docusaurus).', owner_emails: ['aashir@granjur.com'] },
  { name: 'ScholarSpace', readme: '# ScholarSpace\nAPI middleware architecture.', owner_emails: ['aashir@granjur.com'] },
  { name: 'Badar HMS', readme: '# Badar HMS\nHospital management system.', owner_emails: ['admin@granjur.com'] },
  { name: 'CSAAS', readme: '# CSAAS Backend\nDummy project.', owner_emails: ['dev@granjur.com'] },
  { name: 'Ilmversity', readme: '# Ilmversity\nAI credits backend.', owner_emails: ['support@granjur.com'] },
]

const DUMMY_SQL = `-- Dummy schema v1
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);
CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);
`

async function run() {
  const conn = await pool.getConnection()

  try {
    let [gcRow] = await conn.execute('SELECT id FROM GuildConfig WHERE guildId = ? LIMIT 1', [SEED_GUILD_ID])
    let cfgId = gcRow?.[0]?.id
    if (!cfgId) {
      cfgId = id()
      await conn.execute(
        'INSERT INTO GuildConfig (id, guildId, allowedDomains, dashboardRoleIds, seniorRoleIds) VALUES (?, ?, \'["granjur.com"]\', \'[]\', \'[]\')',
        [cfgId, SEED_GUILD_ID]
      )
    }
    console.log('GuildConfig for seed guild', SEED_GUILD_ID, 'id', cfgId)

    const repoIds = []
    for (const r of REPOS) {
      const rid = id()
      await conn.execute(
        'INSERT IGNORE INTO Repository (id, guildConfigId, name, url) VALUES (?, ?, ?, ?)',
        [rid, cfgId, r.name, r.url]
      )
      const [rows] = await conn.execute('SELECT id FROM Repository WHERE guildConfigId = ? AND url = ? LIMIT 1', [cfgId, r.url])
      repoIds.push({ id: rows[0]?.id || rid, name: r.name })
    }
    console.log('Repos:', repoIds.length)

    const projectIds = []
    for (const p of PROJECTS) {
      const pid = id()
      await conn.execute(
        'INSERT IGNORE INTO Project (id, guildConfigId, name, readme, owner_emails) VALUES (?, ?, ?, ?, ?)',
        [pid, cfgId, p.name, p.readme, JSON.stringify(p.owner_emails || [])]
      )
      const [pRows] = await conn.execute('SELECT id FROM Project WHERE guildConfigId = ? AND name = ? LIMIT 1', [cfgId, p.name])
      projectIds.push({ id: pRows[0]?.id || pid, name: p.name })
    }
    console.log('Projects:', projectIds.length)

    const schemaIds = []
    for (const proj of projectIds) {
      const sid = id()
      await conn.execute(
        'INSERT IGNORE INTO project_schemas (id, project_id, name) VALUES (?, ?, ?)',
        [sid, proj.id, 'main']
      )
      const [sRows] = await conn.execute('SELECT id FROM project_schemas WHERE project_id = ? AND name = ? LIMIT 1', [proj.id, 'main'])
      schemaIds.push({ id: sRows[0]?.id || sid, project_id: proj.id, project_name: proj.name })
    }

    for (const sch of schemaIds) {
      const did = id()
      await conn.execute(
        'INSERT INTO dump_versions (id, project_schema_id, content, created_by) VALUES (?, ?, ?, ?)',
        [did, sch.id, DUMMY_SQL, 'seed@granjur.com']
      )
      await conn.execute('UPDATE project_schemas SET latest_dump_id = ? WHERE id = ?', [did, sch.id])
    }
    console.log('project_schemas + dump_versions seeded')

    const nameToRepoId = new Map(repoIds.map((r) => [r.name, r.id]))
    const nameToProjectId = new Map(projectIds.map((p) => [p.name, p.id]))
    const projectRepoPairs = [
      ['Framework', 'Framework_Node'],
      ['Framework', 'Framework_React'],
      ['Framework', 'FrameworkScript'],
      ['Edarete', 'Edarete_Node'],
      ['Edarete', 'Edarete_React'],
      ['UBS-Doc', 'UBS-Doc'],
      ['ScholarSpace', 'ScholarSpace-UBS-Framework'],
      ['Badar HMS', 'Badar_HMS_Node'],
      ['CSAAS', 'CSAAS_Backend'],
      ['Ilmversity', 'Ilmversity_aicredits_node_v2'],
      ['Fittour', 'Framework_Node'],
    ]
    for (const [pName, rName] of projectRepoPairs) {
      const pid = nameToProjectId.get(pName)
      const rid = nameToRepoId.get(rName)
      if (pid && rid) {
        await conn.execute('INSERT IGNORE INTO project_repos (project_id, repository_id) VALUES (?, ?)', [pid, rid])
      }
    }
    console.log('project_repos bridge seeded')

    console.log('Seed complete: repos (real URLs), projects, project_schemas, dump_versions, project_repos.')
  } finally {
    conn.release()
    await pool.end()
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
