// What happens when a task changes.
//
// Two kinds of change, deliberately treated differently:
//
//   * Being assigned a task, or having one closed under you, is an EVENT — it
//     changes what you are expected to do, so it gets a DM and, for an
//     assignment, access to the task's channel.
//   * Every other edit (a QA count, a title, an implementation status) is a
//     detail. It gets posted into the task's own channel, where the people on
//     the task already are. DMing those trains people to mute the bot, and the
//     assignment DM is then lost along with the noise.

import { holdersOf, idList } from '../utils/taskLabel.js'
import { createTaskTicketChannel, dmTaskAssignees } from './taskTicketChannel.js'
import { openBlockers, TERMINAL_STATUSES, unblockNotice } from '../utils/taskDeps.js'
import db from '../db/index.js'

export { TERMINAL_STATUSES }

const FIELD_LABELS = {
  status: 'status',
  title: 'title',
  description: 'description',
  implementationStatus: 'implementation',
  passedApiTests: 'API tests passed',
  passedQaTests: 'QA tests passed',
  passedAcceptanceCriteria: 'acceptance criteria passed',
}

/** Who gained and who lost the task. Pure. */
export function assigneeDiff(before, after) {
  const b = new Set(idList(before))
  const a = new Set(idList(after))
  return {
    added: [...a].filter((id) => !b.has(id)),
    removed: [...b].filter((id) => !a.has(id)),
  }
}

/**
 * One line per changed field, for the task channel. Pure.
 * `assigneeIds` is excluded — assignment is reported as its own event.
 */
export function changeSummary(before, updates) {
  const lines = []
  for (const [key, next] of Object.entries(updates || {})) {
    if (key === 'assigneeIds') continue
    const label = FIELD_LABELS[key]
    if (!label) continue
    const prev = before?.[key]
    if (String(prev ?? '') === String(next ?? '')) continue
    // A description or title diff is unreadable inline; say it changed.
    if (key === 'description' || key === 'title') {
      lines.push(`**${label}** updated`)
      continue
    }
    lines.push(`**${label}**: \`${prev ?? '—'}\` → \`${next ?? '—'}\``)
  }
  return lines
}

const MEMBER_ALLOW = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }

/**
 * Whether a channel is THIS task's ticket channel rather than somewhere the
 * task merely got announced. createTaskTicketChannel names it
 * `<prefix>-<last six characters of the task id>`. Pure.
 */
export function ownsChannel(taskId, channelName) {
  const suffix = String(taskId ?? '').slice(-6)
  if (!suffix) return false
  return /^(feature|bug)-/.test(String(channelName ?? '')) && String(channelName).endsWith(`-${suffix}`)
}

/**
 * When `blockerTask` reaches a terminal status, what to tell each task it was
 * holding. Only tasks with a channel of their own get a notice — nowhere else
 * to post it. Pure aside from the db reads.
 */
export async function unblockNotices({ db: dbArg = db, guildConfigId, blockerTask }) {
  const holding = await dbArg.taskDependency.findByBlocker({ where: { blockedByTaskId: blockerTask.id } })
  if (!holding.length) return []
  const blocked = await dbArg.task.findByIds({ where: { guildConfigId, ids: holding.map((r) => r.taskId) } })
  const out = []
  for (const t of blocked) {
    if (!t.discordChannelId) continue
    const rows = await dbArg.taskDependency.findByTask({ where: { taskId: t.id } })
    const others = await dbArg.task.findByIds({ where: { guildConfigId, ids: rows.map((r) => r.blockedByTaskId) } })
    const byId = Object.fromEntries(others.map((o) => [o.id, o]))
    // The blocker is terminal now; count what else is still holding this task.
    const remaining = openBlockers(t.id, rows, byId).filter((o) => o.id !== blockerTask.id).length
    out.push({ channelId: t.discordChannelId, text: unblockNotice(blockerTask, remaining) })
  }
  return out
}

/**
 * Apply the consequences of an update. Every step is best-effort: a task must
 * stay updated even when Discord refuses a DM or a permission edit.
 *
 * @returns {Promise<{channelId: string|null, dmed: string[], created: boolean}>}
 */
export async function notifyTaskUpdate({ client, guild, task, before, updates, actorId, actorLabel = null, warning = '', db: dbArg = db }) {
  const out = { channelId: task?.discordChannelId || null, dmed: [], created: false }
  if (!guild || !task) return out

  const { added, removed } = Object.prototype.hasOwnProperty.call(updates || {}, 'assigneeIds')
    ? assigneeDiff(before?.assigneeIds, updates.assigneeIds)
    : { added: [], removed: [] }

  const holders = holdersOf({ ...task, ...updates })

  // Resolve the task's OWN channel. An unassigned meeting task carries the
  // review channel's id in discordChannelId — that channel belongs to the
  // meeting and holds everyone's review, so granting a new assignee access to
  // it, or posting task edits into it, would be wrong. A task's own channel is
  // the one named for the task (`feature-<last six of the id>`); anything else
  // is somewhere the task merely got mentioned.
  let channel = null
  if (task.discordChannelId) {
    const found = await client?.channels?.fetch(task.discordChannelId).catch(() => null)
    if (found?.guild && ownsChannel(task.id, found.name)) channel = found
  }

  // An assigned task with no channel of its own gets one, exactly as
  // /create-task and the meeting mirror do.
  if (!channel && holders.length) {
    try {
      channel = await createTaskTicketChannel(guild, {
        taskId: task.id,
        title: updates?.title || task.title,
        description: updates?.description ?? task.description,
        memberIds: [...holders, actorId],
        fields: [
          { name: 'Status', value: String(updates?.status || task.status || 'open'), inline: true },
          { name: 'Assignees', value: holders.map((id) => `<@${id}>`).join(' ') || 'None', inline: true },
        ],
        closeHint: 'Use **/close-feature** in this channel when done.',
      })
      out.created = true
      out.channelId = channel.id
    } catch (e) {
      console.warn('[taskUpdate] channel creation failed:', e?.message || e)
      channel = null
    }
  }

  if (channel) {
    out.channelId = channel.id
    for (const id of added) {
      await channel.permissionOverwrites
        ?.edit?.(id, MEMBER_ALLOW)
        .catch((e) => console.warn(`[taskUpdate] grant ${id} failed:`, e?.message || e))
    }
    for (const id of removed) {
      await channel.permissionOverwrites
        ?.delete?.(id)
        .catch((e) => console.warn(`[taskUpdate] revoke ${id} failed:`, e?.message || e))
    }

    const lines = changeSummary(before, updates)
    if (added.length) lines.unshift(`**assigned to** ${added.map((id) => `<@${id}>`).join(' ')}`)
    if (removed.length) lines.push(`**unassigned** ${removed.map((id) => `<@${id}>`).join(' ')}`)
    if (warning) lines.push(warning)
    if (lines.length) {
      // No Discord id when the change came from the site; `actorLabel` then
      // names the person so the post is not anonymous.
      const who = actorId ? `<@${actorId}>` : actorLabel || 'Someone'
      await channel
        .send(`${who} updated this task:\n${lines.map((l) => `• ${l}`).join('\n')}`)
        .catch((e) => console.warn('[taskUpdate] channel post failed:', e?.message || e))
    }
  }

  // DM only the two events worth interrupting someone for.
  if (added.length) {
    await dmTaskAssignees(client, added, {
      title: updates?.title || task.title,
      channelId: out.channelId,
      note: 'Use **/update-task** to change its status.',
    })
    out.dmed.push(...added)
  }

  const nextStatus = updates?.status
  const becameTerminal =
    nextStatus &&
    TERMINAL_STATUSES.has(String(nextStatus)) &&
    !TERMINAL_STATUSES.has(String(before?.status ?? ''))
  if (becameTerminal) {
    const tell = holders.filter((id) => !added.includes(id))
    for (const id of tell) {
      try {
        const user = await client.users.fetch(id)
        await user.send(
          `**${updates?.title || task.title}** was marked \`${nextStatus}\`` +
            (out.channelId ? ` — ${`<#${out.channelId}>`}` : '') +
            '.',
        )
        out.dmed.push(id)
      } catch (e) {
        console.warn(`[taskUpdate] closure DM to ${id} failed:`, e?.message || e)
      }
    }

    // Tell every task this one was holding. The guild config id comes off the
    // task row itself — never a fresh lookup here, which would always reach
    // the real database even under test.
    const guildConfigId = task.guildConfigId
    if (!guildConfigId) {
      console.warn('[taskUpdate] unblock notices skipped: task has no guildConfigId')
    } else {
      try {
        const notices = await unblockNotices({ db: dbArg, guildConfigId, blockerTask: { ...task, ...updates } })
        for (const n of notices) {
          const ch = await client?.channels?.fetch(n.channelId).catch(() => null)
          if (ch?.isTextBased?.()) {
            await ch.send(n.text).catch((e) => console.warn('[taskUpdate] unblock notice failed:', e?.message || e))
          }
        }
      } catch (e) {
        console.warn('[taskUpdate] unblock notices:', e?.message || e)
      }
    }
  }

  return out
}
