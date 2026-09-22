// /my-time: your tracked time, and a way to fix or delete an entry.
//
// It follows the task hub (services/taskHub.js): one message that is redrawn
// after every action, state in the custom ids (`mt_<action>:<entryId>`, the
// select `mt_pick` carries the picked entry in its VALUE), nothing held in
// memory. The Edit button opens a modal; the modal submit is answered with
// deferUpdate so the panel message is edited in place.
//
// Access is decided per interaction from the entry row itself, never from the
// custom id: the entry's owner may act on it, and so may leadership (CEO /
// Server Manager / administrators). Anyone else is refused and nothing changes.
// Only CLOSED entries can be edited or deleted here; a running timer is stopped
// with /clock-out.

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder, MessageFlags, ModalBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { isLeadershipFor } from '../utils/timeAccess.js'
import { isValidZone } from '../utils/timezone.js'
import { entryMinutes, formatDuration, parseDuration, rangeFor, sumByTask } from '../utils/timeTracking.js'
import { BAD_DURATION, resolveEntryWindow } from '../commands/log-time.js'
import { recordTaskActivity } from './taskActivity.js'

export const EDIT_MODAL_PREFIX = 'mt_edit:'
/** Rows read for one panel. When exactly this many come back the list is cut off. */
export const FETCH_LIMIT = 2000
const LISTED = 10 // recent entries shown in the embed
const OPTIONS = 25 // a select holds at most 25
const NOT_YOURS = "That entry isn't yours."
const GONE = 'That entry no longer exists.'
const RUNNING = 'That timer is still running. Stop it with **/clock-out** first.'

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
const day = (d) => new Date(d).toISOString().slice(0, 10)
const hhmm = (d) => new Date(d).toISOString().slice(11, 16)
const isClosed = (e) => e && e.minutes !== null && e.minutes !== undefined
const SOURCE_FLAG = { auto_stopped: 'auto-stopped', manual: 'manual' }

// ----------------------------------------------------------------- payload ----

/**
 * The panel message. Pure apart from building discord.js objects.
 * `selected` is a closed entry the person picked: it is shown selected, with
 * Edit and Delete buttons, even when it falls outside the listed range.
 */
export function buildMyTimePayload({
  entries, tasks, running = null, range, nameFor = () => null,
  ownerId = null, viewerId = null, selected = null, notice = '', truncated = false, now = new Date(),
}) {
  const titles = new Map((tasks || []).map((t) => [String(t.id), t.title || 'Untitled']))
  const labelOf = (taskId) => (taskId ? (titles.get(String(taskId)) ?? 'Deleted task') : 'General')

  const closed = (entries || []).filter(isClosed)
  const totals = [...sumByTask(closed).entries()].sort((a, b) => b[1] - a[1])
  const grand = totals.reduce((n, [, m]) => n + m, 0)

  const mine = !ownerId || ownerId === viewerId
  const who = mine ? 'Your time' : `Time — ${nameFor(ownerId) || `<@${ownerId}>`}`
  const lines = []
  if (running) {
    lines.push(`⏱ Running now: **${clip(labelOf(running.taskId), 80)}** — ${formatDuration(entryMinutes(running.clockInAt, now) ?? 0)}`)
  }
  lines.push(`**Total ${range.label}: ${formatDuration(grand)}**`)
  if (truncated) lines.push(`Limited to the latest ${FETCH_LIMIT} entries — narrow the range.`)

  const embed = new EmbedBuilder().setTitle(clip(who, 250)).setColor(0x5865f2).setDescription(lines.join('\n'))

  if (totals.length) {
    const shown = totals.slice(0, 15).map(([taskId, m]) => `• **${clip(labelOf(taskId), 60)}** — ${formatDuration(m)}`)
    if (totals.length > 15) shown.push(`…and ${totals.length - 15} more`)
    embed.addFields({ name: 'By task', value: clip(shown.join('\n'), 1000), inline: false })
  } else {
    embed.addFields({ name: 'By task', value: 'No time logged in this range.', inline: false })
  }

  if (closed.length) {
    const recent = closed.slice(0, LISTED).map((e) => {
      const flag = SOURCE_FLAG[e.source] ? ` · ${SOURCE_FLAG[e.source]}` : ''
      return `• ${day(e.clockInAt)} · **${formatDuration(e.minutes)}** · ${clip(labelOf(e.taskId), 40)}${flag}`
    })
    if (closed.length > LISTED) recent.push(`…and ${closed.length - LISTED} more (pick from the list below)`)
    embed.addFields({ name: 'Recent entries', value: clip(recent.join('\n'), 1000), inline: false })
  }

  if (selected) {
    const note = selected.note ? `\n${clip(selected.note, 300)}` : ''
    embed.addFields({
      name: 'Selected',
      value: clip(`**${clip(labelOf(selected.taskId), 80)}** — ${formatDuration(selected.minutes)}, ${day(selected.clockInAt)} ${hhmm(selected.clockInAt)}–${hhmm(selected.clockOutAt)} UTC${note}`, 1000),
      inline: false,
    })
  }

  const components = []
  const seen = new Set()
  const pickable = []
  for (const e of [selected, ...closed]) {
    if (!isClosed(e) || seen.has(String(e.id))) continue
    seen.add(String(e.id))
    pickable.push(e)
    if (pickable.length === OPTIONS) break
  }
  if (pickable.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('mt_pick').setPlaceholder('Pick an entry to edit or delete').setOptions(
        pickable.map((e) => {
          const option = new StringSelectMenuOptionBuilder()
            .setLabel(clip(`${day(e.clockInAt)} · ${formatDuration(e.minutes)} · ${labelOf(e.taskId)}`, 100))
            .setValue(String(e.id))
            .setDefault(Boolean(selected) && String(e.id) === String(selected.id))
          const about = e.note || SOURCE_FLAG[e.source]
          if (about) option.setDescription(clip(about, 100))
          return option
        }),
      ),
    ))
  }
  if (selected) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mt_edit:${selected.id}`).setLabel('Edit').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`mt_delete:${selected.id}`).setLabel('Delete').setStyle(ButtonStyle.Danger),
    ))
  }

  return { content: clip(notice, 1900), embeds: [embed], components }
}

/** The Edit form: duration, an optional day, and the note; prefilled from the entry. */
export function buildEditModal(entry) {
  const note = new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
  if (entry.note) note.setValue(String(entry.note).slice(0, 500))
  return new ModalBuilder()
    .setCustomId(`${EDIT_MODAL_PREFIX}${entry.id}`)
    .setTitle('Edit time entry')
    .addLabelComponents(
      new LabelBuilder().setLabel('Duration (2h30m, 90m, 2.5h, 1:30)').setTextInputComponent(
        new TextInputBuilder().setCustomId('duration').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)
          .setValue(formatDuration(entry.minutes)),
      ),
      new LabelBuilder().setLabel('Day it ended (blank keeps it)').setTextInputComponent(
        new TextInputBuilder().setCustomId('when').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20)
          .setPlaceholder('today, yesterday or YYYY-MM-DD'),
      ),
      new LabelBuilder().setLabel('Note').setTextInputComponent(note),
    )
}

// ---------------------------------------------------------------- plumbing ----

const depsOf = (deps) => ({ db, getConfig: getOrCreateGuildConfig, ...deps })
const nowOf = (d) => d.now ?? new Date()
const respond = (interaction, payload) =>
  (interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.update(payload))
const nameForIn = (interaction) => (id) => interaction.guild.members.cache.get(id)?.displayName ?? null

/** Modal submits arrive from a panel button, so they update the panel in place. */
async function ack(interaction) {
  if (interaction.deferred || interaction.replied) return
  if (interaction.isFromMessage?.()) await interaction.deferUpdate()
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral })
}

/**
 * Draw the panel for `ownerId`. `rangeKey` is today | week | month | all; a
 * redraw after an action always uses the default week.
 */
export async function showTimePanel(interaction, { ownerId, rangeKey = 'week', selected = null, notice = '', cfg = null } = {}, deps = {}) {
  const d = depsOf(deps)
  const guild = interaction.guild
  const config = cfg ?? await d.getConfig(guild.id)
  const now = nowOf(d)
  // The server's zone decides where "today" and "this week" begin.
  const range = rangeFor(rangeKey, now, isValidZone(config.timezone) ? config.timezone : 'UTC')

  const [rows, running] = await Promise.all([
    d.db.clockEntry.findMany({
      where: { guildConfigId: config.id, discordId: ownerId, since: range.since, until: range.until },
      take: FETCH_LIMIT,
    }),
    d.db.clockEntry.findActive(guild.id, ownerId),
  ])
  const entries = rows || []

  const ids = [...new Set([...entries.map((e) => e.taskId), running?.taskId, selected?.taskId].filter(Boolean).map(String))]
  const tasks = ids.length ? await d.db.task.findByIds({ where: { guildConfigId: config.id, ids } }) : []

  return respond(interaction, buildMyTimePayload({
    entries, tasks, running, range, nameFor: nameForIn(interaction),
    ownerId, viewerId: interaction.user.id, selected, notice,
    truncated: entries.length === FETCH_LIMIT, now,
  }))
}

/**
 * The entry, only if this person may act on it: the owner or leadership, in this
 * server, and closed. Otherwise `error` says why and nothing may be changed.
 */
async function loadOwned(interaction, entryId, d) {
  const cfg = await d.getConfig(interaction.guild.id)
  const entry = entryId ? await d.db.clockEntry.findById(entryId) : null
  if (!entry) return { cfg, error: GONE }
  // An entry of another server is treated exactly like somebody else's.
  if (entry.guildConfigId !== cfg.id) return { cfg, error: NOT_YOURS }
  if (entry.discordId !== interaction.user.id && !isLeadershipFor(interaction.guild, interaction.member, cfg)) {
    return { cfg, error: NOT_YOURS }
  }
  if (!isClosed(entry)) return { cfg, error: RUNNING }
  return { cfg, entry }
}

/** A refusal: the caller's own panel with the reason above it; nothing changed. */
function refuse(interaction, cfg, error, d) {
  return showTimePanel(interaction, { ownerId: interaction.user.id, notice: `❌ ${error}`, cfg }, d)
}

/** The task row an entry points at, or null for general work / a deleted task. */
async function taskOf(d, cfg, entry) {
  if (!entry.taskId) return null
  return d.db.task.findFirst({ where: { id: entry.taskId, guildConfigId: cfg.id } }).catch(() => null)
}

/** Log a change of time on the task, when the entry has a task that still exists. */
async function recordTime(interaction, d, task, change) {
  if (!task) return
  await recordTaskActivity({ db: d.db, task, changes: [change], actor: { discordId: interaction.user.id } })
}

const targetOf = (task, entry) => (task ? `**${task.title}**` : entry.taskId ? 'a deleted task' : 'general work')

// ---------------------------------------------------------------- handlers ----

/** Every `mt_*` button and select on the panel. */
export async function handleTimeComponent(interaction, deps = {}) {
  const d = depsOf(deps)
  const raw = String(interaction.customId)
  const i = raw.indexOf(':')
  const action = raw.slice(0, i === -1 ? undefined : i).replace(/^mt_/, '')
  const entryId = action === 'pick' ? interaction.values?.[0] : (i === -1 ? '' : raw.slice(i + 1))

  const loaded = await loadOwned(interaction, entryId, d)
  if (loaded.error) return refuse(interaction, loaded.cfg, loaded.error, d)
  const { cfg, entry } = loaded

  if (action === 'pick') {
    return showTimePanel(interaction, { ownerId: entry.discordId, selected: entry, cfg }, d)
  }
  if (action === 'edit') return interaction.showModal(buildEditModal(entry))

  if (action === 'delete') {
    const task = await taskOf(d, cfg, entry)
    let notice
    try {
      const res = await d.db.clockEntry.remove(entry.id)
      if (res?.removed === 0) {
        notice = 'That entry was already deleted.'
      } else {
        notice = `🗑 Deleted ${formatDuration(entry.minutes)} on ${targetOf(task, entry)}.`
        await recordTime(interaction, d, task, { field: 'time', action: 'deleted', minutes: entry.minutes, personId: entry.discordId })
      }
    } catch (e) {
      console.error('[my-time] delete:', e)
      notice = `❌ Delete failed: ${e?.message ?? String(e)}`
    }
    return showTimePanel(interaction, { ownerId: entry.discordId, notice, cfg }, d)
  }
  return showTimePanel(interaction, { ownerId: entry.discordId, cfg }, d)
}

/**
 * "Current time of day" for a moved entry: today's date at the entry's own UTC
 * time of day, so "today", "yesterday" and a typed date all keep that time.
 */
function timeOfDaySource(now, clockOutAt) {
  const at = new Date(now)
  const old = new Date(clockOutAt)
  at.setUTCHours(old.getUTCHours(), old.getUTCMinutes(), old.getUTCSeconds(), old.getUTCMilliseconds())
  return at
}

/** The Edit modal was submitted. */
export async function handleTimeEditSubmit(interaction, deps = {}) {
  const d = depsOf(deps)
  await ack(interaction)
  const entryId = String(interaction.customId).slice(EDIT_MODAL_PREFIX.length)
  const loaded = await loadOwned(interaction, entryId, d)
  if (loaded.error) return refuse(interaction, loaded.cfg, loaded.error, d)
  const { cfg, entry } = loaded

  // Every problem below redraws the owner's panel with the entry still selected,
  // so the edit can be retried; none of them writes anything.
  const back = (notice) => showTimePanel(interaction, { ownerId: entry.discordId, selected: entry, notice, cfg }, d)

  const f = interaction.fields
  const minutes = parseDuration(f.getTextInputValue('duration'))
  if (minutes === null) return back(`❌ ${BAD_DURATION}`)

  const now = nowOf(d)
  const oldOut = new Date(entry.clockOutAt)
  const whenText = String(f.getTextInputValue('when') ?? '').trim()
  // Blank keeps the entry's own end; otherwise the day moves and the UTC time of
  // day stays. The future check is against the real now either way.
  const resolved = resolveEntryWindow(minutes, whenText || 'today', {
    now,
    clockSource: whenText ? timeOfDaySource(now, oldOut) : oldOut,
  })
  if (resolved.error) return back(`❌ ${resolved.error}`)
  const { window } = resolved
  const newMinutes = entryMinutes(window.clockInAt, window.clockOutAt)

  const note = String(f.getTextInputValue('note') ?? '').trim() || null
  const sameNote = note === (String(entry.note ?? '').trim() || null)
  if (newMinutes === entry.minutes && window.clockOutAt.getTime() === oldOut.getTime() && sameNote) {
    return back('Nothing changed.')
  }

  const task = await taskOf(d, cfg, entry)
  const update = { clockInAt: window.clockInAt, clockOutAt: window.clockOutAt, minutes: newMinutes, note }
  try {
    await d.db.clockEntry.update(entry.id, update)
  } catch (e) {
    console.error('[my-time] edit:', e)
    return back(`❌ Update failed: ${e?.message ?? String(e)}`)
  }
  // Only a change of the time itself is a change worth logging on the task.
  if (newMinutes !== entry.minutes) {
    await recordTime(interaction, d, task, { field: 'time', action: 'edited', from: entry.minutes, to: newMinutes, personId: entry.discordId })
  }

  const notice = `✅ Saved: ${formatDuration(newMinutes)} on ${targetOf(task, entry)}, ending ${day(window.clockOutAt)}.`
  return showTimePanel(interaction, { ownerId: entry.discordId, selected: { ...entry, ...update }, notice, cfg }, d)
}
