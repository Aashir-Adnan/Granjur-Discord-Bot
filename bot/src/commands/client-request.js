import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { createClientRequest, clientProjects, composeDetails, ISSUE_FIELDS, FEATURE_FIELDS, TASK_FIELDS } from '../services/clientRequest.js'
import { projectChoices } from './update-task.js'

// Two commands, one implementation. `data` is an array: one module can back
// several slash commands (see meetingReview.js).

// Two screenshots and one document: the pictures are what a report most often
// lacks, and a log or a spec still has a slot.
const ATTACHMENTS = [
  ['screenshot', 'A screenshot of it'],
  ['screenshot2', 'Another screenshot'],
  ['document', 'A document (log, spec, PDF)'],
]

// Discord wants required options first; then the structured fields in the
// table's order, then project, then the attachments.
function builder(name, description, what, fields) {
  const b = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addStringOption((o) => o.setName('title').setDescription('A short title').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('details').setDescription(what).setRequired(true).setMaxLength(2000))
  for (const f of fields) {
    b.addStringOption((o) => {
      o.setName(f.name).setDescription(f.description).setRequired(false)
      if (f.kind === 'choice') o.addChoices(...f.choices.map((c) => ({ name: c, value: c })))
      else o.setMaxLength(f.max)
      return o
    })
  }
  b.addStringOption((o) => o.setName('project').setDescription('Which project (needed only if you are on more than one)').setRequired(false).setAutocomplete(true))
  for (const [n, d] of ATTACHMENTS) b.addAttachmentOption((o) => o.setName(n).setDescription(d).setRequired(false))
  return b
}

// The three kinds a client can raise, by the command they typed. A support
// task — the team handling data at a level an admin cannot — is its own kind.
const COMMAND_KIND = { 'report-issue': 'bug', 'request-feature': 'feature', 'request-task': 'task' }
const FIELDS_BY_KIND = { bug: ISSUE_FIELDS, feature: FEATURE_FIELDS, task: TASK_FIELDS }
const NOUN = { bug: 'issue', feature: 'request', task: 'support task' }

export const data = [
  builder('report-issue', 'Report something that is broken', 'What happens (the other fields are optional, but save a round of questions)', ISSUE_FIELDS),
  builder('request-feature', 'Ask for something new', 'What you need and why', FEATURE_FIELDS),
  builder('request-task', 'Ask the team to handle data an admin cannot', 'What needs doing, and to which data (the other fields are optional)', TASK_FIELDS),
]

/**
 * Which project the request belongs to. Pure.
 * @returns {{project: object|null, error: null|'pick'|'foreign'}}
 */
export function resolveProject({ rows, projects, picked }) {
  const mine = clientProjects(rows)
  const byId = new Map((projects ?? []).map((p) => [String(p.id), p]))
  if (picked) {
    const ok = mine.some((r) => String(r.projectId) === String(picked)) && byId.has(String(picked))
    return ok ? { project: byId.get(String(picked)), error: null } : { project: null, error: 'foreign' }
  }
  const candidates = mine.map((r) => byId.get(String(r.projectId))).filter(Boolean)
  if (candidates.length === 0) return { project: null, error: null }
  if (candidates.length === 1) return { project: candidates[0], error: null }
  return { project: null, error: 'pick' }
}

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig, create = createClientRequest } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })
  const cfg = await getConfig(guild.id)
  const type = COMMAND_KIND[interaction.commandName] ?? 'feature'
  const title = interaction.options.getString('title')
  const fields = FIELDS_BY_KIND[type]
  const values = Object.fromEntries(fields.map((f) => [f.name, interaction.options.getString(f.name)]))
  const details = composeDetails(fields, values, interaction.options.getString('details'))
  const picked = interaction.options.getString('project')
  const attachments = ATTACHMENTS.map(([n]) => interaction.options.getAttachment(n)).filter(Boolean)

  const rows = await dbArg.projectMember.findByMember({ where: { guildConfigId: cfg.id, discordId: interaction.user.id } })
  const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
  const { project, error } = resolveProject({ rows, projects, picked })
  if (error === 'foreign') return interaction.editReply({ content: 'You are not a client on that project. Leave `project` empty, or start typing to pick one of yours.' })
  if (error === 'pick') return interaction.editReply({ content: 'You are on more than one project — start typing in the `project` option to pick which one this is for.' })

  const out = await create({
    guild, client: interaction.client, user: interaction.user, cfg, type, title, details, project, attachments, db: dbArg,
  })
  const noun = NOUN[type]
  return interaction.editReply({
    content: `Your ${noun} **${out.task.title}** is raised. Its channel is <#${out.channel.id}> — the team will reply there, and you will be messaged when its status changes. See it any time with **/my-requests**.`,
  })
}

export async function autocomplete(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'project') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getConfig(interaction.guild.id)
    const rows = clientProjects(await dbArg.projectMember.findByMember({ where: { guildConfigId: cfg.id, discordId: interaction.user.id } }))
    const ids = new Set(rows.map((r) => String(r.projectId)))
    const projects = (await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })).filter((p) => ids.has(String(p.id)))
    return interaction.respond(projectChoices(projects, focused.value, { withDetach: false })).catch(() => {})
  } catch (e) {
    console.error('[client-request] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}
