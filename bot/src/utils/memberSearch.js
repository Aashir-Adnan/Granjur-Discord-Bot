/**
 * Ids of cached guild members whose display name or username contains `term`
 * (case-insensitive). The task pickers hand these to `task.findMany`'s
 * `search.holderIds` so "type a person's name" still finds their tasks now that
 * the narrowing happens in SQL, which knows ids but not names. Cache only — an
 * autocomplete has about three seconds and a fetch per keystroke would blow it.
 */
export function memberIdsNamed(guild, term, { max = 10 } = {}) {
  const t = String(term ?? '').trim().toLowerCase()
  const cache = guild?.members?.cache
  if (!t || !cache || typeof cache.values !== 'function') return []
  const out = []
  for (const m of cache.values()) {
    const names = [m?.displayName, m?.user?.username, m?.nickname]
    if (names.some((n) => n && String(n).toLowerCase().includes(t))) {
      out.push(String(m.id))
      if (out.length >= max) break
    }
  }
  return out
}
