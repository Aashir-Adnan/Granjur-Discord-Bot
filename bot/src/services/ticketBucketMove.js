// The channel follows the status. One parent-only edit into the bucket for the
// new status, then the Done transition: read-only and stamped on the way in,
// writable and unstamped on the way out. Called from applyTaskUpdate, so the
// slash command, the task hub and the site's board all behave the same.
import { ChannelType } from 'discord.js'
import db from '../db/index.js'
import { CATEGORY_SOFT_CAP } from '../constants.js'
import { bucketFor, bucketIdsOf, isDoneBucket } from '../utils/statusBuckets.js'
import { retireTicketChannel, reviveTicketChannel } from './ticketRetire.js'

const valuesOf = (cache) => (cache?.values ? [...cache.values()] : [])
const countIn = (guild, id) => valuesOf(guild?.channels?.cache).filter((c) => c?.parentId === id).length

/**
 * Retire on entering Done, revive on leaving it — regardless of whether the
 * channel could be resolved live. `retireTicketChannel`/`reviveTicketChannel`
 * both accept `channel: null` and still write the stamp, which is what lets a
 * task whose channel Discord doesn't have cached still get locked and retired.
 */
async function runDoneTransition({ to, from, channel, task, dbArg, now, retire, revive }) {
  try {
    if (isDoneBucket(to)) await retire({ channel, task, db: dbArg, now })
    else if (isDoneBucket(from)) await revive({ channel, task, db: dbArg })
  } catch (e) {
    console.warn(`[ticketBucketMove] ${isDoneBucket(to) ? 'retire' : 'revive'} ${task.id}:`, e?.message || e)
  }
}

/**
 * @returns {Promise<{moved: boolean, bucket: string|null, reason: string|null}>}
 *   `reason` is why the channel was NOT moved (null when it was). The Done
 *   transition runs whenever the status crosses that boundary and the task has
 *   a channel — whether or not a move was possible — so a project-less ticket
 *   finished with /close-feature is still locked and retired.
 */
export async function moveTicketToBucket({
  guild, task, before = task, updates = {}, db: dbArg = db, now = () => new Date(),
  retire = retireTicketChannel, revive = reviveTicketChannel,
}) {
  const channelId = task?.discordChannelId
  if (!channelId) return { moved: false, bucket: null, reason: 'no-channel' }
  if (updates?.status === undefined || updates.status === null) return { moved: false, bucket: null, reason: 'no-status' }
  const from = bucketFor(before?.status)
  const to = bucketFor(updates.status)
  if (from === to) return { moved: false, bucket: to, reason: 'same-bucket' }

  const channel = guild?.channels?.cache?.get?.(channelId) ?? null
  if (!channel) {
    // The task still crosses the Done boundary even though its channel isn't
    // resolvable right now — no project read, no move attempt, but the stamp
    // still lands (or clears) so a channel that reappears later is honored.
    await runDoneTransition({ to, from, channel: null, task, dbArg, now, retire, revive })
    return { moved: false, bucket: to, reason: 'no-channel' }
  }

  let moved = false
  let reason = null
  if (!task?.projectId) {
    reason = 'no-project'
  } else {
    let project = null
    try {
      project = await dbArg.project.findFirst({ where: { id: task.projectId } })
    } catch (e) {
      console.warn('[ticketBucketMove] project read:', e?.message || e)
      reason = 'error'
    }
    if (!reason) {
      const targetId = bucketIdsOf(project)[to]
      const target = targetId ? guild.channels.cache.get(targetId) ?? null : null
      if (!target || target.type !== ChannelType.GuildCategory) {
        reason = 'no-bucket'
        console.warn(`[ticketBucketMove] project "${project?.name}" has no ${to} bucket; run /project-setup to create it.`)
      } else if (channel.parentId === target.id) {
        reason = 'already-there'
      } else if (countIn(guild, target.id) >= CATEGORY_SOFT_CAP) {
        reason = 'full'
        console.warn(`[ticketBucketMove] project "${project?.name}"'s ${to} bucket is at Discord's cap (${CATEGORY_SOFT_CAP}); ${channel.name ?? channelId} stays where it is.`)
      } else {
        try {
          await channel.edit({ parent: target.id })
          moved = true
        } catch (e) {
          reason = 'error'
          console.warn(`[ticketBucketMove] move ${channelId}:`, e?.message || e)
        }
      }
    }
  }

  await runDoneTransition({ to, from, channel, task, dbArg, now, retire, revive })
  return { moved, bucket: to, reason }
}
