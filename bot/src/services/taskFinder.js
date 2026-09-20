// The interactive way into /update-task: a "Find a task" panel (project and
// person filters, a task list with paging) and an Edit modal for the common
// fields. `/update-task` with no arguments opens the panel; naming a task on
// the command line still works exactly as before.
//
// Why a panel rather than more slash options: the filter options sat at the end
// of a 17-option command and only applied if filled *before* typing in `task`,
// which nobody knew. Here the filters are the first thing on screen.
//
// State lives in the components' custom ids (`utf_<action>:<project>:<person>:<page>:<done>`),
// so nothing is held in memory and a restart cannot orphan a panel.

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, LabelBuilder, ModalBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle,
  UserSelectMenuBuilder, EmbedBuilder, MessageFlags,
} from 'discord.js'
import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'
import { holdersOf, idList } from '../utils/taskLabel.js'
import { memberPassesRoleGate, LEADERSHIP_ROLE_NAMES } from '../utils/roleGate.js'
import { SCOPE_CHOICES, scopeLabel } from '../utils/taskScope.js'
import { notifyTaskUpdate } from './taskUpdateNotify.js'
import { canSeeTask, commitUpdate, sameIds } from '../commands/update-task.js'

export const PAGE_SIZE = 25
export const EDIT_MODAL_PREFIX = 'ut_edit:'
const NONE = '-'
const STATUS_OPTIONS = [
  { label: 'Open', value: 'open' },
  { label: 'Pending', value: 'pending' },
  { label: 'In progress', value: 'in_progress' },
  { label: 'Resolved', value: 'resolved' },
  { label: 'Closed', value: 'closed' },
  { label: 'Done', value: 'done' },
]
const TERMINAL = new Set(['resolved', 'closed', 'done'])
const NOT_FOUND = 'That task is not available to you any more. Run **/update-task** again.'

// ---------------------------------------------------------------- state ----

/** @typedef {{ project: string|null, person: string|null, page: number, done: boolean }} FinderState */

/** @returns {FinderState} */
export function defaultState() {
  return { project: null, person: null, page: 0, done: false }
}

export function encodeState(s) {
  return [s.project || NONE, s.person || NONE, Math.max(0, s.page | 0), s.done ? 1 : 0].join(':')
}

/** Inverse of encodeState; anything malformed falls back to the default. */
export function decodeState(raw) {
  const [project, person, page, done] = String(raw ?? '').split(':')
  const n = Number.parseInt(page, 10)
  return {
    project: project && project !== NONE ? project : null,
    person: person && person !== NONE ? person : null,
    page: Number.isFinite(n) && n > 0 ? n : 0,
    done: done === '1',
  }
}

/** `utf_<action>:<state>` -> { action, state } */
export function parseFinderId(customId) {
  const i = String(customId).indexOf(':')
  const head = i === -1 ? String(customId) : String(customId).slice(0, i)
  return { action: head.replace(/^utf_/, ''), state: decodeState(i === -1 ? '' : String(customId).slice(i + 1)) }
}
const idFor = (action, state) => `utf_${action}:${encodeState(state)}`

// -------------------------------------------------------------- filtering ----

/**
 * The tasks the panel lists. Pure. Someone who is not leadership only ever
 * sees tasks they hold (same rule as the slash command), and finished tasks
 * stay hidden until asked for — they are most of the list after a few months.
 */
export function filterTasks(rows, { project, person, done, isLeadership, callerId }) {
  return (rows || []).filter((t) => {
    if (!canSeeTask(t, { isLeadership, callerId })) return false
    if (!done && TERMINAL.has(String(t.status))) return false
    if (project && String(t.projectId ?? '') !== project) return false
    if (person && !holdersOf(t).includes(person)) return false
    return true
  })
}

export function pageOf(rows, page) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const p = Math.min(Math.max(0, page | 0), pages - 1)
  return { items: rows.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), page: p, pages }
}

// ------------------------------------------------------------- the panel ----

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))

/**
 * The panel's message payload. Pure apart from building discord.js objects.
 * @param {{ rows: object[], projects: object[], state: FinderState, isLeadership: boolean, callerId: string, nameFor?: (id: string) => string|null, loaded?: number }} a
 */
export function buildFinderPayload({ rows, projects, state, isLeadership, callerId, nameFor = () => null }) {
  const matches = filterTasks(rows, { ...state, isLeadership, callerId })
  const { items, page, pages } = pageOf(matches, state.page)
  const s = { ...state, page }
  const projectName = new Map((projects || []).map((p) => [String(p.id), String(p.name || '')]))

  const components = []

  const projectOptions = [
    new StringSelectMenuOptionBuilder().setLabel('All projects').setValue(NONE).setDefault(!s.project),
    ...[...(projects || [])]
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }))
      .slice(0, 24)
      .map((p) => new StringSelectMenuOptionBuilder().setLabel(clip(p.name || p.id, 100)).setValue(String(p.id)).setDefault(String(p.id) === s.project)),
  ]
  components.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(idFor('proj', s)).setPlaceholder('Project').setOptions(projectOptions),
  ))

  // Only leadership can see anyone's tasks, so only they get a person filter.
  if (isLeadership) {
    const person = new UserSelectMenuBuilder().setCustomId(idFor('person', s)).setPlaceholder('Assigned to (anyone)').setMinValues(1).setMaxValues(1)
    if (s.person) person.setDefaultUsers(s.person)
    components.push(new ActionRowBuilder().addComponents(person))
  }

  if (items.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(idFor('task', s))
        .setPlaceholder(`Pick a task (${matches.length} match${matches.length === 1 ? '' : 'es'})`)
        .setOptions(items.map((t) => {
          const who = holdersOf(t).map((id) => nameFor(id) || id).join(', ') || 'unassigned'
          const proj = projectName.get(String(t.projectId ?? ''))
          const bits = [String(t.status || 'open'), scopeLabel(t.scope), proj, who].filter(Boolean)
          return new StringSelectMenuOptionBuilder()
            .setLabel(clip(t.title || t.id, 100))
            .setValue(String(t.id))
            .setDescription(clip(bits.join(' · '), 100))
        })),
    ))
  }

  const buttons = [
    new ButtonBuilder().setCustomId(idFor('prev', { ...s, page: page - 1 })).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(idFor('next', { ...s, page: page + 1 })).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId(idFor('done', { ...s, page: 0, done: !s.done })).setLabel(s.done ? 'Hide finished' : 'Show finished').setStyle(ButtonStyle.Secondary),
  ]
  if (isLeadership && s.person) buttons.push(new ButtonBuilder().setCustomId(idFor('anyone', { ...s, person: null, page: 0 })).setLabel('Anyone').setStyle(ButtonStyle.Secondary))
  buttons.push(new ButtonBuilder().setCustomId(idFor('close', s)).setLabel('Close').setStyle(ButtonStyle.Danger))
  components.push(new ActionRowBuilder().addComponents(buttons))

  const embed = new EmbedBuilder()
    .setTitle('Find a task')
    .setDescription(
      matches.length
        ? `${matches.length} task${matches.length === 1 ? '' : 's'}${s.done ? '' : ' (finished ones hidden)'} · page ${page + 1} of ${pages}\nPick one below to edit it.`
        : `No tasks match these filters${s.done ? '' : ' (finished ones are hidden)'}.`,
    )
    .setColor(0x5865f2)
  return { embeds: [embed], components, content: '' }
}

// ------------------------------------------------------------- the modal ----

/** The Edit modal, prefilled from the task. Five fields: the most a modal holds. */
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
 * The updates a submitted modal amounts to: only fields that differ from the
 * task. Pure. `values.assignees` is undefined when the modal had no such field.
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

const modalValues = (fields, id) => fields?.fields?.get?.(id)?.values ?? []

// ------------------------------------------------------------- handlers ----

async function context(interaction, { db: dbArg, getConfig }) {
  const cfg = await getConfig(interaction.guild.id)
  const isLeadership = memberPassesRoleGate(interaction.guild, interaction.member, ensureStringArray(cfg.dashboardRoleIds), LEADERSHIP_ROLE_NAMES)
  return { cfg, isLeadership }
}

async function panelFor(interaction, state, { db: dbArg, getConfig }) {
  const { cfg, isLeadership } = await context(interaction, { db: dbArg, getConfig })
  const [rows, projects] = await Promise.all([
    dbArg.task.findMany({ where: { guildConfigId: cfg.id }, orderBy: { updatedAt: 'desc' }, take: 200 }),
    dbArg.project.findMany({ where: { guildConfigId: cfg.id } }).catch(() => []),
  ])
  // Names come from the cache only: this must answer inside Discord's window.
  const nameFor = (id) => interaction.guild.members.cache.get(id)?.displayName ?? null
  return buildFinderPayload({ rows, projects, state, isLeadership, callerId: interaction.user.id, nameFor })
}

const respond = (interaction, payload) =>
  (interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.update(payload))

/** `/update-task` with nothing picked: open the panel. `interaction` is already deferred. */
export async function showFinder(interaction, deps = {}) {
  const d = { db, getConfig: getOrCreateGuildConfig, ...deps }
  return interaction.editReply(await panelFor(interaction, defaultState(), d))
}

/** Every `utf_*` component: filters, paging, close, and picking a task. */
export async function handleFinderComponent(interaction, deps = {}) {
  const d = { db, getConfig: getOrCreateGuildConfig, ...deps }
  const { action, state } = parseFinderId(interaction.customId)

  if (action === 'close') {
    return respond(interaction, { embeds: [], components: [], content: 'Closed.' })
  }

  if (action === 'task') {
    // Opens a modal, so this component is not deferred (see index.js).
    const taskId = interaction.values?.[0]
    const { cfg, isLeadership } = await context(interaction, d)
    const task = taskId ? await d.db.task.findFirst({ where: { id: taskId, guildConfigId: cfg.id } }) : null
    if (!task || !canSeeTask(task, { isLeadership, callerId: interaction.user.id })) {
      return interaction.reply({ content: NOT_FOUND, flags: MessageFlags.Ephemeral })
    }
    return interaction.showModal(buildEditModal(task))
  }

  const next = { ...state }
  if (action === 'proj') { next.project = interaction.values?.[0] === NONE ? null : (interaction.values?.[0] ?? null); next.page = 0 }
  else if (action === 'person') { next.person = interaction.values?.[0] ?? null; next.page = 0 }
  // prev / next / done / anyone carry their target state in their own id.
  return respond(interaction, await panelFor(interaction, next, d))
}

/** The Edit modal was submitted. `interaction` is already deferred (ephemeral). */
export async function handleEditSubmit(interaction, deps = {}) {
  const d = { db, getConfig: getOrCreateGuildConfig, notify: notifyTaskUpdate, ...deps }
  const taskId = String(interaction.customId).slice(EDIT_MODAL_PREFIX.length)
  const { cfg, isLeadership } = await context(interaction, d)
  const task = await d.db.task.findFirst({ where: { id: taskId, guildConfigId: cfg.id } })
  if (!task || !canSeeTask(task, { isLeadership, callerId: interaction.user.id })) {
    return interaction.editReply({ content: NOT_FOUND })
  }
  const f = interaction.fields
  const hasAssignees = Boolean(f?.fields?.has?.('assignees'))
  const updates = updatesFromModal(task, {
    status: modalValues(f, 'status')[0],
    scope: modalValues(f, 'scope')[0],
    title: f.getTextInputValue('title'),
    description: f?.fields?.has?.('description') ? f.getTextInputValue('description') : undefined,
    assignees: hasAssignees ? modalValues(f, 'assignees') : undefined,
  })
  if (Object.keys(updates).length === 0) {
    return interaction.editReply({ content: 'Nothing changed.' })
  }
  return commitUpdate(interaction, { db: d.db, notify: d.notify, cfg, task, updates })
}
