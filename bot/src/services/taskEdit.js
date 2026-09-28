// The one interaction-free path that writes an edit to a task: the subtask rule,
// then the blocker adds and removes, then the field write with everything that
// follows it (activity row, archive placement, channel post, DMs, parent sync).
// /update-task, the task hub and the site's update route all go through here, so
// a change looks the same in Discord whoever made it and from wherever.

import db from '../db/index.js'
import { applyTaskUpdate } from './taskStatusChange.js'
import { notifyTaskUpdate } from './taskUpdateNotify.js'
import { assertCanFinish } from './taskHierarchy.js'
import { recordTaskActivity } from './taskActivity.js'
import { TaskRuleError } from '../utils/taskHierarchy.js'
import { wouldCycle } from '../utils/taskDeps.js'

/**
 * Record / remove one dependency for `task`. Validates before writing, so a
 * refused change leaves the table untouched.
 * @returns {{ lines: string[], error: string|null }}
 */
export async function applyDependencyChange({ db: dbArg, cfg, task, blockedById = null, unblockId = null, actorId = null, actorLabel = null, record = recordTaskActivity }) {
  const lines = []
  if (blockedById) {
    if (String(blockedById) === String(task.id)) return { lines, error: 'A task cannot be blocked by itself.' }
    const [blocker] = await dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids: [blockedById] } })
    if (!blocker) return { lines, error: `No task matches **${String(blockedById).slice(0, 80)}**. Start typing a title and pick one from the list.` }
    const deps = await dbArg.taskDependency.findManyForGuild({ where: { guildConfigId: cfg.id } })
    if (wouldCycle(task.id, blocker.id, deps)) {
      const b = blocker.title || blocker.id
      const t = task.title || task.id
      return { lines, error: `**${b}** already depends on **${t}**, so **${t}** cannot be blocked by **${b}**.` }
    }
    await dbArg.taskDependency.add({ data: { guildConfigId: cfg.id, taskId: task.id, blockedByTaskId: blocker.id, createdBy: actorId } })
    lines.push(`**Blocked by:** ${blocker.title || blocker.id}`)
    await record({ db: dbArg, task, changes: [{ field: 'blocked_by', action: 'added', title: blocker.title || blocker.id }], actor: { discordId: actorId, label: actorLabel } })
  }
  if (unblockId) {
    const [blocker] = await dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids: [unblockId] } })
    const { removed } = await dbArg.taskDependency.remove({ where: { taskId: task.id, blockedByTaskId: String(unblockId) } })
    const name = blocker?.title || unblockId
    lines.push(removed > 0 ? `**Unblocked:** ${name}` : `**Unblock:** ${name} was not blocking this task`)
    if (removed > 0) await record({ db: dbArg, task, changes: [{ field: 'blocked_by', action: 'removed', title: name }], actor: { discordId: actorId, label: actorLabel } })
  }
  return { lines, error: null }
}

/**
 * Moving a task between projects moves the ROW, not the channel: nothing here
 * re-parents it, and the overwrite merge that repairs task channels keeps the
 * old project role's allow, so the old project's members go on seeing a task
 * that is no longer theirs until the section is rebuilt. Saying so is the whole
 * fix — a silent half-move is the thing to avoid. Null when the project did not
 * change. Pure.
 */
export function projectMoveNote(task, updates) {
  if (!('projectId' in updates) || updates.projectId === (task.projectId ?? null)) return null
  return `This task now belongs to ${updates.projectName ? `**${updates.projectName}**` : 'no project'}, but its channel has not moved and still lets the previous project's role see it. Run **/project-setup** — pick the project from the **project:** option's suggestions — to move the channel into the right section.`
}

/**
 * Apply an already-validated edit. Every refusal returns `{ error }` before the
 * task row is written: the subtask rule first, then each blocker change. The
 * blocker checks here are the last line of defence (the site route validates the
 * whole list before calling); a Discord caller passes at most one of each.
 *
 * `actor` is `{ discordId }` from Discord (the channel post @mentions them) or
 * `{ activityId, label }` from the site (named, never mentioned).
 */
export async function applyEdit({
  db: dbArg = db, client, guild = null, cfg, task, updates = {}, blockers = {}, actor = {},
  notify = notifyTaskUpdate, apply = applyTaskUpdate,
}) {
  let notified = { channelId: task.discordChannelId || null, created: false, dmed: [] }
  const lines = []
  try {
    await assertCanFinish({ db: dbArg, task, updates })
  } catch (e) {
    if (e instanceof TaskRuleError) return { error: e.message, dep: { lines }, warning: '', notified }
    throw e
  }
  const actorId = actor.discordId ?? actor.activityId ?? null
  const actorLabel = actor.label ?? null
  for (const blockedById of blockers.add || []) {
    const dep = await applyDependencyChange({ db: dbArg, cfg, task, blockedById, actorId, actorLabel })
    if (dep.error) return { error: dep.error, dep: { lines }, warning: '', notified }
    lines.push(...dep.lines)
  }
  for (const unblockId of blockers.remove || []) {
    const dep = await applyDependencyChange({ db: dbArg, cfg, task, unblockId, actorId, actorLabel })
    lines.push(...dep.lines)
  }
  let warning = ''
  if (Object.keys(updates).length > 0) {
    ;({ warning, notified } = await apply({ db: dbArg, client, guild, task, updates, actor, notify }))
  }
  return { error: null, dep: { lines }, warning: warning || '', notified }
}
