import fetch from 'node-fetch'
import db, { getGuildConfig, getOrCreateGuildConfig } from '../db/index.js'
import {
  isDocFile,
  toDocId,
  sectionOf,
  extractTitle,
  attributeProject,
  slugify,
  encodePathSegments,
} from '../utils/docPath.js'

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

/**
 * Every blob in the branch, recursively. One API call.
 *
 * A truncated response is a hard failure, not a warning: the caller treats the
 * returned list as the complete set of repository documents and deletes every
 * mirrored page missing from it, so a partial list would wipe the mirror and
 * then record the head sha, freezing that state until the next upstream push.
 */
export async function fetchTree({ owner, repo, branch }, { fetchImpl = fetch } = {}) {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, fetchImpl)
  if (!res.ok) throw new Error(`GitHub tree ${res.status}: ${await res.text()}`)
  const json = await res.json()
  if (json.truncated) throw new Error('GitHub tree response was truncated — refusing to sync a partial tree')
  return json.tree || []
}

/** File content from raw.githubusercontent — not subject to the API rate limit. Never authenticated. */
export async function fetchRaw(path, { owner, repo, branch }) {
  // A file added upstream with a space, a '#' or a '?' in its name 404s
  // forever against an unencoded raw URL.
  const encoded = encodePathSegments(path)
  const res = await fetch(`${RAW}/${owner}/${repo}/${branch}/${encoded}`)
  if (!res.ok) throw new Error(`raw ${res.status} for ${path}`)
  return res.text()
}

/**
 * Recompute which project owns each mirrored page and write back only the rows
 * whose attribution actually changed.
 *
 * This runs on every cycle, including the one that short-circuits on an
 * unchanged head sha, because a project created after the corpus was synced
 * changes attribution without changing a single blob. Only `source='repo'` rows
 * are recomputed: a `source='local'` page carries the projectId /edit-docs gave
 * it and must not be re-derived from its path.
 */
async function reattribute({ guildConfigId, rows, projects, database }) {
  let changed = 0
  for (const row of rows || []) {
    if (row.source !== 'repo') continue
    const next = attributeProject(row.path, projects) ?? null
    if ((row.projectId ?? null) === next) continue
    await database.docPage.setProjectId({ guildConfigId, id: row.id, projectId: next })
    changed++
  }
  return changed
}

/**
 * One sync pass for one guild. All I/O is injected so this is testable offline.
 * Never throws: a failure is recorded on docsource and reported in the result.
 * `force` ignores the head-sha short-circuit (the /setup button uses it; the
 * background loop does not).
 */
export async function syncOnce({ guildConfigId, source, projects, deps, force = false }) {
  const { fetchHeadSha: head, fetchTree: tree, fetchRaw: raw, db: database } = deps
  let reattributed = 0
  try {
    const commitSha = await head(source)

    // Attribution is independent of the blob diff, so it happens before any
    // short-circuit — otherwise a newly created project never picks up the
    // pages that were already mirrored.
    const existing = await database.docPage.listIndexFull({ guildConfigId })
    reattributed = await reattribute({ guildConfigId, rows: existing, projects, database })

    if (!force && commitSha && commitSha === source.lastCommitSha) {
      return { skipped: true, failed: false, upserted: 0, deleted: 0, reattributed, failedFiles: 0, commitSha }
    }

    const entries = await tree(source)
    const docs = entries.filter((e) => e.type === 'blob' && isDocFile(e.path))
    // An empty document list is never a legitimate state for this repository —
    // it means the tree came back wrong, and acting on it would delete every
    // mirrored page. Fail the cycle and leave the mirror alone.
    if (docs.length === 0) {
      throw new Error('tree contained no documentation files — refusing to delete the mirror')
    }

    const shaByPath = new Map(existing.filter((r) => r.source === 'repo').map((r) => [r.path, r.blobSha]))
    // Discord-authored pages live nowhere else. If the repository grows a file
    // at the same path, the local page wins and the repository copy is skipped.
    const localPaths = new Set(existing.filter((r) => r.source === 'local').map((r) => r.path))

    let upserted = 0
    let failedFiles = 0
    const conflicts = []
    for (const entry of docs) {
      if (localPaths.has(entry.path)) {
        conflicts.push(entry.path)
        continue
      }
      if (shaByPath.get(entry.path) === entry.sha) continue
      try {
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
      } catch (err) {
        // One unreadable file must not abandon the rest of the corpus.
        failedFiles++
        console.error(`[docsSync] ${entry.path}: ${err.message}`)
      }
    }

    if (conflicts.length) {
      console.warn(
        `[docsSync] ${conflicts.length} repository path(s) held by a Discord-authored page and left untouched: ${conflicts.join(', ')}`
      )
    }

    // The tree was complete but the mirror is not: deleting now would drop
    // pages that simply failed to download, and recording the head sha would
    // stop the next cycle from retrying them.
    if (failedFiles > 0) {
      const message = `${failedFiles} file(s) failed to download — head sha not recorded, delete pass skipped`
      await database.docSource.recordError({ guildConfigId, message }).catch(() => {})
      return {
        skipped: false,
        failed: false,
        upserted,
        deleted: 0,
        reattributed,
        failedFiles,
        conflicts: conflicts.length,
        error: message,
      }
    }

    const deleted = await database.docPage.deleteRepoPathsNotIn({
      guildConfigId,
      paths: docs.map((d) => d.path),
    })

    await database.docSource.recordSync({ guildConfigId, commitSha })
    return {
      skipped: false,
      failed: false,
      upserted,
      deleted,
      reattributed,
      failedFiles: 0,
      conflicts: conflicts.length,
      commitSha,
    }
  } catch (err) {
    await database.docSource.recordError({ guildConfigId, message: err.message }).catch(() => {})
    return { skipped: false, failed: true, upserted: 0, deleted: 0, reattributed, failedFiles: 0, error: err.message }
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

/**
 * Re-run doc→project attribution for one guild with no GitHub traffic at all.
 * Called right after a project is created so the manager's next /docs is
 * correct without waiting for — or forcing — a sync.
 */
export async function reattributeGuildDocs(guildConfigId) {
  const rows = await db.docPage.listIndexFull({ guildConfigId })
  const projects = await projectsFor(guildConfigId)
  return reattribute({ guildConfigId, rows, projects, database: db })
}

/**
 * Sync one guild on demand. Creating the docsource row is an explicit act, so
 * this is the /setup button's path only; it forces a full pass by default.
 */
export async function syncGuildNow(guildId, { force = true } = {}) {
  const cfg = await getOrCreateGuildConfig(guildId)
  if (!cfg) return { failed: true, error: 'guild not initialized' }
  const source = await ensureSource(cfg.id)
  const projects = await projectsFor(cfg.id)
  return syncOnce({
    guildConfigId: cfg.id,
    source,
    projects,
    force,
    deps: { db, fetchHeadSha, fetchTree, fetchRaw },
  })
}

/**
 * The background loop's entry point. Only a guild that already has a docsource
 * row is synced, and nothing is created as a side effect — otherwise adding the
 * bot to a second server would silently mirror the whole corpus again and add a
 * pair of GitHub calls per cycle per guild.
 */
export async function syncGuildIfConfigured(guildId) {
  const cfg = await getGuildConfig(guildId)
  if (!cfg) return { skipped: true, failed: false, reason: 'no guild config' }
  const source = await db.docSource.get({ guildConfigId: cfg.id })
  if (!source) return { skipped: true, failed: false, reason: 'documentation sync not set up' }
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
        const res = await syncGuildIfConfigured(guildId)
        if (res.failed) console.error('[docsSync]', guildId, res.error)
        else if (!res.skipped) {
          console.log(
            `[docsSync] ${guildId}: +${res.upserted} -${res.deleted} ~${res.reattributed}${res.failedFiles ? ` !${res.failedFiles}` : ''}`
          )
        }
      } catch (err) {
        console.error('[docsSync] loop error:', err)
      }
    }
  }
  runAll()
  setInterval(runAll, INTERVAL_MS)
}
