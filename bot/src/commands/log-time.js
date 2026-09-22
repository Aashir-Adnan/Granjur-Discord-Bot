import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { isLeadershipFor, memberProjectIdsOf } from '../utils/timeAccess.js'
import { clockableTasks } from '../utils/timeTaskPicker.js'
import { BAD_DURATION, MAX_STORABLE_MINUTES, entryMinutes, formatDuration, overlaps, parseDuration } from '../utils/timeTracking.js'
import { GENERAL } from './clock-in.js'

// The same task picker as /clock-in: same access rule, same choices.
export { autocomplete } from './clock-in.js'

export const data = new SlashCommandBuilder()
  .setName('log-time')
  .setDescription('Add time you already spent on a task')
  .addStringOption((o) =>
    o.setName('task').setDescription('The task you worked on').setRequired(true).setAutocomplete(true))
  .addStringOption((o) =>
    o.setName('duration').setDescription('How long: 2h30m, 90m, 2.5h or 1:30').setRequired(true))
  .addStringOption((o) =>
    o.setName('when').setDescription('The day it ended: today (default), yesterday or YYYY-MM-DD').setRequired(false))
  .addStringOption((o) =>
    o.setName('note').setDescription('What you got done (optional)').setRequired(false).setMaxLength(500))

const NOT_AVAILABLE = 'That task is not available to you.'
// Re-exported: timePanel.js imports BAD_DURATION from here.
export { BAD_DURATION }
const BAD_WHEN = 'I could not read that date. Use today, yesterday or YYYY-MM-DD.'
const IN_THE_FUTURE = 'That is in the future.'
const TOO_LARGE = 'That duration is too large to store.'

// MySQL DATETIME starts in the year 1000.
const MIN_STORABLE_YEAR = 1000
const OVERLAP_LOOKBACK_MS = 7 * 86400000

/**
 * The window a retroactive entry occupies: it ends on `when` at the current
 * time of day and runs backwards by the duration. Days are UTC by design.
 * Returns null for a date we cannot read (including one that does not exist,
 * like 2026-02-31, which Date would otherwise roll into March), so the caller
 * can refuse rather than invent a day.
 */
export function entryWindow(minutes, when, now = new Date()) {
  const key = String(when ?? 'today').trim().toLowerCase()
  let end
  if (!key || key === 'today') end = new Date(now)
  else if (key === 'yesterday') end = new Date(now.getTime() - 86400000)
  else if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const [y, m, d] = key.split('-').map(Number)
    const at = new Date(now)
    at.setUTCFullYear(y, m - 1, d)
    if (Number.isNaN(at.getTime())) return null
    if (at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null
    end = at
  } else return null
  return { clockInAt: new Date(end.getTime() - minutes * 60000), clockOutAt: end }
}

/** True when the entry just written overlaps another entry of the same person. */
async function overlapsAnother(dbArg, cfg, userId, entry) {
  const nearby = await dbArg.clockEntry.findMany({
    where: {
      guildConfigId: cfg.id,
      discordId: userId,
      since: new Date(new Date(entry.clockInAt).getTime() - OVERLAP_LOOKBACK_MS),
      until: entry.clockOutAt,
    },
    take: 500,
  })
  // The read can return the entry just written; it does not overlap itself.
  const others = (nearby || []).filter((e) => e.id !== entry.id)
  return overlaps([...others, entry]).some((pair) => pair.includes(entry))
}

/**
 * The guards every stored entry window must pass — /log-time and the /my-time
 * editor share them: a duration the column can hold, a date that exists, an end
 * that is not in the future (judged against the REAL `now`), and a start the
 * database can store. `clockSource` is what "the current time of day" means for
 * the window (defaults to `now`); the /my-time editor passes the entry's own end
 * so its time of day is kept.
 * @returns {{ window: {clockInAt: Date, clockOutAt: Date} } | { error: string }}
 */
export function resolveEntryWindow(minutes, when, { now = new Date(), clockSource = now } = {}) {
  // No maximum by design; the only limit is what the column can hold.
  if (!Number.isSafeInteger(minutes) || minutes > MAX_STORABLE_MINUTES) return { error: TOO_LARGE }
  const window = entryWindow(minutes, when, clockSource)
  if (!window) return { error: BAD_WHEN }
  if (window.clockOutAt.getTime() > now.getTime()) return { error: IN_THE_FUTURE }
  if (!Number.isFinite(window.clockInAt.getTime()) || window.clockInAt.getUTCFullYear() < MIN_STORABLE_YEAR) {
    return { error: TOO_LARGE }
  }
  return { window }
}

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig, now = new Date() } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  const minutes = parseDuration(interaction.options.getString('duration'))
  if (minutes === null) return interaction.editReply({ content: BAD_DURATION })

  const resolved = resolveEntryWindow(minutes, interaction.options.getString('when'), { now })
  if (resolved.error) return interaction.editReply({ content: resolved.error })
  const { window } = resolved

  const picked = String(interaction.options.getString('task') ?? GENERAL).trim() || GENERAL
  const userId = interaction.user.id

  // Same access rule as /clock-in. A task that does not exist and one the
  // caller cannot use get the same message, so this cannot probe for tasks.
  let task = null
  if (picked !== GENERAL) {
    task = await dbArg.task.findFirst({ where: { id: picked, guildConfigId: cfg.id } })
    const allowed = task
      ? clockableTasks([task], {
          memberProjectIds: await memberProjectIdsOf(dbArg, cfg, userId),
          isLeadership: isLeadershipFor(interaction.guild, interaction.member, cfg),
          callerId: userId,
        }).length > 0
      : false
    if (!allowed) return interaction.editReply({ content: NOT_AVAILABLE })
  }
  const taskId = task ? task.id : null

  const note = String(interaction.options.getString('note') ?? '').trim() || null
  const entryData = {
    guildConfigId: cfg.id,
    discordId: userId,
    taskId,
    clockInAt: window.clockInAt,
    clockOutAt: window.clockOutAt,
    minutes: entryMinutes(window.clockInAt, window.clockOutAt),
    source: 'manual',
  }
  if (note) entryData.note = note
  const created = await dbArg.clockEntry.create({ data: entryData })
  const entry = { ...entryData, ...(created || {}) }

  const target = task ? `**${task.title}**` : 'general work'
  const day = window.clockOutAt.toISOString().slice(0, 10)
  let content = `**Logged ${formatDuration(entry.minutes)}** on ${target} (ending ${day}).`

  // The total is a SQL SUM, never a sum over a capped list of entries.
  if (taskId) {
    try {
      const rows = await dbArg.clockEntry.sumByTask({ guildConfigId: cfg.id, taskIds: [taskId] })
      const total = (rows || []).reduce((n, r) => n + Number(r.minutes || 0), 0)
      content += ` Task total: **${formatDuration(total)}**.`
    } catch (e) {
      console.error('[log-time] task total:', e?.message ?? e)
    }
  }

  // Overlap is a question for the person, never a refusal: the entry stands.
  try {
    if (await overlapsAnother(dbArg, cfg, userId, entry)) {
      content += '\n⚠️ This overlaps another entry of yours — check **/my-time**.'
    }
  } catch (e) {
    console.error('[log-time] overlap check:', e?.message ?? e)
  }

  await interaction.editReply({ content })
}
