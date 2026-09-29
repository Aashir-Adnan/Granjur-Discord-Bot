// Which project a task from a meeting belongs to (roadmap sub-project 2,
// 2026-09-29). Rules, in order:
//   1. the MEETING's project (`/meeting-channel` records it on the meeting row);
//   2. the project Claude named, matched loosely against the bot's rows;
//   3. the reviewer's pick in the review message, for a task neither settles.
// Otherwise the task has no project — and no project name either: the name
// Claude heard is not kept, so it cannot show up as a stray project group.
// The repository then follows from the project and the task's scope, by the
// same rule /create-task uses (sub-project 4, 2026-09-30; taskRepo.js).

import { matchProject } from '../utils/projectMatch.js'
import { resolveTaskRepo } from './taskRepo.js'
import { meetingTaskScope } from './meetingTaskMap.js'

// Discord caps a select at 25 options; one of them is "No project".
export const REVIEW_PROJECT_LIMIT = 24

// Loads once what the rules need. Best-effort: a failed read leaves that part
// empty and the rules fall through as if it were unset.
export async function loadProjectContext(db, job) {
  const ctx = { projects: [], repos: [], links: [], meetingProjectId: null }
  try {
    const [projects, repos, links] = await Promise.all([
      db.project.findMany({ where: { guildConfigId: job.guildConfigId } }),
      db.repository.findMany({ where: { guildConfigId: job.guildConfigId } }),
      db.projectRepos.findMany({ where: {} }),
    ])
    ctx.projects = projects || []
    ctx.repos = repos || []
    ctx.links = links || []
  } catch (e) {
    console.warn('[meetingPipeline] project/repo lookup failed:', e?.message || e)
  }
  try {
    ctx.meetingProjectId = (await db.meeting.findUnique({ where: { id: job.meetingId } }))?.projectId || null
  } catch (e) {
    console.warn('[meetingPipeline] meeting project lookup failed:', e?.message || e)
  }
  return ctx
}

const projectById = (ctx, id) => (id ? ctx.projects.find((p) => p.id === id) ?? null : null)

// Rules 1 and 2. Null means the task is unclear and the reviewer is asked.
export function settledProject(csaasTask, ctx) {
  const meeting = projectById(ctx, ctx.meetingProjectId)
  if (meeting) return { projectId: meeting.id, projectName: meeting.name ?? null }
  const match = matchProject(csaasTask?.project, ctx)
  if (match?.projectId) return { projectId: match.projectId, projectName: match.projectName ?? null }
  return null
}

// All three rules, plus the repository by the one repository rule (roadmap
// sub-project 4, 2026-09-30; see taskRepo.js): the project's link carrying the
// task's scope, else its only untagged link, else none. A task with no project
// has no repository, whatever name Claude gave it.
export function resolveMeetingTaskProject(csaasTask, reviewTask, ctx) {
  const settled = settledProject(csaasTask, ctx)
  const picked = settled ? null : projectById(ctx, reviewTask?.projectId)
  const projectId = settled?.projectId ?? picked?.id ?? null
  const projectName = settled?.projectName ?? picked?.name ?? null
  const { repository } = resolveTaskRepo(
    { projectId, scope: meetingTaskScope(csaasTask) },
    { links: ctx.links, repos: ctx.repos },
  )
  return { projectId, projectName, repositoryId: repository?.id ?? null }
}

// The choices the review's "Which project?" select offers, stored on the job so
// every re-render (a click, or /meeting-review) shows the same list.
export function reviewProjectOptions(projects) {
  return [...(projects || [])]
    .filter((p) => p?.id && p?.name)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(0, REVIEW_PROJECT_LIMIT)
    .map((p) => ({ id: String(p.id), name: String(p.name) }))
}
