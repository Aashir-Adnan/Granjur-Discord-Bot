// Keeping a task's GitHub issue in step with its status: closed (with the
// right reason) when the task finishes, reopened when it comes back to life.
// Called from applyTaskUpdate, /close-feature, and /resolve-bug — never
// blocks or undoes the status change; a GitHub failure is reported as a line
// for the channel, not thrown.

import db from '../db/index.js'
import { setIssueState } from './github.js'
import { isFinished } from '../utils/ticketArchive.js'

/**
 * What should happen to the issue when a task's status moves from
 * `beforeStatus` to `afterStatus`. `null` means "leave the issue alone":
 * either nothing changed, or both ends are live statuses.
 * @param {string} beforeStatus
 * @param {string} afterStatus
 * @returns {{state:'closed', reason:'completed'|'not_planned'} | {state:'open'} | null}
 */
export function issueTransition(beforeStatus, afterStatus) {
  if (beforeStatus === afterStatus) return null
  const wasFinished = isFinished(beforeStatus)
  const nowFinished = isFinished(afterStatus)
  if (!wasFinished && !nowFinished) return null
  if (nowFinished) {
    return { state: 'closed', reason: String(afterStatus).trim().toLowerCase() === 'abandoned' ? 'not_planned' : 'completed' }
  }
  return { state: 'open' }
}

/** `externalIssueNumber`, else parsed out of `externalIssueUrl` (`/issues/(\d+)`). */
function issueNumberOf(task) {
  if (task?.externalIssueNumber) return task.externalIssueNumber
  const m = String(task?.externalIssueUrl || '').match(/\/issues\/(\d+)/)
  return m ? Number(m[1]) : null
}

/**
 * Close or reopen a task's GitHub issue to match a status update. A no-op
 * (`{ line: null }`, no GitHub call) unless the status is actually changing,
 * the transition calls for a GitHub change, the task has an issue number, and
 * its repository still resolves. Never throws.
 * @returns {Promise<{ line: string|null }>}
 */
export async function syncIssueState({ db: dbArg = db, task, updates, setState = setIssueState }) {
  if (updates.status === undefined || updates.status === task.status) return { line: null }
  const transition = issueTransition(task.status, updates.status)
  if (!transition) return { line: null }
  const number = issueNumberOf(task)
  if (!number) return { line: null }
  let repo = null
  try {
    repo = await dbArg.repository.findFirst({ where: { id: task.repositoryId, guildConfigId: task.guildConfigId } })
  } catch (e) {
    console.error('[taskIssueState] repository lookup:', e?.message ?? e)
    return { line: null }
  }
  if (!repo) return { line: null }
  try {
    await setState(repo.url, number, transition)
    return { line: null }
  } catch (e) {
    const verb = transition.state === 'closed' ? 'not closed' : 'not reopened'
    return { line: `GitHub issue ${verb} — ${e?.message ?? e}` }
  }
}
