// Pure builders + reducer for the meeting review Discord message.
// No DB, no network, no live discord.js interaction calls — only builders.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  UserSelectMenuBuilder,
} from 'discord.js'

export const PAGE_SIZE = 2

const EMBED_DESC_MAX = 4000

function clip(str, max = EMBED_DESC_MAX) {
  const s = String(str ?? '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// ---- state ----------------------------------------------------------------

// CSAAS returns a task's id as a NUMBER in the task list but as a STRING in the
// assignment list, and a Discord customId can only ever carry a string. Every
// lookup below is a strict comparison, so one un-normalized side silently drops
// the match — which is exactly what happened on 2026-09-04: a 0.92-confidence
// auto-assignment never reached the picker, and clicking the picker changed
// nothing, so an approved meeting produced two unassigned tasks and no ticket
// channels. Compare task ids as strings, always.
export const taskKey = (v) => (v == null ? '' : String(v))

export function initReviewState(tasks, assignments) {
  const asgByTask = new Map()
  for (const a of assignments ?? []) asgByTask.set(taskKey(a.task_id), a)
  return {
    tasks: (tasks ?? []).map((t) => ({
      taskId: taskKey(t.task_id),
      assigneeRef: asgByTask.get(taskKey(t.task_id))?.assignee_ref ?? null,
      github: false,
      rejected: false,
    })),
    page: 0,
  }
}

export function applyReviewAction(state, action) {
  if (action?.type === 'page') {
    return { ...state, page: action.page }
  }
  const mapTask = (t) => {
    if (taskKey(t.taskId) !== taskKey(action.taskId)) return t
    switch (action.type) {
      case 'assignee':
        return { ...t, assigneeRef: action.ref }
      case 'toggleGithub':
        return { ...t, github: !t.github }
      case 'rejectTask':
        return { ...t, rejected: true }
      default:
        return t
    }
  }
  return { ...state, tasks: state.tasks.map(mapTask) }
}

export function summarizeApproval(state, tasks) {
  const stByTask = new Map(state.tasks.map((t) => [taskKey(t.taskId), t]))
  const approved = []
  let rejectedCount = 0
  let githubCount = 0
  for (const task of tasks ?? []) {
    const st = stByTask.get(taskKey(task.task_id))
    if (st?.rejected) {
      rejectedCount += 1
      continue
    }
    approved.push(task)
    if (st?.github === true) githubCount += 1
  }
  return { approved, rejectedCount, githubCount }
}

// ---- message -------------------------------------------------------------

function taskEmbed(task, st, roster) {
  const e = new EmbedBuilder()
  e.setTitle(clip(task.goal_of_task || task.task_id || 'Task', 256))
  const lines = []
  if (task.feature || task.sub_feature) {
    lines.push(`**Scope:** ${[task.feature, task.sub_feature].filter(Boolean).join(' > ')}`)
  }
  if (task.code_residence) lines.push(`**Code:** \`${task.code_residence}\``)
  if (st?.assigneeRef) lines.push(`**Assignee:** <@${st.assigneeRef}>`)
  else lines.push('**Assignee:** unassigned')
  const asgQuote = task.quote
  if (asgQuote) lines.push(`> ${clip(asgQuote, 500)}`)
  lines.push(`**GitHub issue:** ${st?.github ? 'yes' : 'no'}`)
  if (st?.rejected) lines.push('⚠️ rejected')
  e.setDescription(clip(lines.join('\n')))
  return e
}

export function buildReviewMessage({ job, notes, reportPath, state, roster }) {
  const jobId = job?.id
  const title = job?.dataJson?.title || 'Meeting'
  const allTasks = job?.dataJson?.tasks ?? []
  const asgList = job?.dataJson?.assignments ?? []
  const asgByTask = new Map(asgList.map((a) => [a.task_id, a]))

  const pageCount = Math.max(1, Math.ceil(allTasks.length / PAGE_SIZE))
  const page = Math.min(Math.max(0, state?.page ?? 0), pageCount - 1)
  const start = page * PAGE_SIZE
  const pageTasks = allTasks.slice(start, start + PAGE_SIZE)

  const stByTask = new Map((state?.tasks ?? []).map((t) => [taskKey(t.taskId), t]))

  // header embed
  const header = new EmbedBuilder().setTitle(clip(title, 256))
  const headerLines = []
  if (notes) headerLines.push(clip(notes, EMBED_DESC_MAX - 200))
  if (reportPath) headerLines.push(`\nFull report: \`${reportPath}\` (on the VM)`)
  headerLines.push(`\nPage ${page + 1}/${pageCount} — ${allTasks.length} task(s)`)
  header.setDescription(clip(headerLines.join('\n')))

  const embeds = [header]
  const components = []

  for (const task of pageTasks) {
    const st = stByTask.get(taskKey(task.task_id)) ?? {
      taskId: task.task_id,
      assigneeRef: asgByTask.get(task.task_id)?.assignee_ref ?? null,
      github: false,
      rejected: false,
    }
    embeds.push(taskEmbed({ ...task, quote: task.quote ?? asgByTask.get(task.task_id)?.quote }, st, roster))

    const select = new UserSelectMenuBuilder()
      .setCustomId(`mtg_assignee:${jobId}:${task.task_id}`)
      .setPlaceholder('Reassign…')
      .setMinValues(0)
      .setMaxValues(1)
    components.push(new ActionRowBuilder().addComponents(select))

    const btnRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mtg_gh:${jobId}:${task.task_id}`)
        .setLabel(`GitHub: ${st.github ? 'on' : 'off'}`)
        .setStyle(st.github ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`mtg_taskreject:${jobId}:${task.task_id}`)
        .setLabel('Drop')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!!st.rejected),
    )
    components.push(btnRow)
  }

  // footer row
  const footer = new ActionRowBuilder()
  if (pageCount > 1) {
    footer.addComponents(
      new ButtonBuilder()
        .setCustomId(`mtg_page:${jobId}:${page - 1}`)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`mtg_page:${jobId}:${page + 1}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1),
    )
  }
  footer.addComponents(
    new ButtonBuilder()
      .setCustomId(`mtg_approve:${jobId}`)
      .setLabel('Approve all & assign')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`mtg_reject:${jobId}`)
      .setLabel('Reject meeting')
      .setStyle(ButtonStyle.Danger),
  )
  components.push(footer)

  return { embeds, components }
}
