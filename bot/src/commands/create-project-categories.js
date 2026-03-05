import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'

export const data = new SlashCommandBuilder()
  .setName('create-project-categories')
  .setDescription('Create a category for each project in the DB — only users with that project role can access')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageChannels)
  .addBooleanOption((o) =>
    o.setName('create_roles').setDescription('Create missing project roles if they do not exist').setRequired(false)
  )

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  const schemas = await db.projectSchema.findMany({ where: { guildConfigId: cfg.id } })
  const createRoles = interaction.options.getBoolean('create_roles') ?? true

  if (!schemas.length) {
    return interaction.editReply({
      content: 'No projects in the database. Add project schemas with **/project-db** first.',
    })
  }

  const results = []
  const everyoneId = guild.id

  for (const s of schemas) {
    const projectName = (s.projectName || s.projectId || 'Project').trim().slice(0, 100)
    const roleName = projectName.replace(/[^\w\s-]/g, '').trim() || projectName

    try {
      let role = guild.roles.cache.find((r) => r.name === roleName)
      if (!role && createRoles) {
        role = await guild.roles.create({
          name: roleName,
          reason: `Project role for /create-project-categories`,
        })
        results.push(`Created role **${roleName}**`)
      }
      if (!role) {
        results.push(`Skipped **${projectName}**: no role "${roleName}". Run **/create-project-role project:${projectName}** or use create_roles:true.`)
        continue
      }

      const categoryName = `📂 ${projectName}`
      const existingCat = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name === categoryName
      )
      if (existingCat) {
        await existingCat.permissionOverwrites.edit(everyoneId, { ViewChannel: false })
        await existingCat.permissionOverwrites.edit(role.id, { ViewChannel: true })
        results.push(`Updated category **${categoryName}** — only role **${roleName}** can access`)
        continue
      }

      const category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: everyoneId, type: 0, deny: [PermissionFlagsBits.ViewChannel] },
          { id: role.id, type: 0, allow: [PermissionFlagsBits.ViewChannel] },
        ],
        reason: `Project category for ${projectName} (only ${roleName} role)`,
      })
      await guild.channels.create({
        name: `${projectName.toLowerCase().replace(/\s+/g, '-')}-chat`,
        type: ChannelType.GuildText,
        parent: category.id,
      })
      results.push(`Created category **${categoryName}** — only **${roleName}** can access`)
    } catch (e) {
      console.error(`[create-project-categories] ${projectName}:`, e)
      results.push(`Failed **${projectName}**: ${e?.message ?? String(e)}`)
    }
  }

  return interaction.editReply({
    content: results.length ? results.join('\n') : 'Nothing done.',
  })
}
