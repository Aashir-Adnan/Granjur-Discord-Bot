import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const BOT_DOCS = path.resolve(here, '..', '..', 'docs')

export function listRoots() {
  const roots = [{ key: 'bot', label: 'Bot docs', dir: BOT_DOCS }]
  const ubs = process.env.UBS_DOC_PATH
  if (ubs) {
    const abs = path.resolve(ubs)
    try {
      if (fs.statSync(abs).isDirectory()) {
        roots.push({ key: 'ubs', label: 'UBS Knowledge Base', dir: abs })
      }
    } catch {
      /* not present — skip silently */
    }
  }
  return roots
}

export function rootByKey(key) {
  return listRoots().find((r) => r.key === key) || null
}

export function resolveDocPath(rootKey, relativePath) {
  const root = rootByKey(rootKey)
  if (!root) return null
  // Resolve the requested path against the root and require the result to stay
  // inside the root dir. Resolving directly (rather than stripping leading
  // "../" first) keeps the guard effective — a stripped path could still be
  // rebuilt into an escaping path on some inputs.
  const full = path.resolve(root.dir, relativePath || '')
  if (full !== root.dir && !full.startsWith(root.dir + path.sep)) return null
  return full
}
