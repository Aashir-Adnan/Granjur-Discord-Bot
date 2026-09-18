import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig, PROJECT_MEMBER_ROLES } from '../db/index.js'
import { projectChoices } from './update-task.js'
import { holdersOf } from '../utils/taskLabel.js'
import { projectFromChannel } from '../services/projectSection.js'
import { ensureMembersPanel, postMembershipChange } from '../services/projectMembersPanel.js'

const ROLE_LABEL = {
  lead: 'Lead', developer: 'Developer', backend_developer: 'Backend Developer',
  frontend_developer: 'Frontend Developer', qa: 'QA', design: 'Design',
}
const roleChoices = PROJECT_MEMBER_ROLES.map((r) => ({ name: ROLE_LABEL[r], value: r }))
// Optional: left out, the project is the one whose section the command is run
// in. Discord wants required options first, so `project` follows `member`.
const projectOpt = (o) => o.setName('project').setDescription('Start typing a project name (default: the project whose channel you are in)').setRequired(false).setAutocomplete(true)

export const data = new SlashCommandBuilder()
  .setName('project-members')
  .setDescription('Who works on which project — the list the UBS-Doc site shows')
  .addSubcommand((s) => s.setName('add').setDescription('Add someone to a project, or change their role')
    .addUserOption((o) => o.setName('member').setDescription('The person').setRequired(true))
    .addStringOption(projectOpt)
    .addStringOption((o) => o.setName('role').setDescription('Their role on this project (default developer)').setRequired(false).addChoices(...roleChoices)))
  .addSubcommand((s) => s.setName('remove').setDescription('Take someone off a project')
    .addUserOption((o) => o.setName('member').setDescription('The person').setRequired(true))
    .addStringOption(projectOpt))
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

/**
 * The project named by the `project` option or, when it is left out, the
 * project whose section the command was run in. A named project always wins.
 */
async function resolveProject(interaction, cfg, dbArg) {
  const raw = String(interaction.options.getString('project') || '').trim()
  if (!raw) {
    const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } }).catch(() => [])
    const inferred = projectFromChannel(projects, interaction.channel)
    if (inferred && inferred.guildConfigId === cfg.id) return inferred
    await interaction.editReply({ content: "Pick a project with the `project` option, or run this inside one of the project's channels." })
    return null
  }
  const row = await dbArg.project.findFirst({ where: { id: raw } }).catch(() => null)
  if (!row || row.guildConfigId !== cfg.id) {
    await interaction.editReply({ content: `No project matches **${raw.slice(0, 80)}**. Start typing a project name and pick one from the list.` })
    return null
  }
  return row
}

/** `project.discordChannels` arrives as an object or as a JSON string. */
function membersChannelId(project) {
  let raw = project?.discordChannels
  if (!raw) return null
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return null }
  }
  return raw && typeof raw === 'object' && raw.members ? String(raw.members) : null
}

async function findMembersChannel(guild, project) {
  const id = membersChannelId(project)
  if (!id) {
    console.log(`[project-members] "${project.name}" has no members channel yet; skipping the panel`)
    return null
  }
  const cached = guild.channels?.cache?.get?.(id)
  const channel = cached ?? (await Promise.resolve(guild.channels?.fetch?.(id)).catch(() => null)) ?? null
  if (!channel) console.log(`[project-members] members channel ${id} of "${project.name}" is gone; skipping the panel`)
  return channel
}

/**
 * Grant or revoke the project's role for ONE member. Never a full roster
 * sync: the roster read is capped at 200 rows, and a sync from here could
 * strip the role from real members of a large project.
 * Returns the sentence the reply should carry about the Discord side.
 */
async function changeRole(guild, project, userId, action) {
  const roleId = project.discordRoleId
  if (!roleId) return 'This project has no Discord role yet, so no channel access changed. Run `/project-setup` to give it a section.'
  const roleName = guild.roles?.cache?.get?.(roleId)?.name ?? project.name
  const verb = action === 'grant' ? 'give them' : 'take away'
  try {
    const member = await guild.members.fetch(userId)
    if (!member) throw new Error('not in this server')
    if (action === 'grant') await member.roles.add(roleId)
    else await member.roles.remove(roleId)
    return action === 'grant' ? `They now have the **${roleName}** role.` : `Their **${roleName}** role was taken away.`
  } catch (e) {
    const message = e?.message || String(e)
    console.warn(`[project-members] could not ${verb} the role of "${project.name}" (${userId}): ${message}`)
    return `The membership is saved, but I could not ${verb} the **${roleName}** role (${message}), so their channel access did not change.`
  }
}

/** Refresh the pinned roster (always the FULL roster) and post one change line. */
async function updatePanel(interaction, project, roster, change) {
  const guild = interaction.guild
  const channel = await findMembersChannel(guild, project)
  if (!channel) return
  const nameFor = (id) => guild.members.cache.get(id)?.displayName ?? `<@${id}>`
  if (change) await postMembershipChange(channel, change)
  await ensureMembersPanel(channel, project, roster, { botUserId: interaction.client?.user?.id, nameFor })
}

const displayNameOf = (guild, user) =>
  guild.members.cache.get(user.id)?.displayName ?? user.globalName ?? user.username ?? user.id

const readRoster = (dbArg, project) =>
  Promise.resolve()
    .then(() => dbArg.projectMember.findByProject({ where: { projectId: project.id } }))
    .catch((e) => {
      console.warn(`[project-members] roster read for "${project.name}" failed: ${e?.message || e}`)
      return null
    })

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
    const before = await readRoster(dbArg, project)
    // The database is the source of truth: it is written first, and nothing
    // on the Discord side below can undo it.
    await dbArg.projectMember.add({ data: { guildConfigId: cfg.id, projectId: project.id, discordId: user.id, role, addedBy: interaction.user.id } })
    const lines = [`Added <@${user.id}> to **${project.name}** as **${ROLE_LABEL[role]}**.`]
    lines.push(await changeRole(guild, project, user.id, 'grant'))
    const roster = await readRoster(dbArg, project)
    if (roster) {
      // Post only a real change: re-adding someone with the role they already
      // hold says nothing in the channel.
      const prior = before?.find((m) => m.discordId === user.id)
      const change = prior && prior.role === role ? null : { name: displayNameOf(guild, user), role, action: 'added' }
      await updatePanel(interaction, project, roster, change)
    }
    return interaction.editReply({ content: lines.join('\n') })
  }

  if (sub === 'remove') {
    const user = interaction.options.getUser('member')
    const { removed } = await dbArg.projectMember.remove({ where: { projectId: project.id, discordId: user.id } })
    if (!removed) return interaction.editReply({ content: `<@${user.id}> was not on **${project.name}**.` })
    const lines = [`Removed <@${user.id}> from **${project.name}**.`]
    // Revoke only when no row for them on this project remains. If the roster
    // cannot be read, keep the role: an unrequested permission change is the
    // one outcome this must never produce.
    const roster = await readRoster(dbArg, project)
    const stillOn = !!roster?.some((m) => m.discordId === user.id)
    if (!roster) lines.push('I could not re-read the project roster, so I left their channel access alone.')
    else if (stillOn) lines.push('They still hold another role on this project, so their channel access stays.')
    else lines.push(await changeRole(guild, project, user.id, 'revoke'))
    if (roster) {
      await updatePanel(interaction, project, roster, stillOn ? null : { name: displayNameOf(guild, user), action: 'removed' })
    }
    return interaction.editReply({ content: lines.join('\n') })
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
