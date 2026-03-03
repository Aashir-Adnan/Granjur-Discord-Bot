import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig, updateGuildConfig } from '../db/index.js'
import { ROLE_CLOCKED_IN, ROLE_SEPARATOR_NAME, CATEGORY_BOLD_NAMES } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('migrate')
  .setDescription('(Admin) Apply server migration: Clocked In role, separator roles, bold category names')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  // Interaction already deferred by main handler for slash commands
  const results = []
  const cfg = await getOrCreateGuildConfig(guild.id)

  try {
    // 1) Create or get "Clocked In" role — members with this role are "online" (right sidebar)
    let clockedInRole = guild.roles.cache.find((r) => r.name === ROLE_CLOCKED_IN)
    if (!clockedInRole) {
      clockedInRole = await guild.roles.create({
        name: ROLE_CLOCKED_IN,
        color: 0x57f287,
        mentionable: false,
        reason: 'Migration: show clocked-in members in sidebar',
      })
      results.push(`Created role **${ROLE_CLOCKED_IN}**`)
    } else {
      results.push(`Role **${ROLE_CLOCKED_IN}** already exists`)
    }
    await updateGuildConfig(guild.id, { clockedInRoleId: clockedInRole.id })
    results.push(`Saved **${ROLE_CLOCKED_IN}** to config. Use /clock-in and /clock-out to assign/remove.`)

    // 2) Create separator role "-------------" (not mentionable, for visual separation)
    let sepRole = guild.roles.cache.find((r) => r.name === ROLE_SEPARATOR_NAME)
    if (!sepRole) {
      sepRole = await guild.roles.create({
        name: ROLE_SEPARATOR_NAME,
        mentionable: false,
        permissions: [],
        reason: 'Migration: visual separator in member list',
      })
      results.push(`Created separator role **${ROLE_SEPARATOR_NAME}** (not mentionable)`)
    } else {
      results.push(`Separator role **${ROLE_SEPARATOR_NAME}** already exists`)
    }

    // 3) Rename categories to bold format
    const categories = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory)
    let renamed = 0
    for (const [, cat] of categories) {
      const newName = CATEGORY_BOLD_NAMES[cat.name]
      if (newName && cat.name !== newName) {
        await cat.setName(newName).catch((e) => results.push(`Failed to rename "${cat.name}": ${e.message}`))
        renamed++
      }
    }
    if (renamed > 0) results.push(`Renamed **${renamed}** categories to bold format.`)
    else if (categories.size > 0) results.push('Category names already bold or no mapping matched.')

    const embed = new EmbedBuilder()
      .setTitle('Migration complete')
      .setDescription(results.join('\n'))
      .setColor(0x57f287)
      .setFooter({ text: 'Clocked In role is assigned/removed by /clock-in and /clock-out' })

    await interaction.editReply({ embeds: [embed] })
  } catch (e) {
    console.error('Migrate error:', e)
    await interaction.editReply({
      content: `Migration failed: ${e?.message ?? String(e)}`,
      embeds: [],
    }).catch(() => {})
  }
}
