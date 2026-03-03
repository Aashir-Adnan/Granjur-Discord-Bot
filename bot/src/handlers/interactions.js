import * as flowStore from '../flows/store.js'
import * as initCmd from '../commands/init.js'
import * as createTaskCmd from '../commands/create-task.js'
import * as approveCmd from '../commands/approve.js'
import * as reposCmd from '../commands/repos.js'
import * as ticketCmd from '../commands/ticket.js'
import * as scheduleCmd from '../commands/schedule.js'
import * as projectDbCmd from '../commands/project-db.js'
import * as faqAnswerCmd from '../commands/faq-answer.js'
import * as scrapCmd from '../commands/scrap.js'

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
function debug(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}]`, ...args)
}

/** Run a create-task handler and log any error; try to respond so Discord does not show "interaction failed". */
async function runCreateTaskHandler(interaction, handlerFn) {
  try {
    await handlerFn(interaction)
  } catch (e) {
    console.error('[interactions] create-task handler error:', e)
    try {
      if (interaction.isMessageComponent?.()) {
        await interaction.update({ content: `Something went wrong: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() =>
          interaction.editReply({ content: `Something went wrong: ${e?.message ?? String(e)}`, components: [], embeds: [] })
        )
      } else if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `Something went wrong: ${e?.message ?? String(e)}`, components: [], embeds: [] })
      } else {
        await interaction.reply({ content: `Something went wrong: ${e?.message ?? String(e)}`, ephemeral: true })
      }
    } catch (replyErr) {
      console.error('[interactions] create-task error reply failed:', replyErr)
    }
  }
}

export default async function handleInteractions(interaction) {
  const customId = interaction.customId || ''

  if (interaction.isModalSubmit()) {
    if (customId === 'create_task_modal') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleTaskModal(i))
    if (customId === 'repos_modal') return reposCmd.handleAddModal(interaction)
    if (customId === 'schedule_modal') return scheduleCmd.handleScheduleModal(interaction)
    if (customId === 'faq_ask_modal') return (await import('../commands/faq.js')).handleFaqAskModal(interaction)
    if (customId === 'faq_search_modal') return (await import('../commands/faq.js')).handleFaqSearchModal(interaction)
    if (customId === 'faq_answer_modal') return faqAnswerCmd.handleAnswerModal(interaction)
    if (customId === 'project_db_schema_modal') return projectDbCmd.handleSchemaModal(interaction)
    if (customId === 'invite_email_modal') return (await import('../commands/invite.js')).handleInviteModal(interaction)
    if (customId === 'verify_otp_modal') return (await import('../commands/verify.js')).handleOtpModal(interaction)
    if (customId.startsWith('backlog_approve_modal:')) return (await import('../commands/backlog.js')).handleBacklogApproveModal(interaction)
    if (customId.startsWith('backlog_add_role_modal:')) return (await import('../commands/backlog.js')).handleBacklogAddRoleModal(interaction)
    if (customId === 'edit_docs_modal') return (await import('../commands/edit-docs.js')).handleEditDocsModal(interaction)
    return
  }

  if (interaction.isButton()) {
    if (customId === 'init_confirm') {
      debug('init_confirm: calling handleConfirm')
      return initCmd.handleConfirm(interaction)
    }
    if (customId === 'init_cancel') return initCmd.handleCancel(interaction)
    if (customId === 'create_task_type_feature' || customId === 'create_task_type_bug') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleTypeButton(i))
    if (customId === 'create_task_show_modal') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleShowModalButton(i))
    if (customId === 'create_task_repos_next') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleReposNext(i))
    if (customId === 'create_task_members_next') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleMembersNext(i))
    if (customId === 'create_task_create') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleCreate(i))
    if (customId === 'create_task_edit') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleEditButton(i))
    if (customId === 'create_task_cancel') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleCancel(i))
    if (customId === 'repos_add' || customId === 'repos_list') return reposCmd.handleChoice(interaction)
    if (customId === 'repos_confirm_add') return reposCmd.handleConfirmAdd(interaction)
    if (customId === 'repos_cancel') return reposCmd.handleCancel(interaction)
    if (customId === 'schedule_show_modal') return scheduleCmd.handleShowModalButton(interaction)
    if (customId === 'scrap_confirm') return scrapCmd.handleConfirm(interaction)
    if (customId === 'scrap_cancel') return scrapCmd.handleCancel(interaction)
    if (customId.startsWith('dashboard_')) return (await import('../commands/dashboard.js')).handleModule(interaction)
    if (customId === 'faq_ask') return (await import('../commands/faq.js')).handleFaqAsk(interaction)
    if (customId === 'faq_search') return (await import('../commands/faq.js')).handleFaqSearch(interaction)
    if (customId === 'verify_get_code') return (await import('../commands/verify.js')).handleGetCode(interaction)
    if (customId === 'verify_enter_otp') return (await import('../commands/verify.js')).handleEnterOtpButton(interaction)
    if (customId === 'invite_enter_email') return (await import('../commands/invite.js')).handleInviteButton(interaction)
    if (customId === 'approve_confirm') return approveCmd.handleConfirm(interaction)
    if (customId.startsWith('backlog_approve_btn:')) return (await import('../commands/backlog.js')).handleBacklogApproveButton(interaction)
    if (customId === 'approve_cancel') return approveCmd.handleCancel(interaction)
    if (customId === 'doc_traversal_refresh') return (await import('../commands/doc-channel.js')).handleDocTraversalRefresh(interaction)
    if (customId === 'doc_traversal_back') return (await import('../commands/doc-channel.js')).handleDocTraversalBack(interaction)
    await interaction.editReply({ content: 'Unknown button.', components: [] }).catch(() => {})
    return
  }

  if (interaction.isStringSelectMenu()) {
    const value = interaction.values?.[0]
    if (customId === 'create_task_repo') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleRepoSelect(i))
    if (customId === 'create_task_select_repos') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleReposSelect(i))
    if (customId === 'create_task_select_projects') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleProjectsSelect(i))
    if (customId === 'create_task_members') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleMembersSelect(i))
    if (customId === 'create_task_assignees') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleAssigneesSelect(i))
    if (customId === 'create_task_metric_api') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleMetricApi(i))
    if (customId === 'create_task_metric_qa') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleMetricQa(i))
    if (customId === 'create_task_metric_ac') return runCreateTaskHandler(interaction, (i) => createTaskCmd.handleMetricAc(i))
    if (customId === 'backlog_select_user') return (await import('../commands/backlog.js')).handleBacklogUserSelect(interaction)
    if (customId === 'backlog_select_roles') return (await import('../commands/backlog.js')).handleBacklogRoleSelect(interaction)
    if (customId === 'approve_user') return approveCmd.handleUserSelect(interaction)
    if (customId === 'approve_roles') return approveCmd.handleRolesSelect(interaction)
    if (customId === 'ticket_select') return ticketCmd.handleTicketSelect(interaction)
    if (customId.startsWith('ticket_status')) return ticketCmd.handleStatusSelect(interaction)
    if (customId === 'schedule_members') return scheduleCmd.handleMembersSelect(interaction)
    if (customId === 'schedule_confirm') return scheduleCmd.handleConfirm(interaction)
    if (customId === 'schedule_cancel') return scheduleCmd.handleCancel(interaction)
    if (customId === 'project_db_select') return projectDbCmd.handleProjectSelect(interaction)
    if (customId === 'evaluate_user') return (await import('../commands/evaluate.js')).handleUserSelect(interaction)
    if (customId === 'docs_browse') return (await import('../commands/docs.js')).handleDocsBrowse(interaction)
    if (customId === 'faq_answer_select') return faqAnswerCmd.handleFaqSelect(interaction)
    if (customId === 'dashboard_select') return (await import('../commands/dashboard.js')).handleModuleSelect(interaction)
    if (customId === 'fetch_my_select') return (await import('../commands/fetch-my.js')).handleFetchSelect(interaction)
    if (customId === 'doc_traversal_select') return (await import('../commands/doc-channel.js')).handleDocTraversalSelect(interaction)
    if (customId === 'edit_docs_select') return (await import('../commands/edit-docs.js')).handleEditDocsSelect(interaction)
    // No handler matched — we already deferred, so we must editReply or Discord shows "interaction failed"
    await interaction.editReply({ content: 'Unknown action.', components: [] }).catch(() => {})
    return
  }

  // Modal or component with no matching handler — if we deferred, send something so Discord gets a response
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content: 'Unknown action.', components: [] }).catch(() => {})
  }
}
