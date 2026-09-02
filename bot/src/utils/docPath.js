/**
 * Pure helpers that map a UBS-Doc repository path onto the values the bot stores.
 * The include/exclude rule and the id derivation mirror the site's
 * src/docs/docsIndex.ts exactly, so a docId here is a working site route.
 */

const DOCS_PREFIX = 'docs/'
const EXCLUDED_PREFIX = 'docs/superpowers/'

/** True if this repository path is a doc the site would route. */
export function isDocFile(path) {
  if (typeof path !== 'string') return false
  if (!path.startsWith(DOCS_PREFIX)) return false
  if (path.startsWith(EXCLUDED_PREFIX)) return false
  return /\.mdx?$/i.test(path)
}

/** 'docs/api/overview.md' -> 'api/overview' (the site's route id). */
export function toDocId(path) {
  return path.slice(DOCS_PREFIX.length).replace(/\.mdx?$/i, '')
}

/** First path segment under docs/. Loose root files return their filename. */
export function sectionOf(path) {
  return path.slice(DOCS_PREFIX.length).split('/')[0]
}

/** 'Badar HMS' -> 'badar-hms'. Used to derive a project's default docsSlug. */
export function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function humanizeFilename(path) {
  const base = path.split('/').pop().replace(/\.mdx?$/i, '')
  const humanized = base.replace(/[-_]+/g, ' ').trim()
  return humanized.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** Frontmatter title, else the first '# ' heading, else a humanized filename. */
export function extractTitle(content, path) {
  const text = String(content || '')
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const t = fm[1].match(/^title:\s*(.+)$/m)
    if (t) return t[1].trim().replace(/^['"]|['"]$/g, '')
  }
  const body = fm ? text.slice(fm[0].length) : text
  const heading = body.match(/^#\s+(.+)$/m)
  if (heading) return heading[1].trim()
  return humanizeFilename(path)
}

/**
 * Return the id of the project that owns this path, or null.
 * A project owns `docs/projects/<docsSlug>/**` plus each prefix in docsPaths
 * (relative to docs/). Matching is on whole directory segments, so a project
 * slugged 'hms' never captures 'hms-other'.
 */
export function attributeProject(path, projects) {
  const rel = path.slice(DOCS_PREFIX.length)
  for (const p of projects || []) {
    const prefixes = []
    if (p.docsSlug) prefixes.push(`projects/${p.docsSlug}/`)
    for (const extra of p.docsPaths || []) {
      const clean = String(extra).replace(/^\/+|\/+$/g, '')
      if (clean) prefixes.push(`${clean}/`)
    }
    if (prefixes.some((pre) => rel.startsWith(pre))) return p.id
  }
  return null
}
