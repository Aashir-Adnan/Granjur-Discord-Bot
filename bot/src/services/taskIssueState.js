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

/**
 * The repository and number an issue URL names
 * (`https://github.com/{owner}/{repo}/issues/{n}`), or null when it names none.
 * @returns {{ repoUrl: string, number: number } | null}
 */
export function issueFromUrl(url) {
  const m = String(url || '').trim().match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?(?:[?#].*)?$/i)
  if (!m) return null
  return { repoUrl: `https://github.com/${m[1]}/${m[2]}`, number: Number(m[3]) }
}

/**
 * Where a task's issue lives. Its own URL first — the issue may have been
 * opened (by CSAAS, or before a relink) in a repository other than the one
 * `repositoryId` names today. Only without a parsable URL: the row's
 * repository + `externalIssueNumber`.
 * @returns {Promise<{ none: true } | { unknown: true } | { repoUrl: string, number: number }>}
 */
async function issueTarget(dbArg, task) {
  const fromUrl = issueFromUrl(task?.externalIssueUrl)
  if (fromUrl) return fromUrl
  const number = Number(task?.externalIssueNumber) || null
  if (!number) return task?.externalIssueUrl ? { unknown: true } : { none: true }
  if (!task.repositoryId) return { unknown: true }
  try {
    const repo = await dbArg.repository.findFirst({ where: { id: task.repositoryId, guildConfigId: task.guildConfigId } })
    return repo?.url ? { repoUrl: repo.url, number } : { unknown: true }
  } catch (e) {
    console.error('[taskIssueState] repository lookup:', e?.message ?? e)
    return { unknown: true }
  }
}

/**
 * Close or reopen a task's GitHub issue to match a status update. A no-op
 * (`{ line: null }`, no GitHub call) unless the status is actually changing,
 * the transition calls for a GitHub change, and the task has an issue. When
 * the issue's repository cannot be worked out, says so in the line rather
 * than doing nothing silently. Never throws.
 * @returns {Promise<{ line: string|null }>}
 */
export async function syncIssueState({ db: dbArg = db, task, updates, setState = setIssueState }) {
  if (updates.status === undefined || updates.status === task.status) return { line: null }
  const transition = issueTransition(task.status, updates.status)
  if (!transition) return { line: null }
  const verb = transition.state === 'closed' ? 'not closed' : 'not reopened'
  const target = await issueTarget(dbArg, task)
  if (target.none) return { line: null }
  if (target.unknown) return { line: `GitHub issue ${verb} — the issue's repository is unknown` }
  try {
    await setState(target.repoUrl, target.number, transition)
    return { line: null }
  } catch (e) {
    return { line: `GitHub issue ${verb} — ${e?.message ?? e}` }
  }
}
