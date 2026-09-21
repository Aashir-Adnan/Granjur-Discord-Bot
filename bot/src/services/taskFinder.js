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
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder, EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { holdersOf } from '../utils/taskLabel.js'
import { scopeLabel } from '../utils/taskScope.js'
import { canSeeTask } from '../commands/update-task.js'
import { childStats } from '../utils/taskHierarchy.js'
import { context, showHub } from './taskHub.js'

export const PAGE_SIZE = 25
const NONE = '-'
const TERMINAL = new Set(['resolved', 'closed', 'done'])

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
  const stats = childStats(rows)
  const titleOf = new Map((rows || []).map((t) => [String(t.id), t.title]))

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
          // A subtask says whose it is; a parent says how far along it is.
          const sub = t.parentTaskId ? `↳ ${titleOf.get(String(t.parentTaskId)) ?? 'a task'}` : null
          const st = stats.get(String(t.id))
          const progress = st ? `${st.done}/${st.total} subtasks` : null
          const bits = [String(t.status || 'open'), scopeLabel(t.scope), sub ?? proj, who, progress].filter(Boolean)
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

// ------------------------------------------------------------- handlers ----

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
    // Picking a task opens its hub: the message with every editable property.
    return showHub(interaction, interaction.values?.[0], d)
  }

  const next = { ...state }
  if (action === 'proj') { next.project = interaction.values?.[0] === NONE ? null : (interaction.values?.[0] ?? null); next.page = 0 }
  else if (action === 'person') { next.person = interaction.values?.[0] ?? null; next.page = 0 }
  // prev / next / done / anyone carry their target state in their own id.
  return respond(interaction, await panelFor(interaction, next, d))
}
