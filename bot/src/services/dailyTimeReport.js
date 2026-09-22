import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js'
import db, { getOrCreateGuildConfig, updateGuildConfig } from '../db/index.js'
import { isValidZone } from '../utils/timezone.js'
import { dayWindow, dueReportDay, formatDuration, rankDailyTotals } from '../utils/timeTracking.js'

// Posts each day's per-person totals to a channel everyone can read, at 23:59
// in the guild's own timezone.
//
// Follows ticketReminder.js's shape (interval tick plus a day-key guard) with
// two corrections: the cutoff is evaluated in the GUILD's timezone rather than
// the bot host's local clock, and the guard is a persisted column rather than
// an in-memory Map — losing a Map on restart is untidy for a DM and
// embarrassing for a public channel.

const TICK_MS = 60 * 1000
const CHANNEL_NAME = 'time-reports'
const MAX_LINES = 40

const pad = (n) => String(n).padStart(2, '0')

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

/**
 * The channel to post in: the configured one, or a fresh #time-reports that
 * @everyone can read but not write. A failure to create is logged and skipped
 * — the pass retries next tick rather than throwing out of the interval.
 */
async function resolveChannel(guild, cfg, update) {
  if (cfg.timeReportChannelId) {
    const existing = await guild.channels.fetch(cfg.timeReportChannelId).catch(() => null)
    if (existing) return existing
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
    console.warn('[dailyTimeReport] could not create the channel:', e?.message || e)
    return null
  })
  if (created) await update(guild.id, { timeReportChannelId: created.id }).catch(() => {})
  return created
}

export async function runDailyReportPass(client, {
  db: dbArg = db,
  getConfig = getOrCreateGuildConfig,
  update = updateGuildConfig,
  now = new Date(),
} = {}) {
  for (const [, guild] of client.guilds.cache) {
    try {
      const cfg = await getConfig(guild.id).catch(() => null)
      if (!cfg) continue

      const tz = isValidZone(cfg.timezone) ? cfg.timezone : 'UTC'
      const due = dueReportDay(now, tz)
      const last = dateKey(cfg.lastTimeReportOn)

      // String compare is safe and total for 'YYYY-MM-DD'.
      if (last && last >= due) continue

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

      // Someone who left keeps their guildmember row; listing them forever as
      // 0m would turn the post into a graveyard.
      const members = []
      for (const row of rows || []) {
        const member = await guild.members.fetch(String(row.discordId)).catch(() => null)
        if (!member) continue
        members.push({ discordId: String(row.discordId), name: member.displayName || row.displayName || row.username || `Member ${row.discordId}` })
      }

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
      // Recorded only after a successful post, so a failed send retries.
      await update(guild.id, { lastTimeReportOn: due })
    } catch (e) {
      console.warn(`[dailyTimeReport] guild ${guild?.id} failed:`, e?.message || e)
    }
  }
}

export function startDailyTimeReport(client, { db: dbArg = db, intervalMs = TICK_MS } = {}) {
  const tick = () => { runDailyReportPass(client, { db: dbArg }).catch(() => {}) }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  tick()
  return timer
}
