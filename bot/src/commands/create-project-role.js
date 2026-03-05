import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'

export const data = new SlashCommandBuilder()
  .setName('create-project-role')
  .setDescription('Create a Discord role for a project — only users with this role can access the project category')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles)
  .addStringOption((o) =>
    o.setName('project').setDescription('Project name (e.g. Fittour)').setRequired(true).setMaxLength(100)
  )

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const projectName = interaction.options.getString('project').trim()
  if (!projectName) return interaction.editReply({ content: 'Project name is required.' })

  const sanitized = projectName.replace(/[^\w\s-]/g, '').trim().slice(0, 100) || projectName.slice(0, 100)
  const roleName = sanitized || 'Project'

  try {
    const existing = guild.roles.cache.find((r) => r.name === roleName)
    if (existing) {
      return interaction.editReply({
        content: `Role **${roleName}** already exists. Use it to restrict access to the project category.`,
      })
    }
    const role = await guild.roles.create({
      name: roleName,
      reason: `Project role for ${projectName} (via /create-project-role)`,
    })
    return interaction.editReply({
      content: `Created role **${role.name}**. Assign this role to users who should access the **${roleName}** project category. Use **/create-project-categories** to create categories for all projects with role-based access.`,
    })
  } catch (e) {
    console.error('[create-project-role]', e)
    return interaction.editReply({
      content: `Failed to create role: ${e?.message ?? String(e)}. Ensure the bot has "Manage Roles" and its role is above the new role.`,
    })
  }
}
