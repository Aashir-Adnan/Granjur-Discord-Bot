// The channel follows the status — not into another category, but across the
// archive divider inside the project's own. One `setPositions` puts it at the
// bottom of the live group or the bottom of the archived group, then the Done
// transition runs: read-only and stamped on the way in, writable and unstamped
// on the way out. Called from applyTaskUpdate, so the slash command, the task
// hub and the site's board all behave the same.
import { ChannelType } from 'discord.js'
import db from '../db/index.js'
import { archiveDividerIdOf, isFinished } from '../utils/ticketArchive.js'
import { applyOrder, desiredOrder, textChannelsOf } from '../utils/channelOrder.js'
import { isTicketChannel } from '../utils/taskChannelName.js'
import { retireTicketChannel, reviveTicketChannel } from './ticketRetire.js'

/**
 * Retire on becoming finished, revive on becoming live — regardless of whether
 * the channel could be resolved or reordered. `retireTicketChannel` and
 * `reviveTicketChannel` both accept `channel: null` and still write the stamp,
 * which is what lets a task whose channel Discord doesn't have cached still get
 * locked and retired.
 */
async function runDoneTransition({ to, channel, task, dbArg, now, retire, revive }) {
  try {
    if (to) await retire({ channel, task, db: dbArg, now })
    else await revive({ channel, task, db: dbArg })
  } catch (e) {
    console.warn(`[ticketArchive] ${to ? 'retire' : 'revive'} ${task.id}:`, e?.message || e)
  }
}

/**
 * Put a ticket channel on the right side of its project's archive divider.
 *
 * @returns {Promise<{moved: boolean, archived: boolean|null, reason: string|null}>}
 *   `reason` is why the channel was NOT reordered (null when it was), and
 *   `archived` is which side of the line the status puts it on. The Done
 *   transition runs whenever the status crosses that line and the task has a
 *   channel — whether or not a reorder was possible — so a project-less ticket
 *   finished with /close-feature is still locked and retired.
 */
export async function placeTicketForStatus({
  guild, task, before = task, updates = {}, db: dbArg = db, now = () => new Date(),
  retire = retireTicketChannel, revive = reviveTicketChannel,
}) {
  const channelId = task?.discordChannelId
  if (!channelId) return { moved: false, archived: null, reason: 'no-channel' }
  if (updates?.status === undefined || updates.status === null) return { moved: false, archived: null, reason: 'no-status' }
  const from = isFinished(before?.status)
  const to = isFinished(updates.status)
  // A status change inside one zone (open → in_progress, done → closed) moves
  // nothing and locks nothing: only crossing the line means anything here.
  if (from === to) return { moved: false, archived: to, reason: 'same-zone' }

  const channel = guild?.channels?.cache?.get?.(channelId) ?? null
  if (!channel) {
    // The task still crosses the line even though its channel isn't resolvable
    // right now — no project read, no reorder, but the stamp still lands (or
    // clears) so a channel that reappears later is honored.
    await runDoneTransition({ to, channel: null, task, dbArg, now, retire, revive })
    return { moved: false, archived: to, reason: 'no-channel' }
  }

  // A row naming a channel is not proof the task owns it. `meetingPipelineStages`
  // writes the meeting's REVIEW channel id onto every task a meeting produced,
  // and only an assigned one ever gets a ticket of its own — so finishing an
  // unassigned meeting task would otherwise drag the shared review channel below
  // the line, lock it, stamp it, and let the sweep delete it. The same
  // `isTicketChannel` gate every other consumer uses (`ownsChannel`, the section
  // observer) applies here: no reorder, and no Done transition either.
  if (!isTicketChannel(channel)) {
    console.warn(`[ticketArchive] ${channelId} is not a ticket channel; task ${task?.id} does not own it, nothing touched.`)
    return { moved: false, archived: to, reason: 'not-ticket' }
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
      console.warn('[ticketArchive] project read:', e?.message || e)
      reason = 'error'
    }
    if (!reason) {
      const dividerId = archiveDividerIdOf(project)
      const divider = dividerId ? guild.channels.cache.get(dividerId) ?? null : null
      // The divider only means anything for the category the channel is in:
      // ordering against a line that lives somewhere else would tip the ticket
      // out of its own category.
      if (!divider || divider.type !== ChannelType.GuildText || divider.parentId !== channel.parentId) {
        reason = 'no-divider'
        console.warn(`[ticketArchive] project "${project?.name}" has no archive divider here; run /project-setup to create it.`)
      } else {
        try {
          const current = textChannelsOf(guild, channel.parentId)
          const dividerIndex = current.findIndex((c) => c.id === divider.id)
          const ticketIds = new Set(current.filter((c) => isTicketChannel(c)).map((c) => c.id))
          // Which side each OTHER ticket is on is read off the line itself:
          // the statuses of other tasks are not this call's business, and the
          // order already on screen is the truth the operator sees.
          const archivedIds = new Set(
            current.filter((c, i) => i > dividerIndex && ticketIds.has(c.id)).map((c) => c.id)
          )
          if (to) archivedIds.add(channel.id)
          else archivedIds.delete(channel.id)
          // Last in the input is last in its group, so the channel lands at the
          // BOTTOM of the side it just joined rather than wherever it used to sit.
          const moving = [...current.filter((c) => c.id !== channel.id), channel]
          const order = desiredOrder(moving, { dividerId: divider.id, archivedIds, ticketIds })
          const { changed } = await applyOrder(guild, current, order)
          moved = changed
          if (!changed) reason = 'already-there'
        } catch (e) {
          reason = 'error'
          console.warn(`[ticketArchive] reorder ${channel.parentId}:`, e?.message || e)
        }
      }
    }
  }

  await runDoneTransition({ to, channel, task, dbArg, now, retire, revive })
  return { moved, archived: to, reason }
}
