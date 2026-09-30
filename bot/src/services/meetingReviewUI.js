// Pure builders + reducer for the meeting review Discord message.
// No DB, no network, no live discord.js interaction calls — only builders.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} from 'discord.js'
import { meetingTaskScope, meetingTaskModules } from './meetingTaskMap.js'
import { REVIEW_PROJECT_LIMIT } from './meetingTaskProject.js'
import { scopeLabel } from '../utils/taskScope.js'

export const PAGE_SIZE = 2

// A task that needs a project uses three rows (assignee, project, buttons) and
// the footer one, so two such tasks would pass Discord's five-row limit. A
// rejected one still renders its rows, so it still counts.
export function pageSizeFor(state) {
  return (state?.tasks ?? []).some((t) => t.needsProject) ? 1 : PAGE_SIZE
}

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

// `settle(task)` returns the project rules 1–2 settle on ({ projectId,
// projectName }) or null when the reviewer must be asked. Without it (a caller
// predating project review) nothing is asked.
export function initReviewState(tasks, assignments, settle) {
  const asgByTask = new Map()
  for (const a of assignments ?? []) asgByTask.set(taskKey(a.task_id), a)
  return {
    tasks: (tasks ?? []).map((t) => {
      const settled = typeof settle === 'function' ? settle(t) : undefined
      return {
        taskId: taskKey(t.task_id),
        assigneeRef: asgByTask.get(taskKey(t.task_id))?.assignee_ref ?? null,
        // On by default (roadmap sub-project 4): the reviewer opts a task out.
        github: true,
        rejected: false,
        needsProject: settled === null,
        projectId: null,
        projectLabel: settled?.projectName ?? null,
      }
    }),
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
      case 'project':
        return { ...t, projectId: action.projectId && action.projectId !== 'none' ? String(action.projectId) : null }
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

function taskEmbed(task, st, projects) {
  const e = new EmbedBuilder()
  e.setTitle(clip(task.goal_of_task || task.task_id || 'Task', 256))
  const lines = []
  lines.push(`**Scope:** ${scopeLabel(meetingTaskScope(task)) ?? 'none'}`)
  const modules = meetingTaskModules(task)
  if (modules.length) lines.push(`**Modules:** ${modules.join(', ')}`)
  if (st?.needsProject) {
    const picked = projects.find((p) => p.id === st.projectId)
    lines.push(`**Project:** ${picked ? picked.name : 'not set, pick one below'}`)
  } else if (st?.projectLabel) {
    lines.push(`**Project:** ${st.projectLabel}`)
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

export function buildReviewMessage({ job, notes, notesAttached = false, state, roster }) {
  const jobId = job?.id
  const title = job?.dataJson?.title || 'Meeting'
  const allTasks = job?.dataJson?.tasks ?? []
  const asgList = job?.dataJson?.assignments ?? []
  const asgByTask = new Map(asgList.map((a) => [a.task_id, a]))
  const projects = (job?.dataJson?.reviewProjects ?? []).slice(0, REVIEW_PROJECT_LIMIT)

  const size = pageSizeFor(state)
  const pageCount = Math.max(1, Math.ceil(allTasks.length / size))
  const page = Math.min(Math.max(0, state?.page ?? 0), pageCount - 1)
  const start = page * size
  const pageTasks = allTasks.slice(start, start + size)

  const stByTask = new Map((state?.tasks ?? []).map((t) => [taskKey(t.taskId), t]))

  // header embed
  const header = new EmbedBuilder().setTitle(clip(title, 256))
  const headerLines = []
  if (notes) headerLines.push(clip(notes, EMBED_DESC_MAX - 200))
  if (notesAttached) headerLines.push('\nFull notes are attached above.')
  headerLines.push(`\nPage ${page + 1}/${pageCount} — ${allTasks.length} task(s)`)
  header.setDescription(clip(headerLines.join('\n')))

  const embeds = [header]
  const components = []

  for (const task of pageTasks) {
    const st = stByTask.get(taskKey(task.task_id)) ?? {
      taskId: task.task_id,
      assigneeRef: asgByTask.get(task.task_id)?.assignee_ref ?? null,
      github: true,
      rejected: false,
      needsProject: false,
      projectId: null,
      projectLabel: null,
    }
    embeds.push(taskEmbed({ ...task, quote: task.quote ?? asgByTask.get(task.task_id)?.quote }, st, projects))

    const select = new UserSelectMenuBuilder()
      .setCustomId(`mtg_assignee:${jobId}:${task.task_id}`)
      .setPlaceholder('Reassign…')
      .setMinValues(0)
      .setMaxValues(1)
    components.push(new ActionRowBuilder().addComponents(select))

    if (st.needsProject) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`mtg_project:${jobId}:${task.task_id}`)
        .setPlaceholder('Which project?')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          ...projects.map((p) => ({ label: clip(p.name, 100), value: p.id, default: st.projectId === p.id })),
          { label: 'No project', value: 'none' },
        )
      components.push(new ActionRowBuilder().addComponents(menu))
    }

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
