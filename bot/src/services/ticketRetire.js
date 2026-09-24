// A finished ticket's channel: read-only the moment the task enters its
// project's Done bucket, deleted fourteen days later. The deadline lives on
// the task row (`channelRetireAt`), not in a timer, so a restart forgets
// nothing — the old five-minute `setTimeout` in /close-feature did.
import db from '../db/index.js'
import { lockTicketChannel, unlockTicketChannel } from '../utils/channels.js'

export const RETIRE_AFTER_MS = 14 * 24 * 60 * 60 * 1000
const TICK_MS = 60 * 60 * 1000

/**
 * Lock the channel (best-effort) and stamp the row. The stamp is written even
 * when the lock fails: a channel nobody could lock still must not outlive its
 * fortnight.
 * @returns {Promise<{retireAt: Date, locked: {edited: number, failed: number}}>}
 */
export async function retireTicketChannel({ channel, task, db: dbArg = db, now = () => new Date() }) {
  let locked = { edited: 0, failed: 0 }
  if (channel) {
    try {
      locked = await lockTicketChannel(channel)
    } catch (e) {
      locked = { edited: 0, failed: 1 }
      console.warn(`[ticketRetire] lock ${channel?.id}:`, e?.message || e)
    }
  }
  const retireAt = new Date(now().getTime() + RETIRE_AFTER_MS)
  await dbArg.task.update({ where: { id: task.id }, data: { channelRetireAt: retireAt } })
  return { retireAt, locked }
}

/** A task reopened out of Done: writable again, stamp cleared. */
export async function reviveTicketChannel({ channel, task, db: dbArg = db }) {
  let unlocked = { edited: 0, failed: 0 }
  if (channel) {
    try {
      unlocked = await unlockTicketChannel(channel)
    } catch (e) {
      unlocked = { edited: 0, failed: 1 }
      console.warn(`[ticketRetire] unlock ${channel?.id}:`, e?.message || e)
    }
  }
  await dbArg.task.update({ where: { id: task.id }, data: { channelRetireAt: null } })
  return { unlocked }
}

/** The channel by id from the cache, else fetched; null when Discord says it is gone (10003). */
async function channelOf(client, id) {
  const cached = client?.channels?.cache?.get?.(id)
  if (cached) return cached
  try {
    return (await client?.channels?.fetch?.(id)) ?? null
  } catch (e) {
    if (e?.code === 10003) return null
    throw e
  }
}

/**
 * Delete every channel whose stamp has passed and clear both columns on its
 * row. A row whose delete threw keeps its stamp and is retried next tick; a
 * channel Discord already deleted counts as deleted.
 * @returns {Promise<{deleted: number, failed: number}>}
 */
export async function sweepRetiredTickets({ client, db: dbArg = db, now = () => new Date(), take = 100 }) {
  const out = { deleted: 0, failed: 0 }
  let rows = []
  try {
    rows = (await dbArg.task.findRetirable({ where: { before: now() }, take })) ?? []
  } catch (e) {
    console.warn('[ticketRetire] read:', e?.message || e)
    return out
  }
  for (const task of rows) {
    try {
      const channel = await channelOf(client, task.discordChannelId)
      if (channel) await channel.delete('Finished ticket past its 14-day retention')
      await dbArg.task.update({ where: { id: task.id }, data: { discordChannelId: null, channelRetireAt: null } })
      out.deleted += 1
    } catch (e) {
      out.failed += 1
      console.warn(`[ticketRetire] task ${task.id} channel ${task.discordChannelId}:`, e?.message || e)
    }
  }
  return out
}

/** Hourly. Runs once at start so a bot restarted after a long outage catches up. */
export function startTicketRetireSweep(client, { db: dbArg = db, intervalMs = TICK_MS } = {}) {
  const tick = () => sweepRetiredTickets({ client, db: dbArg }).catch((e) => console.warn('[ticketRetire] sweep:', e?.message || e))
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  tick()
  return timer
}
