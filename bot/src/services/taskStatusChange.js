// One place where a task's fields get written and the consequences run.
//
// /update-task and the site's status route must behave identically — same
// blocker warning, same channel post, same DMs, same unblock notices — so they
// both go through here rather than each keeping its own copy of the sequence.

import db from '../db/index.js'
import { notifyTaskUpdate } from './taskUpdateNotify.js'
import { blockerWarning, openBlockers } from '../utils/taskDeps.js'
import { activityChanges, recordTaskActivity } from './taskActivity.js'

/** Discord embed fields cap at 1024; the reply description has room for more. */
export const WARNING_MAX = 1500

/**
 * Write `updates` to `task` and run the consequences: blocker warning, channel
 * post, DMs, unblock notices. Shared by /update-task and the site's status route.
 * The write is what matters; everything after it is best-effort.
 *
 * `actor.discordId` mentions the person; `actor.label` names them when the
 * change did not come from Discord. Pass `guild` when the caller already has
 * it — otherwise the guild is looked up from the task's config.
 *
 * @returns {Promise<{ warning: string, notified: { channelId: string|null, created: boolean, dmed: string[] } }>}
 */
export async function applyTaskUpdate({ db: dbArg = db, client, task, updates, actor = {}, notify = notifyTaskUpdate, guild = null, record = recordTaskActivity }) {
  await dbArg.task.update({ where: { id: task.id }, data: updates })

  // Who did what. `actor.activityId` is the Discord member a site user was
  // matched to; it is separate from `discordId` because that one makes the
  // channel post @mention the person, which a site edit deliberately does not.
  await record({
    db: dbArg,
    task,
    changes: activityChanges(task, updates),
    actor: { discordId: actor.discordId ?? actor.activityId ?? null, label: actor.label ?? null },
  })

  let warning = ''
  if (updates.status && updates.status !== task.status && updates.status !== 'open' && updates.status !== 'pending') {
    // The write already succeeded; a failure here must not look like a failed update.
    try {
      const rows = await dbArg.taskDependency.findByTask({ where: { taskId: task.id } })
      const blockers = rows.length
        ? await dbArg.task.findByIds({ where: { guildConfigId: task.guildConfigId, ids: rows.map((r) => r.blockedByTaskId) } })
        : []
      const byId = Object.fromEntries(blockers.map((b) => [b.id, b]))
      warning = blockerWarning(openBlockers(task.id, rows, byId))
      if (warning.length > WARNING_MAX) warning = `${warning.slice(0, WARNING_MAX - 1)}…`
    } catch (e) {
      console.error('[taskStatusChange] blocker warning:', e?.message ?? e)
      warning = ''
    }
  }

  let notified = { channelId: task.discordChannelId || null, created: false, dmed: [] }
  try {
    let g = guild
    if (!g) {
      const cfg = await dbArg.guildConfig.findById(task.guildConfigId)
      g = cfg ? client?.guilds?.cache?.get(cfg.guildId) ?? null : null
    }
    notified = await notify({
      client,
      guild: g,
      task,
      before: task,
      updates,
      actorId: actor.discordId ?? null,
      actorLabel: actor.label ?? null,
      warning,
      db: dbArg,
    })
  } catch (e) {
    console.error('[taskStatusChange] notify:', e?.message ?? e)
  }

  // `notifyTaskUpdate` opens the task's channel when an assignment finds it
  // without one. Leaving the row pointing at the old channel — or at nothing —
  // is what turns one stray channel into a new one on every later update: the
  // next run looks the row up, does not find the channel it just made, and
  // makes another. Best-effort, like everything after the write.
  if (notified?.created && notified.channelId && notified.channelId !== task.discordChannelId) {
    try {
      await dbArg.task.update({ where: { id: task.id }, data: { discordChannelId: notified.channelId } })
    } catch (e) {
      console.error('[taskStatusChange] channel id write-back:', e?.message ?? e)
    }
  }

  return { warning, notified }
}
