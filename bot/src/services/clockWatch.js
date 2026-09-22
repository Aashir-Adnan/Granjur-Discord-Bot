// Watches for forgotten task timers: reminds after the guild's reminder hour
// (default 6h) and stops the timer at the cap (default 12h).
//
// Runs at startup and every five minutes. Like memberNameSync, the db is a
// seam and a failure is logged and swallowed. Each entry is handled in its own
// try/catch, so one bad entry (or one closed-DM user) never stops the pass.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import db from '../db/index.js'
import { closeEntry } from '../commands/clock-in.js'
import {
  runawayState, entryMinutes, formatDuration, DEFAULT_REMIND_HOURS, DEFAULT_CAP_HOURS,
} from '../utils/timeTracking.js'

export const CLOCK_WATCH_INTERVAL_MS = 5 * 60 * 1000

// Passes currently running, by db. A pass that starts while one is still
// running against the same db is skipped rather than run twice at once.
const inFlight = new WeakSet()

const errText = (e) => e?.message ?? e

/** The guild's reminder / cap, in minutes. A null column means the default. */
function limitsOf(cfg) {
  const hours = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== undefined && Number(v) > 0 ? Number(v) : fallback)
  return {
    remindAfterMin: Math.round(hours(cfg?.clockReminderHours, DEFAULT_REMIND_HOURS) * 60),
    capMin: Math.round(hours(cfg?.clockCapHours, DEFAULT_CAP_HOURS) * 60),
  }
}

/** Best-effort: take the "clocked in" role off a member. Never throws. */
async function removeClockedInRole(client, cfg, discordId) {
  try {
    if (!cfg?.clockedInRoleId) return
    const guild = client?.guilds?.cache?.get(cfg.guildId)
    if (!guild) return
    const member = await guild.members.fetch(discordId).catch(() => null)
    if (member) await member.roles.remove(cfg.clockedInRoleId).catch(() => {})
  } catch (e) {
    console.error('[clockWatch] role removal:', errText(e))
  }
}

/** The task's title for a message: null for general work. */
async function titleOf(dbArg, taskId) {
  if (!taskId) return null
  try {
    const task = await dbArg.task.findFirst({ where: { id: taskId } })
    return task?.title ?? 'a task that no longer exists'
  } catch {
    return 'a task'
  }
}

function reminderMessage(entry, title, now) {
  const running = formatDuration(entryMinutes(entry.clockInAt, now))
  const content = title === null
    ? `Still clocked in? It's been ${running}.`
    : `Still on **${title}**? It's been ${running}.`
  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`clk_keep:${entry.id}`).setLabel('Keep going').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`clk_stop:${entry.id}`).setLabel('Stop now').setStyle(ButtonStyle.Danger),
  )]
  return { content, components }
}

async function remind(client, dbArg, entry, now) {
  // Stamp first, whether or not the DM lands: somebody with closed DMs must
  // not be retried every pass until the cap. If the stamp itself fails, skip
  // the DM so a database problem cannot turn into a DM every five minutes.
  await dbArg.clockEntry.update(entry.id, { remindedAt: now })
  try {
    const title = await titleOf(dbArg, entry.taskId ?? null)
    const user = await client.users.fetch(entry.discordId)
    await user.send(reminderMessage(entry, title, now))
  } catch (e) {
    console.error(`[clockWatch] reminder DM to ${entry.discordId}:`, errText(e))
  }
}

async function stop(client, dbArg, entry, cfg, capMin) {
  // Re-read: a pass snapshots every open entry via findOpen() up front, then
  // can take tens of seconds (up to 500 entries, with DM sends) to reach this
  // one. A real /clock-out, or a /clock-in on a different task (which also
  // closes this entry), can land in between. Closing unconditionally here
  // would silently overwrite that real clock-out with a fabricated cap
  // duration and then strip the role from someone already clocked into
  // something else.
  const fresh = await dbArg.clockEntry.findById(entry.id)
  if (!fresh || fresh.clockOutAt) return // closed under us since the pass snapshot; leave the real clock-out alone

  // Closed AT the cap, not at now: a bot that was down for a day must not log a day.
  const at = new Date(new Date(entry.clockInAt).getTime() + capMin * 60000)
  await closeEntry(dbArg, entry, { at, source: 'auto_stopped' })
  await removeClockedInRole(client, cfg, entry.discordId)
  try {
    const title = await titleOf(dbArg, entry.taskId ?? null)
    const on = title === null ? '' : ` on **${title}**`
    const user = await client.users.fetch(entry.discordId)
    await user.send({
      content: `Your timer${on} was stopped automatically after ${formatDuration(capMin)}. If that is wrong, fix it with **/log-time**.`,
    })
  } catch (e) {
    console.error(`[clockWatch] stop DM to ${entry.discordId}:`, errText(e))
  }
}

/**
 * One pass over every open timer. Returns counts, or { skipped: true } when a
 * pass against the same db is still running.
 */
export async function runClockWatchPass(client, { db: dbArg = db, now = new Date() } = {}) {
  if (inFlight.has(dbArg)) return { skipped: true }
  inFlight.add(dbArg)
  try {
    // findOpen ignores any guild filter, so it is called bare and grouped here.
    const open = await dbArg.clockEntry.findOpen()
    const configs = new Map() // guildConfigId -> config row (or null), read once per pass
    const result = { reminded: 0, stopped: 0, failed: 0 }

    for (const entry of open || []) {
      try {
        const key = entry.guildConfigId
        if (!configs.has(key)) configs.set(key, await dbArg.guildConfig.findById(key).catch(() => null))
        const cfg = configs.get(key)
        const limits = limitsOf(cfg)
        const state = runawayState(entry, now, limits)
        if (state === 'remind') {
          await remind(client, dbArg, entry, now)
          result.reminded += 1
        } else if (state === 'stop') {
          await stop(client, dbArg, entry, cfg, limits.capMin)
          result.stopped += 1
        }
      } catch (e) {
        result.failed += 1
        console.error(`[clockWatch] entry ${entry?.id}:`, errText(e))
      }
    }
    return result
  } finally {
    inFlight.delete(dbArg)
  }
}

export function startClockWatch(client, { db: dbArg = db, intervalMs = CLOCK_WATCH_INTERVAL_MS } = {}) {
  const tick = () => runClockWatchPass(client, { db: dbArg }).catch((e) => {
    console.error('[clockWatch] pass failed:', errText(e))
  })
  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return timer
}

// ---- the reminder's buttons ------------------------------------------------

// index.js auto-defers unknown buttons, so the message is edited in place.
const respond = (interaction, payload) =>
  (interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.update(payload))

/** clk_keep:<id> / clk_stop:<id>, pressed in a DM (interaction.guild is null). */
export async function handleClockButton(interaction, { db: dbArg = db } = {}) {
  const [action, ...rest] = String(interaction.customId || '').split(':')
  const entryId = rest.join(':')
  const say = (content) => respond(interaction, { content, components: [] })

  const entry = entryId ? await dbArg.clockEntry.findById(entryId) : null
  if (!entry) return say('That timer was not found.')
  if (entry.discordId !== interaction.user.id) return say('That timer is not yours.')
  if (entry.clockOutAt) return say('That timer is already stopped.')

  if (action === 'clk_keep') return say('👍 Still running.')
  if (action !== 'clk_stop') return say('Unknown action.')

  const minutes = await closeEntry(dbArg, entry, { at: new Date() })
  const cfg = await dbArg.guildConfig.findById(entry.guildConfigId).catch(() => null)
  await removeClockedInRole(interaction.client, cfg, entry.discordId)
  return say(`Stopped. Session: **${formatDuration(minutes)}**.`)
}
