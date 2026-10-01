import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'
import { taskChoiceLabel, holdersOf, idList } from '../utils/taskLabel.js'
import { notifyTaskUpdate } from '../services/taskUpdateNotify.js'
import { showFinder } from '../services/taskFinder.js'
import { memberPassesRoleGate, LEADERSHIP_ROLE_NAMES } from '../utils/roleGate.js'
import { memberIdsNamed } from '../utils/memberSearch.js'
import { SCOPE_CHOICES, scopeLabel } from '../utils/taskScope.js'
import { applyDependencyChange, applyEdit, projectMoveNote } from '../services/taskEdit.js'
import { PROJECT_DELETED, isDeletedProject, projectIdIsDeleted } from '../utils/projectDeleted.js'

export { applyDependencyChange, projectMoveNote }

/** Parse space-separated @mentions or Discord user IDs into array of IDs. */
function parseUserIds(str) {
  if (!str || !str.trim()) return []
  const ids = new Set()
  const re = /<@!?(\d+)>|(\d{17,19})/g
  let m
  while ((m = re.exec(str)) !== null) ids.add(m[1] || m[2])
  return [...ids]
}

const STATUS_CHOICES = [
  { name: 'Open', value: 'open' },
  { name: 'Pending', value: 'pending' },
  { name: 'In progress', value: 'in_progress' },
  { name: 'Resolved', value: 'resolved' },
  { name: 'Closed', value: 'closed' },
  { name: 'Done', value: 'done' },
]

export const data = new SlashCommandBuilder()
  .setName('update-task')
  .setDescription('Update a task — pick it from the list, then set any field')
  .addStringOption((o) =>
    o
      .setName('task')
      .setDescription('Start typing a title — or leave empty to browse and filter tasks')
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addStringOption((o) =>
    o.setName('status').setDescription('New status').setRequired(false).addChoices(...STATUS_CHOICES)
  )
  .addStringOption((o) =>
    o.setName('scope').setDescription('Scope').setRequired(false).addChoices(...SCOPE_CHOICES)
  )
  .addIntegerOption((o) =>
    o.setName('passed_api_tests').setDescription('Number of API tests passed (null = N/A)').setRequired(false).setMinValue(0)
  )
  .addIntegerOption((o) =>
    o.setName('passed_qa_tests').setDescription('Number of QA tests passed').setRequired(false).setMinValue(0)
  )
  .addIntegerOption((o) =>
    o.setName('passed_acceptance_criteria').setDescription('Number of AC passed').setRequired(false).setMinValue(0)
  )
  .addStringOption((o) =>
    o.setName('title').setDescription('New title').setRequired(false).setMaxLength(200)
  )
  .addStringOption((o) =>
    o.setName('description').setDescription('New description').setRequired(false).setMaxLength(2000)
  )
  .addStringOption((o) =>
    o.setName('assignees').setDescription('Assignees: @mentions or user IDs, space-separated').setRequired(false).setMaxLength(500)
  )
  .addStringOption((o) =>
    o.setName('implementation_status').setDescription('Implementation status').setRequired(false).addChoices(
      { name: 'Not started', value: 'not_started' },
      { name: 'In progress', value: 'in_progress' },
      { name: 'Done', value: 'done' }
    )
  )
  .addStringOption((o) =>
    o
      .setName('project')
      .setDescription('Attach the task to a project (start typing a project name)')
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addUserOption((o) => o.setName('add_assignee').setDescription('Add one more assignee').setRequired(false))
  .addUserOption((o) => o.setName('remove_assignee').setDescription('Take one assignee off the task').setRequired(false))
  .addStringOption((o) => o.setName('blocked_by').setDescription('This task cannot proceed until that task is done (pick from the list)').setRequired(false).setAutocomplete(true))
  .addStringOption((o) => o.setName('unblock').setDescription('Remove a blocker from this task (pick from the list)').setRequired(false).setAutocomplete(true))

/** Sentinel value for "detach from any project" in the project picker. */
export const NO_PROJECT = 'none'

/** Next assignee list, or null when no assignee option was given. Pure. */
export function nextAssignees(current, { replace, add, remove } = {}) {
  if (replace === undefined && !add && !remove) return null
  const out = new Set(idList(replace !== undefined ? replace : current))
  if (add) out.add(String(add))
  if (remove) out.delete(String(remove))
  return [...out]
}

/** Same ids, ignoring order. Pure. */
export function sameIds(a, b) {
  const x = new Set(idList(a))
  const y = new Set(idList(b))
  return x.size === y.size && [...x].every((id) => y.has(id))
}

/**
 * Whether `callerId` may see and update `task` in `/update-task`. CEO and
 * Server Manager (leadership) see and can update anything; anyone else only
 * a task they hold — same definition of "theirs" the picker's fuzzy search
 * already uses (assignees for a feature, tagged members for a bug). Pure.
 */
export function canSeeTask(task, { isLeadership, callerId }) {
  return Boolean(isLeadership) || holdersOf(task).includes(String(callerId))
}

export async function execute(interaction, { db: dbArg = db, notify = notifyTaskUpdate, getConfig = getOrCreateGuildConfig } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const picked = interaction.options.getString('task')
  // Nothing named on the command line: open the Find panel instead.
  if (picked === null || picked === undefined || !picked.trim()) return showFinder(interaction, { db: dbArg, getConfig })

  const taskId = picked.trim()
  const cfg = await getConfig(guild.id)
  const task = await dbArg.task.findFirst({ where: { id: taskId, guildConfigId: cfg.id } })
  const notFoundReply = () =>
    interaction.editReply({
      content: `No task matches **${taskId.slice(0, 80)}**. Start typing a title and pick one from the list.`,
    })
  if (!task) {
    // Reached by typing free text instead of picking a suggestion: the option
    // carries whatever was typed, not an id.
    return notFoundReply()
  }

  const isLeadership = memberPassesRoleGate(guild, interaction.member, ensureStringArray(cfg.dashboardRoleIds), LEADERSHIP_ROLE_NAMES)
  if (!canSeeTask(task, { isLeadership, callerId: interaction.user.id })) {
    // Same message as "does not exist" — a normal member who pastes a raw id
    // that isn't theirs must not be able to tell the two apart.
    return notFoundReply()
  }
  // A task in a soft-deleted project cannot be changed until it is reactivated.
  if (await projectIdIsDeleted(dbArg, task.projectId)) return interaction.editReply({ content: PROJECT_DELETED })

  const updates = {}
  const status = interaction.options.getString('status')
  if (status !== null && status !== undefined) updates.status = status
  const scope = interaction.options.getString('scope')
  if (scope !== null && scope !== undefined) updates.scope = scope
  const passedApi = interaction.options.getInteger('passed_api_tests')
  if (passedApi !== null && passedApi !== undefined) updates.passedApiTests = passedApi
  const passedQa = interaction.options.getInteger('passed_qa_tests')
  if (passedQa !== null && passedQa !== undefined) updates.passedQaTests = passedQa
  const passedAc = interaction.options.getInteger('passed_acceptance_criteria')
  if (passedAc !== null && passedAc !== undefined) updates.passedAcceptanceCriteria = passedAc
  const title = interaction.options.getString('title')
  if (title !== null && title !== undefined) updates.title = title.trim()
  const description = interaction.options.getString('description')
  if (description !== null && description !== undefined) updates.description = description.trim() || null
  const assigneesStr = interaction.options.getString('assignees')
  const assignees = nextAssignees(task.assigneeIds, {
    replace: assigneesStr !== null && assigneesStr !== undefined ? parseUserIds(assigneesStr) : undefined,
    add: interaction.options.getUser('add_assignee')?.id,
    remove: interaction.options.getUser('remove_assignee')?.id,
  })
  if (assignees && !sameIds(assignees, task.assigneeIds)) updates.assigneeIds = assignees
  const implStatus = interaction.options.getString('implementation_status')
  if (implStatus !== null && implStatus !== undefined) updates.implementationStatus = implStatus
  const projectOpt = interaction.options.getString('project')
  if (projectOpt !== null && projectOpt !== undefined) {
    if (projectOpt === NO_PROJECT) {
      updates.projectId = null
      updates.projectName = null
    } else {
      // The picker's value is a project id; free text typed past the
      // suggestions arrives as-is and must not be written as an id.
      const row = await dbArg.project.findFirst({ where: { id: projectOpt } }).catch(() => null)
      if (!row || row.guildConfigId !== cfg.id) {
        return interaction.editReply({ content: `No project matches **${projectOpt.slice(0, 80)}**. Start typing a project name and pick one from the list.` })
      }
      if (isDeletedProject(row)) return interaction.editReply({ content: PROJECT_DELETED })
      updates.projectId = row.id
      updates.projectName = row.name
    }
  }

  const blockedById = interaction.options.getString('blocked_by')?.trim() || null
  const unblockId = interaction.options.getString('unblock')?.trim() || null
  const hasUpdates = Object.keys(updates).length > 0
  if (!hasUpdates && !blockedById && !unblockId) {
    return interaction.editReply({ content: 'Provide at least one field to update (e.g. `status`, `add_assignee`, `blocked_by`).' })
  }

  return commitUpdate(interaction, { db: dbArg, notify, cfg, task, updates, blockedById, unblockId })
}

/**
 * Write an already-validated update (and blocker change) and run its
 * consequences, without replying. Every refusal returns `{ error }` before the
 * task row is written, so a refused dependency never leaves a half-applied
 * update. Throws if the write itself fails. Shared by the slash command, the
 * Edit modal and the task hub.
 */
export async function runUpdate(interaction, { db: dbArg = db, notify = notifyTaskUpdate, cfg, task, updates, blockedById = null, unblockId = null }) {
  const result = await applyEdit({
    db: dbArg,
    client: interaction.client,
    guild: interaction.guild,
    cfg,
    task,
    updates,
    blockers: { add: blockedById ? [blockedById] : [], remove: unblockId ? [unblockId] : [] },
    actor: { discordId: interaction.user.id },
    notify,
  })
  if (result.error) return { error: result.error }
  return { dep: result.dep, warning: result.warning, notified: result.notified }
}

/**
 * Apply an already-validated update (and blocker change) to `task` and reply.
 * Shared by the slash command and the Edit modal, so both write, notify and
 * report identically. `interaction` must already be deferred.
 */
export async function commitUpdate(interaction, { db: dbArg = db, notify = notifyTaskUpdate, cfg, task, updates, blockedById = null, unblockId = null }) {
  const taskId = task.id
  try {
    const result = await runUpdate(interaction, { db: dbArg, notify, cfg, task, updates, blockedById, unblockId })
    if (result.error) return interaction.editReply({ content: result.error })
    const { dep, warning, notified } = result

    const embed = new EmbedBuilder()
      .setTitle('Task updated')
      .setDescription(warning ? `**${task.title || taskId}**\n${warning}` : `**${task.title || taskId}**`)
      .addFields(Object.entries(updates).map(([k, v]) => ({
        name: k,
        value: Array.isArray(v) ? (v.length ? v.map((id) => `<@${id}>`).join(' ') : 'None') : String(v ?? 'null'),
        inline: true,
      })))
      .setColor(0x57f287)
    if (dep.lines.length) {
      let depValue = dep.lines.join('\n')
      if (depValue.length > 1024) depValue = `${depValue.slice(0, 1023)}…`
      embed.addFields({ name: 'Dependencies', value: depValue, inline: false })
    }
    // Moving a task between projects moves the ROW, not the channel: nothing
    // here re-parents it, and the overwrite merge that repairs task channels
    // keeps the old project role's allow, so the old project's members go on
    // seeing a task that is no longer theirs until the section is rebuilt.
    // Saying so is the whole fix — a silent half-move is the thing to avoid.
    const moveNote = projectMoveNote(task, updates)
    if (moveNote) embed.addFields({ name: 'Project changed', value: moveNote, inline: false })
    if (notified.channelId) {
      embed.addFields({
        name: notified.created ? 'Channel created' : 'Task channel',
        value: `<#${notified.channelId}>`,
        inline: false,
      })
    }
    if (notified.dmed.length) {
      embed.setFooter({ text: `Notified ${notified.dmed.length} member(s) by DM` })
    }
    return interaction.editReply({ embeds: [embed] })
  } catch (e) {
    console.error('[update-task]', e)
    return interaction.editReply({ content: `Update failed: ${e?.message ?? String(e)}` })
  }
}

/**
 * Task picker. A task id is a 25-character hex string; nobody should have to
 * read one off a dashboard and retype it, so the choice shows title, status and
 * holder while the value stays the id.
 */
/** Project picker choices: "No project" first, then names matching the typed text. Pure. */
export function projectChoices(projects, term, { withDetach = true } = {}) {
  const t = String(term || '').trim().toLowerCase()
  const head = { name: 'No project — detach from any project', value: NO_PROJECT }
  const rest = (projects || [])
    .filter((p) => !t || String(p.name || '').toLowerCase().includes(t))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }))
    .map((p) => ({ name: String(p.name || p.id).slice(0, 100), value: String(p.id) }))
  return (withDetach ? [head, ...rest] : rest).slice(0, 25)
}

export async function autocomplete(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const focused = interaction.options.getFocused(true)
  if (focused.name === 'project') {
    try {
      const cfg = await getConfig(interaction.guild.id)
      const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
      return interaction.respond(projectChoices(projects, focused.value)).catch(() => {})
    } catch (e) {
      console.error('[update-task] project autocomplete:', e?.message ?? e)
      return interaction.respond([]).catch(() => {})
    }
  }
  if (!['task', 'blocked_by', 'unblock'].includes(focused.name)) return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getConfig(interaction.guild.id)
    const term = String(focused.value || '').trim().toLowerCase()
    // A blocker can belong to anyone — declaring "my task depends on that
    // one" needs no permission over the blocking task, so the caller-only
    // narrowing is for the `task` field only, never blocked_by/unblock.
    const isLeadership = focused.name === 'task'
      ? memberPassesRoleGate(interaction.guild, interaction.member, ensureStringArray(cfg.dashboardRoleIds), LEADERSHIP_ROLE_NAMES)
      : true
    // The search runs in SQL so the 200-row window holds matches rather than
    // whatever was touched last: one bulk import used to push every other
    // project out of the picker. The in-memory filter below stays the exact
    // rule; the query only decides which rows are worth loading.
    const where = { guildConfigId: cfg.id }
    if (term) where.search = { text: term, holderIds: memberIdsNamed(interaction.guild, term) }
    else if (!isLeadership) where.holderId = interaction.user.id
    let rows = await dbArg.task.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 })
    if (!isLeadership) rows = rows.filter((t) => canSeeTask(t, { isLeadership, callerId: interaction.user.id }))
    if (focused.name === 'unblock') {
      // With a real task picked, offer only its current blockers — an empty
      // list when it has none. Fall back to all tasks only when `task` is
      // empty or not a known id.
      const taskId = String(interaction.options.getString('task') || '').trim()
      const known = taskId ? await dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids: [taskId] } }) : []
      if (known.length) {
        const deps = await dbArg.taskDependency.findByTask({ where: { taskId } })
        const ids = deps.map((d) => d.blockedByTaskId)
        // The task's current blockers by id, deleted projects included: a
        // blocker whose project was deleted still holds it and can be removed.
        rows = ids.length ? await dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids, includeDeleted: true } }) : []
      }
    }
    // Members are resolved from cache only — autocomplete has ~3 seconds and a
    // fetch per assignee would blow it. An unresolved id shows as the id.
    const nameFor = (id) => interaction.guild.members.cache.get(id)?.displayName ?? null

    // Project names, so the picker can search and label by project. A failed
    // lookup only costs that — the picker still works by title.
    const projectNames = new Map()
    if (focused.name === 'task') {
      const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } }).catch(() => [])
      for (const p of projects || []) projectNames.set(String(p.id), String(p.name || ''))
    }
    const projectNameOf = (t) => projectNames.get(String(t.projectId ?? '')) ?? null

    const matches = rows.filter((t) => {
      if (!term) return true
      if (String(t.title || '').toLowerCase().includes(term)) return true
      if (String(t.id).toLowerCase().startsWith(term)) return true
      if (String(t.status || '').toLowerCase() === term) return true
      if (String(projectNameOf(t) || '').toLowerCase().includes(term)) return true
      if (t.scope && String(scopeLabel(t.scope)).toLowerCase().startsWith(term)) return true
      return holdersOf(t).some((id) => String(nameFor(id) || '').toLowerCase().includes(term))
    })

    return interaction
      .respond(matches.slice(0, 25).map((t) => ({
        name: taskChoiceLabel(t, { nameFor, projectName: projectNameOf(t) }),
        value: t.id,
      })))
      .catch(() => {})
  } catch (e) {
    console.error('[update-task] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}
