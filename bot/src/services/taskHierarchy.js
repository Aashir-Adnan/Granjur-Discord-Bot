// Applying the task-hierarchy rules (utils/taskHierarchy.js) against the
// database. Called from the one place every task edit passes through,
// taskStatusChange.applyTaskUpdate, so /update-task, the task hub and the site's
// board drag all obey the same rules.

import db from '../db/index.js'
import {
  AUTO_LABEL, MAX_SUBTASKS, TaskRuleError, finishBlockMessage, isFinished, parentNextStatus,
} from '../utils/taskHierarchy.js'
import { recordTaskActivity } from './taskActivity.js'

/**
 * Throw a TaskRuleError if `updates` would finish `task` while a subtask is
 * still open. Reads the subtasks only when a finishing move is actually being
 * made. Called before anything is written.
 */
export async function assertCanFinish({ db: dbArg = db, task, updates }) {
  if (!updates?.status || !isFinished(updates.status) || isFinished(task.status)) return
  const children = await dbArg.task.findChildren({ where: { parentTaskId: task.id } })
  const message = finishBlockMessage(task, children, updates.status)
  if (message) throw new TaskRuleError(message)
}

/**
 * After `task` changed status (or gained a sibling), bring its parent in line:
 * done once every subtask is finished, back to in progress if one is open again.
 * `apply` is applyTaskUpdate, passed in so this module does not import the
 * module that imports it. Best-effort: the change that triggered it has already
 * been saved.
 *
 * @returns {Promise<string|null>} the parent's new status, or null when unchanged
 */
export async function syncParent({ db: dbArg = db, client, guild, parentId, apply, notify }) {
  if (!parentId) return null
  try {
    const parent = await dbArg.task.findFirst({ where: { id: parentId } })
    if (!parent) return null
    const children = await dbArg.task.findChildren({ where: { parentTaskId: parent.id } })
    const next = parentNextStatus(parent, children)
    if (!next) return null
    await apply({
      db: dbArg, client, guild, task: parent, updates: { status: next }, actor: { label: AUTO_LABEL[next] }, notify,
    })
    return next
  } catch (e) {
    console.error('[taskHierarchy] syncParent:', e?.message ?? e)
    return null
  }
}

/**
 * Add a subtask under `parent`. A subtask is an ordinary task row (a feature,
 * with assignees) pointing at its parent; it gets NO Discord channel of its
 * own — its notifications go to the parent's channel — and inherits the
 * parent's project and repository. Refuses (TaskRuleError) when the parent is
 * itself a subtask or already holds MAX_SUBTASKS. A finished parent reopens.
 *
 * @returns {Promise<object>} the new task row
 */
export async function createSubtask({
  db: dbArg = db, client, guild, parent, fields, actor = {}, notify, apply,
}) {
  if (parent.parentTaskId) throw new TaskRuleError('A subtask cannot have subtasks of its own — add it to the parent task instead.')
  const title = String(fields?.title ?? '').trim()
  if (!title) throw new TaskRuleError('A subtask needs a title.')
  const existing = await dbArg.task.findChildren({ where: { parentTaskId: parent.id } })
  if (existing.length >= MAX_SUBTASKS) throw new TaskRuleError(`A task can have at most ${MAX_SUBTASKS} subtasks.`)

  const assigneeIds = [...new Set((fields?.assigneeIds || []).map(String).filter(Boolean))]
  const child = await dbArg.task.create({
    data: {
      guildConfigId: parent.guildConfigId,
      type: 'feature',
      is_feature: 1,
      title: title.slice(0, 200),
      description: fields?.description ? String(fields.description).slice(0, 2000) : null,
      status: 'open',
      createdBy: actor.discordId ?? null,
      assigneeIds,
      scope: fields?.scope || null,
      repositoryId: parent.repositoryId ?? null,
      projectId: parent.projectId ?? null,
      projectName: parent.projectName ?? null,
      parentTaskId: parent.id,
    },
  })

  await recordTaskActivity({
    db: dbArg, task: parent, changes: [{ field: 'subtask', action: 'added', title: child.title }], actor,
  })

  // Tell the parent's channel, and DM whoever was assigned. Best-effort.
  try {
    await notify({
      client,
      guild,
      task: child,
      before: { ...child, assigneeIds: [] },
      updates: { assigneeIds },
      actorId: actor.discordId ?? null,
      actorLabel: actor.label ?? null,
      extraLines: ['**subtask added**'],
      db: dbArg,
    })
  } catch (e) {
    console.error('[taskHierarchy] subtask notify:', e?.message ?? e)
  }

  // A new open subtask under a finished parent reopens it.
  await syncParent({ db: dbArg, client, guild, parentId: parent.id, apply, notify })
  return child
}
