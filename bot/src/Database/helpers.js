import { randomUUID } from 'crypto'

/** Generate a short id for DB primary keys (replaces cuid) */
export function id() {
  return randomUUID().replace(/-/g, '').slice(0, 25)
}

/** MySQL stores arrays as JSON; normalize to string[] for use in code */
export function ensureStringArray(val) {
  if (Array.isArray(val)) return val.map(String)
  if (val == null) return []
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return []
}

export function toJson(arr) {
  return JSON.stringify(Array.isArray(arr) ? arr : [])
}
