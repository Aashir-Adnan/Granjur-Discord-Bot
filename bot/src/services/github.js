import fetch from 'node-fetch'
import { config } from '../config.js'

const token = config.github?.token || process.env.GITHUB_TOKEN || ''

function parseRepoUrl(url) {
  const match = (url || '').match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  return match ? { owner: match[1], repo: match[2].replace(/\.git$/, '') } : null
}

async function gh(path, options = {}) {
  const base = 'https://api.github.com'
  const res = await fetch(`${base}${path}`, {
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
  if (!res.ok) throw new Error(data.message || text || res.statusText)
  return data
}

export async function createIssue(repoUrl, title, body) {
  const p = parseRepoUrl(repoUrl)
  if (!p || !token) return null
  const res = await gh(`/repos/${p.owner}/${p.repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body }),
    headers: { 'Content-Type': 'application/json' },
  })
  return { url: res.html_url, number: res.number }
}

export async function getRepoContents(repoUrl, path = '') {
  const p = parseRepoUrl(repoUrl)
  if (!p || !token) return []
  const urlPath = path ? `/repos/${p.owner}/${p.repo}/contents/${path}` : `/repos/${p.owner}/${p.repo}/contents/`
  const res = await gh(urlPath)
  const list = Array.isArray(res) ? res : []
  return list.map((e) => ({ name: e.name, path: e.path, type: e.type === 'dir' ? 'dir' : 'file', sha: e.sha }))
}

/** Fetch raw file content from repo (e.g. README.md). Returns decoded string or null. */
export async function getRepoFileContent(repoUrl, filePath = 'README.md') {
  const p = parseRepoUrl(repoUrl)
  if (!p) return null
  try {
    const res = await gh(`/repos/${p.owner}/${p.repo}/contents/${encodeURIComponent(filePath)}`)
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
  if (!p || !token) return []
  let path = `/repos/${p.owner}/${p.repo}/commits?per_page=100`
  if (author) path += `&author=${encodeURIComponent(author)}`
  const res = await gh(path)
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
  return !!token
}
