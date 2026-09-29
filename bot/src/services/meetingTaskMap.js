import { isValidScope } from '../utils/taskScope.js'

// Where a meeting task's work is done, when Claude gives no usable scope.
const PLATFORM_SCOPE = { node: 'backend', python: 'backend', react: 'frontend', 'react-native': 'frontend' }

// One of the four fixed scopes, never free text (roadmap sub-project 2,
// 2026-09-29). Claude's pick wins when it is one of the four; otherwise the
// platform decides; otherwise the task has no scope.
export function meetingTaskScope(csaasTask) {
  const picked = String(csaasTask?.scope ?? '').trim().toLowerCase()
  if (isValidScope(picked)) return picked
  const platform = String(csaasTask?.platform ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-')
  return PLATFORM_SCOPE[platform] ?? null
}

// The free-text feature and sub-feature Claude names. They used to be stored as
// the scope; they are Modules now.
export function meetingTaskModules(csaasTask) {
  const out = []
  for (const v of [csaasTask?.feature, csaasTask?.sub_feature]) {
    const s = String(v ?? '').trim()
    if (s && !out.some((m) => m.toLowerCase() === s.toLowerCase())) out.push(s)
  }
  return out
}

// Pure mapper: a CSAAS task + its review row -> args for db.task.create({ data }).
// ctx = { guildConfigId, meetingId, discordChannelId, botUserId, repositoryId,
//         projectId, projectName }
export function mapMeetingTaskToRow(csaasTask, reviewTask, ctx) {
  const actions = Array.isArray(csaasTask.intended_actions) ? csaasTask.intended_actions.join('\n') : ''
  const cmds = Array.isArray(csaasTask.suggested_commands) && csaasTask.suggested_commands.length
    ? `\n\nSuggested commands:\n${csaasTask.suggested_commands.join('\n')}` : ''
  const residence = csaasTask.code_residence ? `\n\nCode: ${csaasTask.code_residence}` : ''
  return {
    guildConfigId: ctx.guildConfigId,
    type: 'feature',
    is_feature: true,
    is_bug: false,
    title: String(csaasTask.goal_of_task || csaasTask.feature || 'Meeting task').slice(0, 200),
    description: `${actions}${cmds}${residence}`.trim().slice(0, 4000) || null,
    status: 'open',
    createdBy: ctx.botUserId || null,
    assigneeIds: reviewTask.assigneeRef ? [reviewTask.assigneeRef] : [],
    // Settled by resolveMeetingTaskProject (meeting project, named project, or
    // the reviewer's pick). No project means no name: the name CSAAS heard is
    // not kept, so it cannot show up on the site as a stray project group.
    projectId: ctx.projectId || null,
    projectName: ctx.projectName || null,
    repositoryId: ctx.repositoryId || null,
    scope: meetingTaskScope(csaasTask),
    modules: meetingTaskModules(csaasTask),
    externalId: `csaas:${csaasTask.task_id}`,
    meetingId: ctx.meetingId,
    discordChannelId: ctx.discordChannelId || null,
  }
}
