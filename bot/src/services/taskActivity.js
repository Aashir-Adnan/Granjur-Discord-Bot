// The audit trail behind "who did what to this task".
//
// One `taskactivity` row per update, written from the shared update path
// (taskStatusChange.applyTaskUpdate) so /update-task and the site's board drag
// are both recorded, and from the dependency changes /update-task makes. It is
// best-effort by design: the update itself has already succeeded, and a failure
// to log it must never make it look like the update failed.

import db from '../db/index.js'
import { assigneeDiff } from './taskUpdateNotify.js'

// Fields whose old and new value are worth keeping (short scalars).
const SCALAR_FIELDS = {
  status: 'status',
  scope: 'scope',
  implementationStatus: 'implementationStatus',
  passedApiTests: 'passedApiTests',
  passedQaTests: 'passedQaTests',
  passedAcceptanceCriteria: 'passedAcceptanceCriteria',
  estimateMinutes: 'estimateMinutes',
}

/**
 * What an update changed, as the small JSON list stored in `changes`. Pure.
 * Only fields that really differ are listed. A title or description is recorded
 * as "changed" without its text (a description can be long and is not ours to
 * copy around); assignees list who was added and removed; a project move
 * records the project names.
 */
export function activityChanges(before, updates) {
  const out = []
  const u = updates || {}
  for (const [key, field] of Object.entries(SCALAR_FIELDS)) {
    if (u[key] === undefined) continue
    if (String(before?.[key] ?? '') === String(u[key] ?? '')) continue
    out.push({ field, from: before?.[key] ?? null, to: u[key] ?? null })
  }
  for (const key of ['title', 'description']) {
    if (u[key] === undefined) continue
    if (String(before?.[key] ?? '') === String(u[key] ?? '')) continue
    out.push({ field: key })
  }
  if (u.assigneeIds !== undefined) {
    const { added, removed } = assigneeDiff(before?.assigneeIds, u.assigneeIds)
    if (added.length || removed.length) out.push({ field: 'assignees', added, removed })
  }
  if (u.projectId !== undefined && String(before?.projectId ?? '') !== String(u.projectId ?? '')) {
    out.push({ field: 'project', from: before?.projectName ?? null, to: u.projectName ?? null })
  }
  return out
}

/**
 * Append one activity row. `actor` is `{ discordId?, label? }`. Never throws.
 * @returns {Promise<boolean>} whether a row was written
 */
export async function recordTaskActivity({ db: dbArg = db, task, changes, actor = {} }) {
  if (!task?.id || !Array.isArray(changes) || changes.length === 0) return false
  try {
    await dbArg.taskActivity.add({
      data: {
        guildConfigId: task.guildConfigId,
        taskId: task.id,
        actorDiscordId: actor.discordId ? String(actor.discordId) : null,
        actorLabel: actor.label ? String(actor.label).slice(0, 100) : null,
        changes,
      },
    })
    return true
  } catch (e) {
    console.error('[taskActivity] record:', e?.message ?? e)
    return false
  }
}
