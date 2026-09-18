import db, { getOrCreateGuildConfig } from '../db/index.js'
import { holdersOf } from '../utils/taskLabel.js'

const TICK_MS = 60 * 60 * 1000 // check hourly; at most one reminder per guild per day
const DM_DELAY_MS = 2000 // avoid rate limits
const REMINDER_HOUR = Number(process.env.TICKET_REMINDER_HOUR) || 9

/** Guild id -> the YYYY-MM-DD it was last reminded, so a restart cannot re-send. */
const sentOn = new Map()

/**
 * Group a guild's unfinished tickets by the person they concern, separating
 * what someone HOLDS from what they merely opened.
 *
 * "Open" is a status — not finished — and reads to people as "unclaimed", so
 * the message must say who a ticket is assigned to rather than leaving them to
 * infer it. Pure; `botUserId` is dropped because meeting tasks are created by
 * the bot and it cannot DM itself.
 */
export function groupTickets({ features = [], bugs = [], botUserId = null }) {
  const byUser = new Map()
  const put = (id, bucket, entry) => {
    if (!id || id === botUserId) return
    if (!byUser.has(id)) byUser.set(id, { assigned: [], created: [] })
    byUser.get(id)[bucket].push(entry)
  }

  for (const [rows, kind] of [[features, 'feature'], [bugs, 'bug']]) {
    for (const t of rows) {
      const entry = {
        kind,
        title: t.title || (kind === 'bug' ? 'Bug' : 'Feature'),
        status: t.status || 'open',
        channelId: t.discordChannelId || null,
      }
      const holders = holdersOf(t)
      for (const id of holders) put(id, 'assigned', entry)
      // Only tell the author about a ticket nobody holds — otherwise it is the
      // assignee's to carry, and the author does not need a daily nudge.
      if (holders.length === 0) put(t.createdBy, 'created', entry)
    }
  }
  return byUser
}

/** The DM body for one person. Pure; returns null when there is nothing to say. */
export function buildReminderBody(guildName, { assigned = [], created = [] }, max = 2000) {
  if (assigned.length === 0 && created.length === 0) return null
  const line = (t) => {
    const where = t.channelId ? ` — <#${t.channelId}>` : ''
    return `• \`${t.status}\` ${String(t.title).slice(0, 80)}${where}`
  }
  const section = (heading, rows) => {
    if (rows.length === 0) return []
    const out = [heading, ...rows.slice(0, 15).map(line)]
    if (rows.length > 15) out.push(`_… and ${rows.length - 15} more_`)
    return out
  }
  const lines = [
    `**${guildName}** — your unfinished tickets`,
    '',
    ...section('**Assigned to you:**', assigned),
    ...(assigned.length && created.length ? [''] : []),
    ...section('**You opened, nobody assigned:**', created),
    '',
    '_Change status or assignees with_ **/update-task**.',
  ]
  return lines.join('\n').slice(0, max)
}

/** Local YYYY-MM-DD, used to hold the reminder to once per calendar day. */
function dayKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * Daily DM of everyone's unfinished tickets.
 *
 * Deliberately does NOT fire on startup. It used to, so every deploy or crash
 * loop sent the whole server another copy — six restarts in an afternoon meant
 * six identical DMs, which is how a reminder becomes something people mute.
 */
export function startTicketReminder(client) {
  if (!client?.guilds) return

  async function runGuild(guildId, guild) {
    const cfg = await getOrCreateGuildConfig(guildId)
    if (!cfg) return
    const [features, bugs] = await Promise.all([
      db.feature.findMany({ where: { guildConfigId: cfg.id, status: 'open' }, take: 200 }),
      db.bugTicket.findMany({ where: { guildConfigId: cfg.id, status: 'pending' }, take: 200 }),
    ])
    const byUser = groupTickets({ features, bugs, botUserId: client.user?.id })

    for (const [userId, groups] of byUser) {
      const body = buildReminderBody(guild.name, groups)
      if (!body) continue
      try {
        const user = await client.users.fetch(userId).catch(() => null)
        if (!user || user.bot) continue
        await user.send({ content: body }).catch(() => {})
        await new Promise((r) => setTimeout(r, DM_DELAY_MS))
      } catch (e) {
        console.warn(`[ticketReminder] DM to ${userId} failed:`, e?.message || e)
      }
    }
  }

  function tick() {
    if (new Date().getHours() !== REMINDER_HOUR) return
    const today = dayKey()
    ;(async () => {
      for (const [guildId, guild] of client.guilds.cache) {
        if (sentOn.get(guildId) === today) continue
        sentOn.set(guildId, today)
        try {
          await runGuild(guildId, guild)
        } catch (e) {
          console.warn(`[ticketReminder] guild ${guildId} failed:`, e?.message || e)
        }
      }
    })()
  }

  setInterval(tick, TICK_MS)
  tick() // no-op unless the bot happens to start during the reminder hour
}
