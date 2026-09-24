// The status→bucket table behind the per-project status categories. A leaf:
// imported by services/taskTicketChannel.js, which must not reach the planner.
import { cut, storedChannels } from './projectStore.js'

/** Discord's cap on a category name. */
export const MAX_CATEGORY_NAME = 100

/**
 * One row per bucket, in sidebar order. `statuses` are the task statuses that
 * file there; `storeKey` is the key under which the bucket category's id is
 * kept in `project.discordChannels`, beside the section channel ids, so the
 * cross-project claim set and /cleanup's protection cover it for free.
 */
export const BUCKETS = [
  { key: 'open', storeKey: 'bucketOpen', label: 'OPEN', statuses: ['open', 'pending'] },
  { key: 'inProgress', storeKey: 'bucketInProgress', label: 'IN PROGRESS', statuses: ['in_progress'] },
  { key: 'done', storeKey: 'bucketDone', label: 'DONE', statuses: ['done', 'resolved', 'closed', 'abandoned'] },
]

const BY_KEY = Object.fromEntries(BUCKETS.map((b) => [b.key, b]))
const BY_STATUS = new Map(BUCKETS.flatMap((b) => b.statuses.map((s) => [s, b.key])))

/** The bucket key for a status. Unknown, empty or null files as open. Never throws. */
export function bucketFor(status) {
  return BY_STATUS.get(String(status ?? '').trim().toLowerCase()) ?? 'open'
}

export function isDoneBucket(key) {
  return key === 'done'
}

export function bucketByKey(key) {
  return BY_KEY[key] ?? null
}

/**
 * '📂 FRAMEWORK · OPEN'. The name is cut so the suffix always survives the
 * 100-character cap — a bucket whose label was cut off would be unreadable.
 */
export function bucketNameFor(project, bucket) {
  const b = typeof bucket === 'string' ? BY_KEY[bucket] : bucket
  if (!b?.label) throw new Error(`unknown bucket ${String(bucket)}`)
  const suffix = ` · ${b.label}`
  const head = `📂 ${String(project?.name ?? '').trim().toUpperCase()}`
  return cut(head, MAX_CATEGORY_NAME - suffix.length) + suffix
}

/** The stored bucket category ids, by bucket key; null where none is stored. */
export function bucketIdsOf(project) {
  const stored = storedChannels(project)
  const out = {}
  for (const b of BUCKETS) out[b.key] = stored[b.storeKey] || null
  return out
}
