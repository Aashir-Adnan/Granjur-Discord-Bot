// The task hub: everything you can change about one task, reached by picking
// it in the Find panel (services/taskFinder.js).
//
// A Discord modal holds five fields at most, so it cannot carry every editable
// property. The hub is a message with the task's current values and the rest of
// the controls: Project, Implementation status, Blocked by / Unblock as
// selects; "Edit details" (status, scope, assignees, title, description) and
// "Test counts" as buttons that open modals. Each change is saved as soon as it
// is made, through the same update path as the slash command (notifications,
// blocker checks and the activity log are identical), and the hub redraws with
// what happened.
//
// State is the task id in each custom id (`uth_<action>:<taskId>`); nothing is
// held in memory.

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder, MessageFlags, ModalBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'
import { holdersOf, idList } from '../utils/taskLabel.js'
import { memberPassesRoleGate, LEADERSHIP_ROLE_NAMES } from '../utils/roleGate.js'
import { SCOPE_CHOICES, scopeLabel } from '../utils/taskScope.js'
import { wouldCycle } from '../utils/taskDeps.js'
import { notifyTaskUpdate } from './taskUpdateNotify.js'
import { canSeeTask, projectMoveNote, runUpdate, sameIds } from '../commands/update-task.js'

export const EDIT_MODAL_PREFIX = 'ut_edit:'
export const COUNTS_MODAL_PREFIX = 'ut_counts:'
const NONE = '-'
export const MAX_TEST_COUNT = 127 // the column is a signed TINYINT
export const NOT_FOUND = 'That task is not available to you any more. Run **/update-task** again.'

const STATUS_OPTIONS = [
  { label: 'Open', value: 'open' },
  { label: 'Pending', value: 'pending' },
  { label: 'In progress', value: 'in_progress' },
  { label: 'Resolved', value: 'resolved' },
  { label: 'Closed', value: 'closed' },
  { label: 'Done', value: 'done' },
]
const IMPLEMENTATION_OPTIONS = [
  { label: 'Not started', value: 'not_started' },
  { label: 'In progress', value: 'in_progress' },
  { label: 'Done', value: 'done' },
]
const TERMINAL = new Set(['resolved', 'closed', 'done'])
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
const idFor = (action, taskId) => `uth_${action}:${taskId}`

// ---------------------------------------------------------------- access ----

export async function context(interaction, { getConfig }) {
  const cfg = await getConfig(interaction.guild.id)
  const isLeadership = memberPassesRoleGate(interaction.guild, interaction.member, ensureStringArray(cfg.dashboardRoleIds), LEADERSHIP_ROLE_NAMES)
  return { cfg, isLeadership }
}

/** The task, only if this person may see it; everything the hub draws alongside it. */
async function loadHub(interaction, taskId, d) {
  const { cfg, isLeadership } = await context(interaction, d)
  const task = taskId ? await d.db.task.findFirst({ where: { id: taskId, guildConfigId: cfg.id } }) : null
  if (!task || !canSeeTask(task, { isLeadership, callerId: interaction.user.id })) return { cfg, task: null }

  const [projects, deps, recent] = await Promise.all([
    d.db.project.findMany({ where: { guildConfigId: cfg.id } }).catch(() => []),
    d.db.taskDependency.findManyForGuild({ where: { guildConfigId: cfg.id } }).catch(() => []),
    d.db.task.findMany({ where: { guildConfigId: cfg.id }, orderBy: { updatedAt: 'desc' }, take: 200 }),
  ])
  const blockerIds = deps.filter((x) => x.taskId === task.id).map((x) => String(x.blockedByTaskId))
  const blockers = blockerIds.length ? await d.db.task.findByIds({ where: { guildConfigId: cfg.id, ids: blockerIds } }) : []
  const candidates = blockerCandidates(task, recent, deps, blockerIds)
  return { cfg, task, projects, blockers, candidates }
}

/**
 * Tasks this one could be blocked by: not itself, not already a blocker, not
 * finished (waiting on a finished task means nothing) and not one that would
 * make a cycle. Same project first. A blocker can belong to anyone — declaring
 * "my task waits on that one" needs no permission over the other. Pure.
 */
export function blockerCandidates(task, rows, deps, currentBlockerIds = []) {
  const have = new Set(currentBlockerIds.map(String))
  return (rows || [])
    .filter((t) => t.id !== task.id && !have.has(String(t.id)) && !TERMINAL.has(String(t.status)) && !wouldCycle(task.id, t.id, deps))
    .sort((a, b) => Number(String(b.projectId ?? '') === String(task.projectId ?? '')) - Number(String(a.projectId ?? '') === String(task.projectId ?? '')))
    .slice(0, 25)
}

// --------------------------------------------------------------- the hub ----

const testsText = (t) => [['API', t.passedApiTests], ['QA', t.passedQaTests], ['AC', t.passedAcceptanceCriteria]]
  .map(([n, v]) => `${n} ${v === null || v === undefined ? '—' : v}`).join(' · ')

/** The hub message. Pure apart from building discord.js objects. */
export function buildHubPayload({ task, projects, blockers, candidates, notice = '', nameFor = () => null }) {
  const holders = holdersOf(task)
  const embed = new EmbedBuilder()
    .setTitle(clip(task.title || 'Task', 250))
    .setColor(0x5865f2)
    .addFields(
      { name: 'Status', value: String(task.status || 'open').replace(/_/g, ' '), inline: true },
      { name: 'Scope', value: scopeLabel(task.scope) || 'Not set', inline: true },
      { name: 'Project', value: task.projectName || 'None', inline: true },
      { name: 'Implementation', value: task.implementationStatus ? String(task.implementationStatus).replace(/_/g, ' ') : 'Not set', inline: true },
      { name: 'Tests passed', value: testsText(task), inline: true },
      { name: 'Assignees', value: holders.length ? clip(holders.map((id) => nameFor(id) || `<@${id}>`).join(', '), 1000) : 'Nobody', inline: true },
      {
        name: 'Blocked by',
        value: blockers.length ? clip(blockers.slice(0, 10).map((b) => `• ${b.title || b.id} (${String(b.status || 'open').replace(/_/g, ' ')})`).join('\n'), 1000) : 'Nothing',
        inline: false,
      },
    )
    .setFooter({ text: 'Project, implementation and blockers save as soon as you pick them.' })

  const components = []

  const projectOptions = [
    new StringSelectMenuOptionBuilder().setLabel('No project').setValue(NONE).setDefault(!task.projectId),
    ...[...(projects || [])]
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }))
      .slice(0, 24)
      .map((p) => new StringSelectMenuOptionBuilder().setLabel(clip(p.name || p.id, 100)).setValue(String(p.id)).setDefault(String(p.id) === String(task.projectId ?? ''))),
  ]
  components.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(idFor('proj', task.id)).setPlaceholder('Project').setOptions(projectOptions),
  ))

  components.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(idFor('impl', task.id)).setPlaceholder('Implementation status').setOptions(
      IMPLEMENTATION_OPTIONS.map((o) => new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value).setDefault(o.value === task.implementationStatus)),
    ),
  ))

  if (candidates.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(idFor('block', task.id)).setPlaceholder('Add a blocker — this task waits on…').setOptions(
        candidates.map((t) => new StringSelectMenuOptionBuilder()
          .setLabel(clip(t.title || t.id, 100)).setValue(String(t.id))
          .setDescription(clip([String(t.status || 'open').replace(/_/g, ' '), t.projectName].filter(Boolean).join(' · '), 100))),
      ),
    ))
  }
  if (blockers.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(idFor('unblock', task.id)).setPlaceholder('Remove a blocker…').setOptions(
        blockers.slice(0, 25).map((t) => new StringSelectMenuOptionBuilder().setLabel(clip(t.title || t.id, 100)).setValue(String(t.id))),
      ),
    ))
  }

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(idFor('basics', task.id)).setLabel('Edit details').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(idFor('counts', task.id)).setLabel('Test counts').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(idFor('back', task.id)).setLabel('Back to list').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(idFor('close', task.id)).setLabel('Close').setStyle(ButtonStyle.Danger),
  ))

  return { content: clip(notice, 1900), embeds: [embed], components }
}

/** Short account of what a save did, shown above the hub. Pure. */
export function noticeFor(task, updates, result) {
  const label = { status: 'status', scope: 'scope', title: 'title', description: 'description', assigneeIds: 'assignees', projectId: 'project', projectName: null, implementationStatus: 'implementation status', passedApiTests: 'API tests', passedQaTests: 'QA tests', passedAcceptanceCriteria: 'acceptance criteria' }
  const changed = [...new Set(Object.keys(updates).map((k) => (k in label ? label[k] : k)).filter(Boolean))]
  const lines = []
  if (changed.length) lines.push(`✅ Saved: ${changed.join(', ')}.`)
  for (const l of result?.dep?.lines || []) lines.push(`✅ ${l}`)
  if (result?.warning) lines.push(result.warning)
  const move = projectMoveNote(task, updates)
  if (move) lines.push(`⚠️ ${move}`)
  if (result?.notified?.created && result.notified.channelId) lines.push(`Channel created: <#${result.notified.channelId}>`)
  if (result?.notified?.dmed?.length) lines.push(`Notified ${result.notified.dmed.length} member(s) by DM.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- modals ----

/** "Edit details": five fields, the most a modal holds, prefilled from the task. */
export function buildEditModal(task) {
  const status = String(task.status || 'open')
  const scope = task.scope ? String(task.scope) : null
  const holders = holdersOf(task)

  const statusMenu = new StringSelectMenuBuilder().setCustomId('status').setRequired(true).setOptions(
    STATUS_OPTIONS.map((o) => new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value).setDefault(o.value === status)),
  )
  const scopeMenu = new StringSelectMenuBuilder().setCustomId('scope').setRequired(false).setPlaceholder('Not set').setMinValues(0).setMaxValues(1).setOptions(
    SCOPE_CHOICES.map((o) => new StringSelectMenuOptionBuilder().setLabel(o.name).setValue(o.value).setDefault(o.value === scope)),
  )
  const modal = new ModalBuilder()
    .setCustomId(`${EDIT_MODAL_PREFIX}${task.id}`)
    .setTitle(clip(`Edit: ${task.title || 'task'}`, 45))
    .addLabelComponents(
      new LabelBuilder().setLabel('Status').setStringSelectMenuComponent(statusMenu),
      new LabelBuilder().setLabel('Scope').setStringSelectMenuComponent(scopeMenu),
    )
  // A user select holds at most 25 people. Past that, leave assignees to the
  // slash command rather than silently dropping the extras on save.
  if (holders.length <= 25) {
    const people = new UserSelectMenuBuilder().setCustomId('assignees').setRequired(false).setPlaceholder('Nobody').setMinValues(0).setMaxValues(25)
    if (holders.length) people.setDefaultUsers(holders)
    modal.addLabelComponents(new LabelBuilder().setLabel('Assignees').setUserSelectMenuComponent(people))
  }
  modal.addLabelComponents(
    new LabelBuilder().setLabel('Title').setTextInputComponent(
      new TextInputBuilder().setCustomId('title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200).setValue(String(task.title || 'Untitled').slice(0, 200)),
    ),
  )
  const description = new TextInputBuilder().setCustomId('description').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(2000)
  if (task.description) description.setValue(String(task.description).slice(0, 2000))
  modal.addLabelComponents(new LabelBuilder().setLabel('Description').setTextInputComponent(description))
  return modal
}

/**
 * The updates a submitted "Edit details" modal amounts to: only fields that
 * differ from the task. Pure. `values.assignees` / `values.description` are
 * undefined when the modal had no such field.
 */
export function updatesFromModal(task, values) {
  const updates = {}
  const status = values.status
  if (status && status !== task.status) updates.status = status
  // No selection leaves the scope alone: clearing one is not offered here.
  if (values.scope && values.scope !== (task.scope ?? null)) updates.scope = values.scope
  const title = String(values.title ?? '').trim()
  if (title && title !== String(task.title ?? '')) updates.title = title
  if (values.description !== undefined) {
    const description = String(values.description ?? '').trim()
    if (description !== String(task.description ?? '').trim()) updates.description = description || null
  }
  if (values.assignees !== undefined) {
    const next = [...new Set(idList(values.assignees))]
    // Compared with who holds the task (a bug's tagged members count), so
    // opening and saving without touching the field writes nothing.
    if (!sameIds(next, holdersOf(task))) updates.assigneeIds = next
  }
  return updates
}

/** "Test counts": three optional whole numbers. */
export function buildCountsModal(task) {
  const field = (id, label, current) => {
    const input = new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(3).setPlaceholder('unchanged')
    if (current !== null && current !== undefined) input.setValue(String(current))
    return new LabelBuilder().setLabel(label).setTextInputComponent(input)
  }
  return new ModalBuilder()
    .setCustomId(`${COUNTS_MODAL_PREFIX}${task.id}`)
    .setTitle(clip(`Test counts: ${task.title || 'task'}`, 45))
    .addLabelComponents(
      field('api', 'API tests passed', task.passedApiTests),
      field('qa', 'QA tests passed', task.passedQaTests),
      field('ac', 'Acceptance criteria passed', task.passedAcceptanceCriteria),
    )
}

/**
 * Updates from a submitted counts modal. A blank field leaves that count alone;
 * anything that is not a whole number from 0 to MAX_TEST_COUNT is an error and
 * nothing is saved. Pure.
 * @returns {{ updates: object, error: string|null }}
 */
export function countsFromModal(task, values) {
  const map = [['api', 'passedApiTests'], ['qa', 'passedQaTests'], ['ac', 'passedAcceptanceCriteria']]
  const updates = {}
  for (const [key, column] of map) {
    const raw = String(values[key] ?? '').trim()
    if (!raw) continue
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > MAX_TEST_COUNT) {
      return { updates: {}, error: `Test counts must be whole numbers from 0 to ${MAX_TEST_COUNT}.` }
    }
    if (String(task[column] ?? '') !== String(Number(raw))) updates[column] = Number(raw)
  }
  return { updates, error: null }
}

const modalValues = (fields, id) => fields?.fields?.get?.(id)?.values ?? []

// -------------------------------------------------------------- handlers ----

const depsOf = (deps) => ({ db, getConfig: getOrCreateGuildConfig, notify: notifyTaskUpdate, ...deps })

const gone = { content: NOT_FOUND, embeds: [], components: [] }
const respond = (interaction, payload) =>
  (interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.update(payload))

/** Modal submits arrive from a hub button, so they update the hub in place. */
async function ack(interaction) {
  if (interaction.deferred || interaction.replied) return
  if (interaction.isFromMessage?.()) await interaction.deferUpdate()
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral })
}

const nameForIn = (interaction) => (id) => interaction.guild.members.cache.get(id)?.displayName ?? null

/** Draw the hub for `taskId` (or the "gone" message), optionally with a notice. */
export async function showHub(interaction, taskId, deps = {}, notice = '') {
  const d = depsOf(deps)
  const loaded = await loadHub(interaction, taskId, d)
  if (!loaded.task) return respond(interaction, gone)
  return respond(interaction, buildHubPayload({ ...loaded, notice, nameFor: nameForIn(interaction) }))
}

/** Save `updates` / a blocker change, then redraw the hub with what happened. */
async function saveAndShow(interaction, loaded, d, { updates = {}, blockedById = null, unblockId = null }) {
  let notice
  try {
    const result = await runUpdate(interaction, { db: d.db, notify: d.notify, cfg: loaded.cfg, task: loaded.task, updates, blockedById, unblockId })
    notice = result.error ? `❌ ${result.error}` : noticeFor(loaded.task, updates, result)
  } catch (e) {
    console.error('[task-hub]', e)
    notice = `❌ Update failed: ${e?.message ?? String(e)}`
  }
  return showHub(interaction, loaded.task.id, d, notice)
}

/** Every `uth_*` component on the hub. */
export async function handleHubComponent(interaction, deps = {}) {
  const d = depsOf(deps)
  const i = String(interaction.customId).indexOf(':')
  const action = String(interaction.customId).slice(0, i === -1 ? undefined : i).replace(/^uth_/, '')
  const taskId = i === -1 ? '' : String(interaction.customId).slice(i + 1)

  if (action === 'close') return respond(interaction, { content: 'Closed.', embeds: [], components: [] })
  if (action === 'back') {
    // Lazy: the finder imports this module, so a static import here would be a cycle.
    const { showFinder } = await import('./taskFinder.js')
    return showFinder(interaction, d)
  }

  const loaded = await loadHub(interaction, taskId, d)
  if (!loaded.task) return respond(interaction, gone)
  const value = interaction.values?.[0]

  if (action === 'basics') return interaction.showModal(buildEditModal(loaded.task))
  if (action === 'counts') return interaction.showModal(buildCountsModal(loaded.task))

  if (action === 'proj') {
    if (value === NONE) {
      if (!loaded.task.projectId) return showHub(interaction, taskId, d, 'Already in no project.')
      return saveAndShow(interaction, loaded, d, { updates: { projectId: null, projectName: null } })
    }
    const project = loaded.projects.find((p) => String(p.id) === value)
    if (!project) return showHub(interaction, taskId, d, '❌ That project no longer exists.')
    if (String(loaded.task.projectId ?? '') === String(project.id)) return showHub(interaction, taskId, d, `Already in ${project.name}.`)
    return saveAndShow(interaction, loaded, d, { updates: { projectId: project.id, projectName: project.name } })
  }
  if (action === 'impl') {
    if (value === loaded.task.implementationStatus) return showHub(interaction, taskId, d, 'No change.')
    return saveAndShow(interaction, loaded, d, { updates: { implementationStatus: value } })
  }
  if (action === 'block') return saveAndShow(interaction, loaded, d, { blockedById: value })
  if (action === 'unblock') return saveAndShow(interaction, loaded, d, { unblockId: value })
  return showHub(interaction, taskId, d)
}

/** The "Edit details" modal was submitted. */
export async function handleEditSubmit(interaction, deps = {}) {
  const d = depsOf(deps)
  await ack(interaction)
  const taskId = String(interaction.customId).slice(EDIT_MODAL_PREFIX.length)
  const loaded = await loadHub(interaction, taskId, d)
  if (!loaded.task) return interaction.editReply(gone)

  const f = interaction.fields
  const updates = updatesFromModal(loaded.task, {
    status: modalValues(f, 'status')[0],
    scope: modalValues(f, 'scope')[0],
    title: f.getTextInputValue('title'),
    description: f?.fields?.has?.('description') ? f.getTextInputValue('description') : undefined,
    assignees: f?.fields?.has?.('assignees') ? modalValues(f, 'assignees') : undefined,
  })
  if (Object.keys(updates).length === 0) return showHub(interaction, taskId, d, 'Nothing changed.')
  return saveAndShow(interaction, loaded, d, { updates })
}

/** The "Test counts" modal was submitted. */
export async function handleCountsSubmit(interaction, deps = {}) {
  const d = depsOf(deps)
  await ack(interaction)
  const taskId = String(interaction.customId).slice(COUNTS_MODAL_PREFIX.length)
  const loaded = await loadHub(interaction, taskId, d)
  if (!loaded.task) return interaction.editReply(gone)

  const f = interaction.fields
  const { updates, error } = countsFromModal(loaded.task, {
    api: f.getTextInputValue('api'), qa: f.getTextInputValue('qa'), ac: f.getTextInputValue('ac'),
  })
  if (error) return showHub(interaction, taskId, d, `❌ ${error}`)
  if (Object.keys(updates).length === 0) return showHub(interaction, taskId, d, 'Nothing changed.')
  return saveAndShow(interaction, loaded, d, { updates })
}
