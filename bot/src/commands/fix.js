import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} from 'discord.js'
import { ROLE_VERIFIED } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('fix')
  .setDescription('(Admin) Grant Speak permission on all voice channels where it is missing')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const verifiedRole = guild.roles.cache.find((r) => r.name === ROLE_VERIFIED)
  if (!verifiedRole) {
    return interaction.editReply({ content: 'Verified role not found. Run **/init** first.' })
  }

  const roleLockedNames = ['Frontend', 'Backend', 'Database']
  const roleLockedMap = new Map()
  for (const name of roleLockedNames) {
    const role = guild.roles.cache.find((r) => r.name === name)
    if (role) roleLockedMap.set(name, role.id)
  }

  const voiceChannels = guild.channels.cache.filter((ch) => ch.type === ChannelType.GuildVoice)
  const fixed = []
  const skipped = []

  for (const [, ch] of voiceChannels) {
    const parentName = ch.parent?.name ?? ''

    // Determine which role should have Speak on this channel
    const roleLockEntry = [...roleLockedMap.entries()].find(([name]) => parentName.includes(name))
    const targetRoleId = roleLockEntry ? roleLockEntry[1] : verifiedRole.id
    const targetLabel = roleLockEntry ? roleLockEntry[0] : ROLE_VERIFIED

    // Check if the target role already has Speak granted
    const overwrite = ch.permissionOverwrites.cache.get(targetRoleId)
    if (overwrite && overwrite.allow.has(PermissionFlagsBits.Speak)) {
      skipped.push(ch.name)
      continue
    }

    try {
      await ch.permissionOverwrites.edit(targetRoleId, { Speak: true })
      fixed.push(`**#${ch.name}** (${targetLabel})`)
    } catch (e) {
      fixed.push(`**#${ch.name}** — failed: ${e.message}`)
    }
  }

  const lines = []
  if (fixed.length) lines.push(`**Fixed (${fixed.length}):**\n${fixed.join('\n')}`)
  if (skipped.length) lines.push(`**Already OK (${skipped.length}):** ${skipped.map((n) => `\`${n}\``).join(', ')}`)
  if (!fixed.length && !skipped.length) lines.push('No voice channels found.')

  const embed = new EmbedBuilder()
    .setTitle('Voice permissions fix')
    .setDescription(lines.join('\n\n'))
    .setColor(fixed.length ? 0xfee75c : 0x57f287)

  await interaction.editReply({ embeds: [embed] })
}
