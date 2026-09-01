// Pure mapper: a CSAAS task + its review row -> args for db.task.create({ data }).
// ctx = { guildConfigId, meetingId, discordChannelId, botUserId, repositoryId }
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
    projectName: csaasTask.project || null,
    repositoryId: ctx.repositoryId || null,
    scope: csaasTask.feature || null,
    modules: csaasTask.sub_feature ? [csaasTask.sub_feature] : [],
    externalId: `csaas:${csaasTask.task_id}`,
    meetingId: ctx.meetingId,
    discordChannelId: ctx.discordChannelId || null,
  }
}
