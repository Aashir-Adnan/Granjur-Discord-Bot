import fetch from 'node-fetch'
import { config } from '../config.js'

/**
 * Parse `GITHUB_TOKENS="owner:token,owner2:token2"` into a lowercase-keyed
 * owner → token map. Blanks and malformed pairs (no `:`, or an empty owner)
 * are ignored. The token is everything after the first `:`, so a token that
 * itself contains a colon survives intact.
 * @param {string} raw
 * @returns {Map<string, string>}
 */
export function parseTokens(raw) {
  const map = new Map()
  for (const pair of (raw || '').split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const i = trimmed.indexOf(':')
    if (i <= 0) continue
    const owner = trimmed.slice(0, i).trim().toLowerCase()
    const token = trimmed.slice(i + 1).trim()
    if (!owner || !token) continue
    map.set(owner, token)
  }
  return map
}

/**
 * The token for a repo owner: the per-owner map, else the fallback, else ''.
 * @param {string} owner
 * @param {{tokens?: Map<string,string>, fallback?: string}} [opts]
 * @returns {string}
 */
export function tokenFor(owner, { tokens, fallback } = {}) {
  return tokens?.get(String(owner || '').toLowerCase()) || fallback || ''
}

// Computed once at module load; every call can override via opts.
const DEFAULT_TOKENS = parseTokens(config.github?.tokens || '')
const DEFAULT_FALLBACK = config.github?.token || process.env.GITHUB_TOKEN || ''

export class GitHubError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GitHubError'
    this.code = code
  }
}

function parseRepoUrl(url) {
  const match = (url || '').match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  return match ? { owner: match[1], repo: match[2].replace(/\.git$/, '') } : null
}

function ownerRepoOrThrow(repoUrl) {
  const p = parseRepoUrl(repoUrl)
  if (!p) throw new GitHubError('bad-url', 'Not a GitHub repository URL')
  return p
}

const isAccessStatus = (status) => status === 401 || status === 403 || status === 404

async function gh(path, { token, fetchImpl = fetch, ...options } = {}) {
  const base = 'https://api.github.com'
  const res = await fetchImpl(`${base}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: token ? `Bearer ${token}` : '',
      ...options.headers,
    },
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = {}
  }
  if (!res.ok) {
    const err = new Error(data.message || text || res.statusText)
    err.status = res.status
    throw err
  }
  return data
}

/**
 * @param {{fetchImpl?: typeof fetch, tokens?: Map<string,string>, fallback?: string}} [opts]
 *   test-only seams; production callers never pass them, so behaviour is
 *   unchanged (real `fetch`, the configured tokens).
 */
export async function createIssue(repoUrl, title, body, { fetchImpl, tokens = DEFAULT_TOKENS, fallback = DEFAULT_FALLBACK } = {}) {
  const p = ownerRepoOrThrow(repoUrl)
  const token = tokenFor(p.owner, { tokens, fallback })
  if (!token) throw new GitHubError('no-access', `No GitHub access to ${p.owner}/${p.repo}`)
  try {
    // Bounded so a hung GitHub call can't hold `createTask` open long enough to
    // make CSAAS's own wait time out and the site report a false "offline".
    const res = await gh(`/repos/${p.owner}/${p.repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title, body }),
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      fetchImpl,
      token,
    })
    return { url: res.html_url, number: res.number }
  } catch (e) {
    if (isAccessStatus(e.status)) throw new GitHubError('no-access', `No GitHub access to ${p.owner}/${p.repo}`)
    throw new GitHubError('github', e.message)
  }
}

/**
 * Close, reopen, or otherwise set an issue's state.
 * @param {string} repoUrl
 * @param {number} number
 * @param {{state: 'open'|'closed', reason?: 'completed'|'not_planned'}} change
 * @param {{fetchImpl?: typeof fetch, tokens?: Map<string,string>, fallback?: string}} [opts]
 */
export async function setIssueState(repoUrl, number, { state, reason } = {}, { fetchImpl, tokens = DEFAULT_TOKENS, fallback = DEFAULT_FALLBACK } = {}) {
  const p = ownerRepoOrThrow(repoUrl)
  const token = tokenFor(p.owner, { tokens, fallback })
  if (!token) throw new GitHubError('no-access', `No GitHub access to ${p.owner}/${p.repo}`)
  const body = { state }
  if (reason) body.state_reason = reason
  try {
    await gh(`/repos/${p.owner}/${p.repo}/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      fetchImpl,
      token,
    })
  } catch (e) {
    if (isAccessStatus(e.status)) throw new GitHubError('no-access', `No GitHub access to ${p.owner}/${p.repo}`)
    throw new GitHubError('github', e.message)
  }
}

/**
 * Whether the configured token(s) can open issues on a repo. Never throws.
 * Reading the repo is not enough: issues switched off, or a token that can
 * read but neither push nor triage, still means no issue will open.
 * @param {string} repoUrl
 * @param {{fetchImpl?: typeof fetch, tokens?: Map<string,string>, fallback?: string}} [opts]
 * @returns {Promise<{ok: true} | {ok: false, code: 'no-access'|'bad-url'|'error', message: string, issuesDisabled?: true}>}
 */
export async function checkRepoAccess(repoUrl, { fetchImpl, tokens = DEFAULT_TOKENS, fallback = DEFAULT_FALLBACK } = {}) {
  const p = parseRepoUrl(repoUrl)
  if (!p) return { ok: false, code: 'bad-url', message: 'Not a GitHub repository URL' }
  const token = tokenFor(p.owner, { tokens, fallback })
  if (!token) return { ok: false, code: 'no-access', message: `No GitHub access to ${p.owner}/${p.repo}` }
  try {
    const repo = await gh(`/repos/${p.owner}/${p.repo}`, { fetchImpl, token, signal: AbortSignal.timeout(8000) })
    if (repo?.has_issues === false) {
      return { ok: false, code: 'no-access', message: `Issues are disabled on ${p.owner}/${p.repo}`, issuesDisabled: true }
    }
    const perms = repo?.permissions
    if (perms && typeof perms === 'object' && perms.push === false && perms.triage !== true) {
      return { ok: false, code: 'no-access', message: `No GitHub access to ${p.owner}/${p.repo}` }
    }
    return { ok: true }
  } catch (e) {
    if (isAccessStatus(e.status)) return { ok: false, code: 'no-access', message: `No GitHub access to ${p.owner}/${p.repo}` }
    return { ok: false, code: 'error', message: e.message }
  }
}

export async function getRepoContents(repoUrl, path = '') {
  const p = parseRepoUrl(repoUrl)
  const token = p ? tokenFor(p.owner, { tokens: DEFAULT_TOKENS, fallback: DEFAULT_FALLBACK }) : ''
  if (!p || !token) return []
  const urlPath = path ? `/repos/${p.owner}/${p.repo}/contents/${path}` : `/repos/${p.owner}/${p.repo}/contents/`
  const res = await gh(urlPath, { token })
  const list = Array.isArray(res) ? res : []
  return list.map((e) => ({ name: e.name, path: e.path, type: e.type === 'dir' ? 'dir' : 'file', sha: e.sha }))
}

/** Fetch raw file content from repo (e.g. README.md). Returns decoded string or null. */
export async function getRepoFileContent(repoUrl, filePath = 'README.md') {
  const p = parseRepoUrl(repoUrl)
  if (!p) return null
  try {
    const token = tokenFor(p.owner, { tokens: DEFAULT_TOKENS, fallback: DEFAULT_FALLBACK })
    const res = await gh(`/repos/${p.owner}/${p.repo}/contents/${encodeURIComponent(filePath)}`, { token })
    if (res.content && res.encoding === 'base64') {
      return Buffer.from(res.content, 'base64').toString('utf8')
    }
    return null
  } catch {
    return null
  }
}

export async function getCommits(repoUrl, author = null) {
  const p = parseRepoUrl(repoUrl)
  const token = p ? tokenFor(p.owner, { tokens: DEFAULT_TOKENS, fallback: DEFAULT_FALLBACK }) : ''
  if (!p || !token) return []
  let path = `/repos/${p.owner}/${p.repo}/commits?per_page=100`
  if (author) path += `&author=${encodeURIComponent(author)}`
  const res = await gh(path, { token })
  return (res || []).map((c) => ({
    sha: c.sha,
    message: c.commit?.message || '',
    author: c.commit?.author?.name || c.author?.login,
    author_email: c.commit?.author?.email,
    date: c.commit?.author?.date,
    html_url: c.html_url,
  }))
}

export function hasGitHub() {
  return !!(DEFAULT_FALLBACK || DEFAULT_TOKENS.size)
}
