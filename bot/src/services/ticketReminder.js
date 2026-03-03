import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'

const INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
const DM_DELAY_MS = 2000 // avoid rate limits

/**
 * Notify users involved in open tickets via DM every day.
 * Runs once per day; for each user, sends a DM listing their open feature and bug tickets.
 */
export function startTicketReminder(client) {
  if (!client?.guilds) return
  function run() {
    (async () => {
      try {
        for (const [guildId, guild] of client.guilds.cache) {
          try {
            const cfg = await getOrCreateGuildConfig(guildId)
            if (!cfg) continue
            const openFeatures = await db.feature.findMany({
              where: { guildConfigId: cfg.id, status: 'open' },
              take: 200,
            })
            const openBugs = await db.bugTicket.findMany({
              where: { guildConfigId: cfg.id, status: 'pending' },
              take: 200,
            })
            const byUser = new Map()
            for (const f of openFeatures) {
              const ids = [f.createdBy, ...ensureStringArray(f.assigneeIds)]
              for (const id of ids) {
                if (!byUser.has(id)) byUser.set(id, { features: [], bugs: [] })
                byUser.get(id).features.push({ title: f.title, id: f.id })
              }
            }
            for (const b of openBugs) {
              const ids = [b.createdBy, ...ensureStringArray(b.taggedMemberIds)]
              for (const id of ids) {
                if (!byUser.has(id)) byUser.set(id, { features: [], bugs: [] })
                byUser.get(id).bugs.push({ title: b.title, id: b.id })
              }
            }
            for (const [userId, { features, bugs }] of byUser) {
              if (features.length === 0 && bugs.length === 0) continue
              try {
                const user = await client.users.fetch(userId).catch(() => null)
                if (!user) continue
                const lines = []
                if (features.length) {
                  lines.push('**Open feature tickets:**')
                  features.slice(0, 15).forEach((f) => lines.push(`• ${(f.title || 'Feature').slice(0, 80)}`))
                  if (features.length > 15) lines.push(`_… and ${features.length - 15} more_`)
                }
                if (bugs.length) {
                  lines.push('**Open bug tickets:**')
                  bugs.slice(0, 15).forEach((b) => lines.push(`• ${(b.title || 'Bug').slice(0, 80)}`))
                  if (bugs.length > 15) lines.push(`_… and ${bugs.length - 15} more_`)
                }
                const body = `**${guild.name}** — Open ticket reminder\n\n${lines.join('\n\n')}`
                await user.send({ content: body.slice(0, 2000) }).catch(() => {})
                await new Promise((r) => setTimeout(r, DM_DELAY_MS))
              } catch (_) {}
            }
          } catch (_) {}
        }
      } catch (_) {}
    })()
  }
  setInterval(run, INTERVAL_MS)
  run()
}
