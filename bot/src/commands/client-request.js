import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { createClientRequest, clientProjects } from '../services/clientRequest.js'
import { projectChoices } from './update-task.js'

// Two commands, one implementation. `data` is an array: one module can back
// several slash commands (see meetingReview.js).

function builder(name, description, what) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addStringOption((o) => o.setName('title').setDescription('A short title').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('details').setDescription(what).setRequired(true).setMaxLength(2000))
    .addStringOption((o) => o.setName('project').setDescription('Which project (needed only if you are on more than one)').setRequired(false).setAutocomplete(true))
    .addAttachmentOption((o) => o.setName('document').setDescription('A document to attach').setRequired(false))
    .addAttachmentOption((o) => o.setName('document2').setDescription('Another document').setRequired(false))
    .addAttachmentOption((o) => o.setName('document3').setDescription('Another document').setRequired(false))
}

export const data = [
  builder('report-issue', 'Report something that is broken', 'What happens, and what you expected'),
  builder('request-feature', 'Ask for something new', 'What you need and why'),
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
  const type = interaction.commandName === 'report-issue' ? 'bug' : 'feature'
  const title = interaction.options.getString('title')
  const details = interaction.options.getString('details')
  const picked = interaction.options.getString('project')
  const attachments = ['document', 'document2', 'document3'].map((n) => interaction.options.getAttachment(n)).filter(Boolean)

  const rows = await dbArg.projectMember.findByMember({ where: { guildConfigId: cfg.id, discordId: interaction.user.id } })
  const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
  const { project, error } = resolveProject({ rows, projects, picked })
  if (error === 'foreign') return interaction.editReply({ content: 'You are not a client on that project. Leave `project` empty, or start typing to pick one of yours.' })
  if (error === 'pick') return interaction.editReply({ content: 'You are on more than one project — start typing in the `project` option to pick which one this is for.' })

  const out = await create({
    guild, client: interaction.client, user: interaction.user, cfg, type, title, details, project, attachments, db: dbArg,
  })
  const noun = type === 'bug' ? 'issue' : 'request'
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
