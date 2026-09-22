import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js'
import db, { getOrCreateGuildConfig, updateGuildConfig } from '../db/index.js'
import { isValidZone } from '../utils/timezone.js'
import { dayWindow, dueReportDay, formatDuration, rankDailyTotals } from '../utils/timeTracking.js'

// Posts each day's per-person totals to a channel everyone can read, at 23:59
// in the guild's own timezone.
//
// Follows clockWatch.js's shape (interval tick, one immediate tick, an
// in-flight guard) and improves on ticketReminder.js's "once per guild per
// day" precedent in two ways: the cutoff is evaluated in the GUILD's timezone
// rather than the bot host's local clock, and the "already posted" guard is a
// persisted column rather than an in-memory Map — losing a Map on restart is
// untidy for a DM and embarrassing for a public channel.
//
// A pass here is slower than clockWatch's (two DB reads plus a bulk member
// fetch, per guild, before the state write that closes the window), so it
// needs the same in-flight guard clockWatch has: without it, two overlapping
// 60s ticks can both observe "not yet posted" and both send.

const TICK_MS = 60 * 1000
const CHANNEL_NAME = 'time-reports'
const MAX_LINES = 40

// discord.js RESTJSONErrorCodes, inlined so this file has no extra import for
// two numbers: Unknown Channel, and Unknown Member / Unknown User.
const UNKNOWN_CHANNEL = 10003
const UNKNOWN_MEMBER_CODES = new Set([10007, 10013])

const pad = (n) => String(n).padStart(2, '0')
const errText = (e) => e?.message ?? e

/** A DATE column comes back as a Date from mysql2, or a string; both to 'YYYY-MM-DD'. */
function dateKey(v) {
  if (!v) return null
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  return String(v).slice(0, 10)
}

/** The embed's body: everyone, zeros included, with a truthful truncation tail. */
export function reportLines(ranked, max = MAX_LINES) {
  const shown = (ranked || []).slice(0, max)
  const lines = shown.map((r) => `**${r.name}** — ${formatDuration(r.minutes)}`)
  if ((ranked || []).length > shown.length) lines.push(`…and ${ranked.length - shown.length} more`)
  return lines
}

// Passes currently running, by db. Mirrors clockWatch.js's inFlight guard: a
// pass that starts while one is still running against the same db is skipped
// rather than run twice at once.
const inFlight = new WeakSet()

// Backstop for "send succeeded, the state write then failed": db ->
// Map<guildId, due-day-already-posted-this-process>. Set immediately after a
// successful `channel.send`, and checked alongside the persisted column, so a
// persisted write that keeps failing cannot turn into a post every tick —
// only the one duplicate a restart can still cause, which is the trade-off
// already accepted for send-then-record ordering.
const postedThisRun = new WeakMap()
function postedMapFor(dbArg) {
  let m = postedThisRun.get(dbArg)
  if (!m) { m = new Map(); postedThisRun.set(dbArg, m) }
  return m
}

/**
 * The channel to post in: the configured one, or a fresh #time-reports that
 * @everyone can read but not write.
 *
 * A `channels.fetch` failure only means "recreate" when Discord confirms the
 * channel itself is gone (Unknown Channel, 10003). A 5xx, a 429 or a
 * momentary permission gap is not that, and creating a second channel over
 * it would abandon the first one's history; those cases return null so this
 * pass skips its post and retries next tick. Likewise, a `create` that
 * succeeds but whose id we then fail to persist must not be posted into:
 * that id would be lost and every following due day would create yet
 * another channel.
 */
async function resolveChannel(guild, cfg, update) {
  if (cfg.timeReportChannelId) {
    try {
      const existing = await guild.channels.fetch(cfg.timeReportChannelId)
      if (existing) return existing
    } catch (e) {
      if (e?.code !== UNKNOWN_CHANNEL) {
        console.warn('[dailyTimeReport] channel fetch failed, not recreating:', errText(e))
        return null
      }
      // Unknown Channel: the configured channel really is gone; fall through and recreate it.
    }
  }

  const created = await guild.channels.create({
    name: CHANNEL_NAME,
    type: ChannelType.GuildText,
    topic: 'Daily time totals, posted automatically at 23:59.',
    permissionOverwrites: [{
      id: guild.roles.everyone.id,
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [PermissionFlagsBits.SendMessages],
    }],
  }).catch((e) => {
    console.warn('[dailyTimeReport] could not create the channel:', errText(e))
    return null
  })
  if (!created) return null

  try {
    await update(guild.id, { timeReportChannelId: created.id })
  } catch (e) {
    // The id could not be persisted: posting now would mean the next due day
    // creates ANOTHER channel (config still shows none configured), and the
    // day after that another. Abort this pass's post instead.
    console.warn('[dailyTimeReport] could not persist the new channel id, skipping this post:', errText(e))
    return null
  }
  return created
}

/**
 * Every roster row, named. A departed member — absent from a SUCCESSFUL bulk
 * fetch — is dropped: someone who left keeps their guildmember row, and
 * listing them forever at 0m would turn the post into a graveyard. A bulk
 * fetch that fails outright (permissions, network, rate limit, gateway
 * timeout) says nothing about who is still in the guild, so it must not be
 * read as "everyone left" — every row is kept, named from the roster's own
 * data, rather than silently understating the report (which would also
 * corrupt the team total, summed only over whoever survived the drop).
 */
async function hydrateRoster(guild, rows) {
  const ids = rows.map((row) => String(row.discordId))
  if (ids.length === 0) return []

  let fetched
  try {
    fetched = await guild.members.fetch({ user: ids })
  } catch (e) {
    if (UNKNOWN_MEMBER_CODES.has(e?.code)) {
      fetched = new Map()
    } else {
      console.warn('[dailyTimeReport] bulk member fetch failed, keeping the roster as-is:', errText(e))
      return rows.map((row) => ({
        discordId: String(row.discordId),
        name: row.displayName || row.username || `Member ${row.discordId}`,
      }))
    }
  }

  const members = []
  for (const row of rows) {
    const id = String(row.discordId)
    const member = typeof fetched.get === 'function' ? fetched.get(id) : fetched?.[id]
    if (!member) continue // genuinely departed — absent from a successful fetch
    members.push({ discordId: id, name: member.displayName || row.displayName || row.username || `Member ${id}` })
  }
  return members
}

export async function runDailyReportPass(client, {
  db: dbArg = db,
  getConfig = getOrCreateGuildConfig,
  update = updateGuildConfig,
  now = new Date(),
} = {}) {
  if (inFlight.has(dbArg)) return { skipped: true }
  inFlight.add(dbArg)
  const posted = postedMapFor(dbArg)
  try {
    for (const [, guild] of client.guilds.cache) {
      try {
        const cfg = await getConfig(guild.id).catch(() => null)
        if (!cfg) continue

        const tz = isValidZone(cfg.timezone) ? cfg.timezone : 'UTC'
        const due = dueReportDay(now, tz)
        const last = dateKey(cfg.lastTimeReportOn)

        // String compare is safe and total for 'YYYY-MM-DD'.
        if (last && last >= due) continue
        // In-memory backstop: already sent this process run for this due day,
        // even though the persisted column write below must have failed.
        if (posted.get(guild.id) === due) continue

        // First ever pass: adopt the current day silently, so deploying at 3pm
        // does not fire a surprise report for yesterday.
        if (!last) {
          await update(guild.id, { lastTimeReportOn: due })
          continue
        }

        const { since, until } = dayWindow(due, tz)
        const totals = await dbArg.clockEntry.sumByPersonRange({ guildConfigId: cfg.id, since, until })
        // `all: true` or guildMemberFindMany silently caps the roster at 25.
        const rows = await dbArg.guildMember.findMany({
          where: { guildConfigId: cfg.id, status: 'approved', all: true },
        })

        const members = await hydrateRoster(guild, rows || [])
        const ranked = rankDailyTotals(members, totals)
        const channel = await resolveChannel(guild, cfg, update)
        if (!channel) continue

        const label = new Intl.DateTimeFormat('en-GB', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz,
        }).format(since)
        const total = ranked.reduce((n, r) => n + r.minutes, 0)

        const embed = new EmbedBuilder()
          .setTitle(`Time — ${label}`)
          .setDescription(reportLines(ranked).join('\n') || 'Nobody is on the roster yet.')
          .addFields({ name: 'Team total', value: formatDuration(total) })
          .setColor(0x5865f2)

        await channel.send({ embeds: [embed] })
        // Recorded in-memory immediately: even if the persisted write below
        // fails, this run will not resend for this due day.
        posted.set(guild.id, due)
        // Recorded in the database only after a successful post, so a failed
        // send retries next tick.
        await update(guild.id, { lastTimeReportOn: due })
      } catch (e) {
        console.warn(`[dailyTimeReport] guild ${guild?.id} failed:`, errText(e))
      }
    }
  } finally {
    inFlight.delete(dbArg)
  }
}

export function startDailyTimeReport(client, { db: dbArg = db, intervalMs = TICK_MS } = {}) {
  const tick = () => { runDailyReportPass(client, { db: dbArg }).catch(() => {}) }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  tick()
  return timer
}
