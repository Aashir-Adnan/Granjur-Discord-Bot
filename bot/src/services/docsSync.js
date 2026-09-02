import fetch from 'node-fetch'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { isDocFile, toDocId, sectionOf, extractTitle, attributeProject, slugify } from '../utils/docPath.js'

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
const INTERVAL_MS = Number(process.env.DOCS_SYNC_INTERVAL_MS || 15 * 60 * 1000)

export const DEFAULT_SOURCE = {
  owner: process.env.DOCS_REPO_OWNER || 'Aashir-Adnan',
  repo: process.env.DOCS_REPO_NAME || 'UBS-Doc',
  branch: process.env.DOCS_REPO_BRANCH || 'main',
  siteUrl: process.env.DOCS_SITE_URL || 'https://ubs-doc.vercel.app',
}

let tokenRejected = false
let tokenWarned = false

/** Test-only: reset the module-level token fallback state between cases. */
export function __resetGhTokenState() {
  tokenRejected = false
  tokenWarned = false
}

function ghHeaders() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'granjur-bot' }
  const token = process.env.GITHUB_TOKEN || ''
  if (token && !tokenRejected) headers.Authorization = `Bearer ${token}`
  return headers
}

/**
 * Fetch a GitHub API URL, falling back to unauthenticated once if the token is
 * rejected outright. `fetchImpl` is injectable for tests; production callers get
 * the real `fetch`. Only a 401 means the token itself is bad — any 403 (rate
 * limit, primary or secondary/abuse-detection) is left to fail normally so
 * `syncOnce` records it and the next cycle retries; a 403 never drops
 * authentication.
 */
async function ghFetch(url, fetchImpl = fetch) {
  const usedAuth = Boolean(process.env.GITHUB_TOKEN) && !tokenRejected
  let res = await fetchImpl(url, { headers: ghHeaders() })
  if (usedAuth && res.status === 401) {
    tokenRejected = true
    if (!tokenWarned) {
      tokenWarned = true
      console.warn('[docsSync] GITHUB_TOKEN rejected by GitHub (401) — continuing unauthenticated')
    }
    res = await fetchImpl(url, { headers: ghHeaders() })
  }
  return res
}

/** Head commit sha of the branch. One API call. */
export async function fetchHeadSha({ owner, repo, branch }, { fetchImpl = fetch } = {}) {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/commits/${branch}`, fetchImpl)
  if (!res.ok) throw new Error(`GitHub commits ${res.status}: ${await res.text()}`)
  const json = await res.json()
  return json.sha
}

/** Every blob in the branch, recursively. One API call. */
export async function fetchTree({ owner, repo, branch }, { fetchImpl = fetch } = {}) {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, fetchImpl)
  if (!res.ok) throw new Error(`GitHub tree ${res.status}: ${await res.text()}`)
  const json = await res.json()
  if (json.truncated) console.warn('[docsSync] tree response was truncated')
  return json.tree || []
}

/** File content from raw.githubusercontent — not subject to the API rate limit. Never authenticated. */
export async function fetchRaw(path, { owner, repo, branch }) {
  const res = await fetch(`${RAW}/${owner}/${repo}/${branch}/${path}`)
  if (!res.ok) throw new Error(`raw ${res.status} for ${path}`)
  return res.text()
}

/**
 * One sync pass for one guild. All I/O is injected so this is testable offline.
 * Never throws: a failure is recorded on docsource and reported in the result.
 */
export async function syncOnce({ guildConfigId, source, projects, deps }) {
  const { fetchHeadSha: head, fetchTree: tree, fetchRaw: raw, db: database } = deps
  try {
    const commitSha = await head(source)
    if (commitSha && commitSha === source.lastCommitSha) {
      return { skipped: true, failed: false, upserted: 0, deleted: 0, commitSha }
    }

    const entries = await tree(source)
    const docs = entries.filter((e) => e.type === 'blob' && isDocFile(e.path))

    const existing = await database.docPage.listIndexFull({ guildConfigId })
    const shaByPath = new Map(existing.filter((r) => r.source === 'repo').map((r) => [r.path, r.blobSha]))

    let upserted = 0
    for (const entry of docs) {
      if (shaByPath.get(entry.path) === entry.sha) continue
      const content = await raw(entry.path, source)
      await database.docPage.upsert({
        data: {
          guildConfigId,
          path: entry.path,
          docId: toDocId(entry.path),
          section: sectionOf(entry.path),
          projectId: attributeProject(entry.path, projects),
          title: extractTitle(content, entry.path),
          content,
          source: 'repo',
          blobSha: entry.sha,
          size: entry.size || content.length,
        },
      })
      upserted++
    }

    const deleted = await database.docPage.deleteRepoPathsNotIn({
      guildConfigId,
      paths: docs.map((d) => d.path),
    })

    await database.docSource.recordSync({ guildConfigId, commitSha })
    return { skipped: false, failed: false, upserted, deleted, commitSha }
  } catch (err) {
    await database.docSource.recordError({ guildConfigId, message: err.message }).catch(() => {})
    return { skipped: false, failed: true, upserted: 0, deleted: 0, error: err.message }
  }
}

/** Resolve (and lazily create) the docsource row for a guild. */
async function ensureSource(guildConfigId) {
  const existing = await db.docSource.get({ guildConfigId })
  if (existing) return existing
  return db.docSource.upsert({ guildConfigId, data: DEFAULT_SOURCE })
}

async function projectsFor(guildConfigId) {
  const rows = await db.project.findMany({ where: { guildConfigId } })
  return rows.map((p) => ({
    id: p.id,
    docsSlug: p.docsSlug || slugify(p.name),
    docsPaths: Array.isArray(p.docsPaths) ? p.docsPaths : JSON.parse(p.docsPaths || '[]'),
  }))
}

/** Sync one guild now. Used by the /setup button and by the interval loop. */
export async function syncGuildNow(guildId) {
  const cfg = await getOrCreateGuildConfig(guildId)
  if (!cfg) return { failed: true, error: 'guild not initialized' }
  const source = await ensureSource(cfg.id)
  const projects = await projectsFor(cfg.id)
  return syncOnce({
    guildConfigId: cfg.id,
    source,
    projects,
    deps: { db, fetchHeadSha, fetchTree, fetchRaw },
  })
}

/** Start the background sync loop. Runs once on start, then every INTERVAL_MS. */
export function startDocsSync(client) {
  if (!client?.guilds) return
  const runAll = async () => {
    for (const [guildId] of client.guilds.cache) {
      try {
        const res = await syncGuildNow(guildId)
        if (res.failed) console.error('[docsSync]', guildId, res.error)
        else if (!res.skipped) console.log(`[docsSync] ${guildId}: +${res.upserted} -${res.deleted}`)
      } catch (err) {
        console.error('[docsSync] loop error:', err)
      }
    }
  }
  runAll()
  setInterval(runAll, INTERVAL_MS)
}
