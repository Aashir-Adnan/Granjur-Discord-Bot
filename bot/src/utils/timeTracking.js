// Time tracking rules: parsing, formatting, runaway detection, week
// boundaries and aggregation. No database, no discord.js — this is the part
// that can be got wrong, so it is the part that is tested hardest.

export const DEFAULT_REMIND_HOURS = 6
export const DEFAULT_CAP_HOURS = 12

// The clockentry.minutes / task.estimateMinutes columns are 32-bit INTs; this
// is the storage ceiling, not a business maximum — /log-time and the task
// hub's estimate both share it, so a duration that fits one fits the other.
export const MAX_STORABLE_MINUTES = 2147483647

/** What to say when parseDuration returns null. Shared by every duration entry point. */
export const BAD_DURATION = 'I could not read that duration. Try 2h30m, 90m, 2.5h or 1:30.'

/**
 * Minutes from what a person typed: "2h30m", "2h 30m", "2.5h", "90m", "90",
 * "1:30". Null for anything that is not a positive duration. There is NO upper
 * bound by design — a long entry is somebody's real week, not a typo to refuse.
 */
export function parseDuration(text) {
  const raw = String(text ?? '').trim().toLowerCase()
  if (!raw) return null
  let minutes = null
  const clock = raw.match(/^(\d+):([0-5]\d)$/)
  const hm = raw.match(/^(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m?)?$/)
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*m$/)
  const bare = raw.match(/^(\d+(?:\.\d+)?)$/)
  if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2])
  else if (hm) minutes = Number(hm[1]) * 60 + Number(hm[2] ?? 0)
  else if (m) minutes = Number(m[1])
  else if (bare) minutes = Number(bare[1])
  if (minutes === null || !Number.isFinite(minutes)) return null
  const whole = Math.round(minutes)
  return whole > 0 ? whole : null
}

/** "3h 20m", "2h", "45m", "0m"; an em dash when there is nothing to show. */
export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return '—'
  const total = Math.max(0, Math.round(Number(minutes)))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

/** The duration of a closed entry. Null while it is open, never negative. */
export function entryMinutes(clockInAt, clockOutAt) {
  if (!clockOutAt) return null
  const ms = new Date(clockOutAt).getTime() - new Date(clockInAt).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.round(ms / 60000))
}

/** 'ok' | 'remind' | 'stop' for an open entry. 'stop' always wins. */
export function runawayState(entry, now, { remindAfterMin = DEFAULT_REMIND_HOURS * 60, capMin = DEFAULT_CAP_HOURS * 60 } = {}) {
  if (!entry || entry.clockOutAt) return 'ok'
  const ran = (new Date(now).getTime() - new Date(entry.clockInAt).getTime()) / 60000
  if (!Number.isFinite(ran)) return 'ok'
  if (ran >= capMin) return 'stop'
  if (ran >= remindAfterMin && !entry.remindedAt) return 'remind'
  return 'ok'
}

/** The offset, in minutes, of `tz` at `date`. 0 for an unknown zone. */
function offsetMinutes(date, tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]))
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second)
    return Math.round((asUTC - date.getTime()) / 60000)
  } catch {
    return 0
  }
}

/** The calendar date `date` falls on in `tz`, as { y, m (0-11), d }. */
function localDate(date, tz) {
  const local = new Date(date.getTime() + offsetMinutes(date, tz) * 60000)
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate() }
}

/**
 * The real instant at which calendar day y-m-d begins in `tz`. The zone's offset
 * must be read AT that midnight, not at whatever moment the caller started from:
 * on a clock-change day the two differ. `d` may be out of range (0, -3, 32...);
 * Date.UTC normalises it.
 */
function midnightOf(y, m, d, tz) {
  const wall = Date.UTC(y, m, d)
  const first = wall - offsetMinutes(new Date(wall), tz) * 60000
  const off = offsetMinutes(new Date(first), tz)
  return new Date(wall - off * 60000)
}

/** Midnight at the start of `date`'s day in `tz`, as a real instant. */
export function dayStart(date, tz) {
  const { y, m, d } = localDate(date, tz)
  return midnightOf(y, m, d, tz)
}

/** Midnight on the Monday that begins `date`'s week in `tz`. */
export function weekStart(date, tz) {
  const { y, m, d } = localDate(date, tz)
  const dow = new Date(Date.UTC(y, m, d)).getUTCDay() // 0 = Sunday
  const back = (dow + 6) % 7 // Monday = 0
  return midnightOf(y, m, d - back, tz)
}

/** since/until/label for 'today' | 'week' | 'month' | 'all'. Unknown = week. */
export function rangeFor(keyword, now = new Date(), tz = 'UTC') {
  const key = String(keyword ?? '').trim().toLowerCase()
  const until = new Date(now.getTime() + 60000)
  if (key === 'today') return { since: dayStart(now, tz), until, label: 'today' }
  if (key === 'month') {
    const { y, m } = localDate(now, tz)
    return { since: midnightOf(y, m, 1, tz), until, label: 'this month' }
  }
  if (key === 'all') return { since: new Date(0), until, label: 'all time' }
  return { since: weekStart(now, tz), until, label: 'this week' }
}

const closed = (entries) => (entries || []).filter((e) => e && e.minutes !== null && e.minutes !== undefined)

/** taskId (null for general work) -> total minutes. */
export function sumByTask(entries) {
  const out = new Map()
  for (const e of closed(entries)) {
    const key = e.taskId ?? null
    out.set(key, (out.get(key) ?? 0) + Number(e.minutes))
  }
  return out
}

/** discordId -> total minutes. */
export function sumByPerson(entries) {
  const out = new Map()
  for (const e of closed(entries)) {
    const key = String(e.discordId)
    out.set(key, (out.get(key) ?? 0) + Number(e.minutes))
  }
  return out
}

/**
 * Pairs of entries for the SAME person whose times overlap — two manual entries
 * claiming the same hour. Reported so a person can be asked, never refused:
 * the honest answer is "these two overlap, is that right?".
 */
export function overlaps(entries) {
  const byPerson = new Map()
  for (const e of entries || []) {
    if (!e?.clockOutAt) continue
    const list = byPerson.get(String(e.discordId)) ?? []
    list.push(e)
    byPerson.set(String(e.discordId), list)
  }
  const out = []
  for (const list of byPerson.values()) {
    const sorted = [...list].sort((a, b) => new Date(a.clockInAt) - new Date(b.clockInAt))
    for (let i = 0; i < sorted.length - 1; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i]
        const b = sorted[j]
        if (new Date(b.clockInAt) >= new Date(a.clockOutAt)) break
        out.push([a, b])
      }
    }
  }
  return out
}

const pad = (n) => String(n).padStart(2, '0')

/**
 * The local day whose report is owed at `now`: today once the local clock
 * reaches the cutoff, otherwise yesterday — whose own 23:59 has already gone.
 *
 * Yesterday is computed in calendar terms (Date.UTC normalises day 0 and day
 * -1 across month and year ends) rather than by subtracting 24h, which would
 * land on the wrong date across a DST change.
 */
export function dueReportDay(now, tz = 'UTC', { hour = 23, minute = 59 } = {}) {
  const local = new Date(now.getTime() + offsetMinutes(now, tz) * 60000)
  const h = local.getUTCHours()
  const past = h > hour || (h === hour && local.getUTCMinutes() >= minute)
  const { y, m, d } = localDate(now, tz)
  const ref = new Date(Date.UTC(y, m, past ? d : d - 1))
  return `${ref.getUTCFullYear()}-${pad(ref.getUTCMonth() + 1)}-${pad(ref.getUTCDate())}`
}

/** The half-open [since, until) instants covering local day `key` in `tz`. */
export function dayWindow(key, tz = 'UTC') {
  const [y, m, d] = String(key).split('-').map(Number)
  return { since: midnightOf(y, m - 1, d, tz), until: midnightOf(y, m - 1, d + 1, tz) }
}

/**
 * Every roster member with their minutes for the day — zero when they logged
 * nothing, because the daily post lists everyone on purpose. Highest first,
 * ties alphabetical, so the zeros collect into a predictable block.
 */
export function rankDailyTotals(members, totals) {
  const byId = new Map()
  for (const row of totals || []) byId.set(String(row.discordId), Number(row.minutes) || 0)
  return (members || [])
    .map((mem) => ({
      discordId: String(mem.discordId),
      name: mem.name,
      minutes: byId.get(String(mem.discordId)) || 0,
    }))
    .sort((a, b) => b.minutes - a.minutes || String(a.name).localeCompare(String(b.name)))
}
