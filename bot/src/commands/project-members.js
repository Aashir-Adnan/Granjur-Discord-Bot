import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig, PROJECT_MEMBER_ROLES } from '../db/index.js'
import { projectChoices } from './update-task.js'
import { holdersOf } from '../utils/taskLabel.js'

const ROLE_LABEL = { lead: 'Lead', developer: 'Developer', qa: 'QA', design: 'Design' }
const roleChoices = PROJECT_MEMBER_ROLES.map((r) => ({ name: ROLE_LABEL[r], value: r }))
const projectOpt = (o) => o.setName('project').setDescription('Start typing a project name').setRequired(true).setAutocomplete(true)

export const data = new SlashCommandBuilder()
  .setName('project-members')
  .setDescription('Who works on which project — the list the UBS-Doc site shows')
  .addSubcommand((s) => s.setName('add').setDescription('Add someone to a project, or change their role')
    .addStringOption(projectOpt)
    .addUserOption((o) => o.setName('member').setDescription('The person').setRequired(true))
    .addStringOption((o) => o.setName('role').setDescription('Their role on this project (default developer)').setRequired(false).addChoices(...roleChoices)))
  .addSubcommand((s) => s.setName('remove').setDescription('Take someone off a project')
    .addStringOption(projectOpt)
    .addUserOption((o) => o.setName('member').setDescription('The person').setRequired(true)))
  .addSubcommand((s) => s.setName('list').setDescription('Show who is on a project')
    .addStringOption(projectOpt))

/** People holding this project's tasks who are not on the explicit list. Pure. */
export function inferredMemberIds(tasks = [], explicitIds = []) {
  const explicit = new Set(explicitIds.map(String))
  const out = []
  for (const t of tasks) for (const id of holdersOf(t)) {
    if (!explicit.has(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/** The list message. Pure. */
export function renderMembers({ project, explicit = [], inferredIds = [], nameFor = () => null }) {
  const name = (id) => nameFor(id) || `<@${id}>`
  const lines = [`**${project.name}**`]
  if (!explicit.length && !inferredIds.length) {
    lines.push('No members yet. Add one with `/project-members add`.')
    return lines.join('\n')
  }
  for (const role of PROJECT_MEMBER_ROLES) {
    const people = explicit.filter((m) => m.role === role).map((m) => name(m.discordId))
    if (people.length) lines.push(`**${ROLE_LABEL[role]}:** ${people.join(', ')}`)
  }
  if (inferredIds.length) {
    lines.push('', `_Also assigned to tasks here:_ ${inferredIds.map(name).join(', ')}`)
  }
  return lines.join('\n')
}

async function resolveProject(interaction, cfg, dbArg) {
  const raw = String(interaction.options.getString('project') || '').trim()
  const row = raw ? await dbArg.project.findFirst({ where: { id: raw } }).catch(() => null) : null
  if (!row || row.guildConfigId !== cfg.id) {
    await interaction.editReply({ content: `No project matches **${raw.slice(0, 80)}**. Start typing a project name and pick one from the list.` })
    return null
  }
  return row
}

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })
  const cfg = await getConfig(guild.id)
  const sub = interaction.options.getSubcommand()
  const project = await resolveProject(interaction, cfg, dbArg)
  if (!project) return

  if (sub === 'add') {
    const user = interaction.options.getUser('member')
    const role = interaction.options.getString('role') || 'developer'
    if (user.bot) return interaction.editReply({ content: 'Bots cannot be project members.' })
    await dbArg.projectMember.add({ data: { guildConfigId: cfg.id, projectId: project.id, discordId: user.id, role, addedBy: interaction.user.id } })
    return interaction.editReply({ content: `Added <@${user.id}> to **${project.name}** as **${ROLE_LABEL[role]}**.` })
  }
  if (sub === 'remove') {
    const user = interaction.options.getUser('member')
    const { removed } = await dbArg.projectMember.remove({ where: { projectId: project.id, discordId: user.id } })
    return interaction.editReply({ content: removed ? `Removed <@${user.id}> from **${project.name}**.` : `<@${user.id}> was not on **${project.name}**.` })
  }

  const explicit = await dbArg.projectMember.findByProject({ where: { projectId: project.id } })
  const tasks = await dbArg.task.findMany({ where: { guildConfigId: cfg.id, projectId: project.id }, take: 500 })
  const inferredIds = inferredMemberIds(tasks, explicit.map((m) => m.discordId))
  const nameFor = (id) => guild.members.cache.get(id)?.displayName ?? null
  return interaction.editReply({ content: renderMembers({ project, explicit, inferredIds, nameFor }) })
}

export async function autocomplete(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'project') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getConfig(interaction.guild.id)
    const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
    return interaction.respond(projectChoices(projects, focused.value, { withDetach: false })).catch(() => {})
  } catch (e) {
    console.error('[project-members] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}
