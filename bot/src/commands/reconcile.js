import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig, updateGuildConfig } from '../db/index.js'
import { query } from '../Database/connection.js'
import { EPHEMERAL, ROLE_HOLDING, ROLE_VERIFIED } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('reconcile')
  .setDescription('Sync members who joined while the bot was offline — creates DB records & assigns holding role')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  let cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  await interaction.editReply({ content: 'Scanning guild members...' })

  // Fix stale role IDs — look up actual roles by name and update DB if mismatched
  const configFixes = []
  const holdingRole = guild.roles.cache.find((r) => r.name === ROLE_HOLDING)
  const verifiedRole = guild.roles.cache.find((r) => r.name === ROLE_VERIFIED)
  const updates = {}
  if (holdingRole && cfg.holdingRoleId !== holdingRole.id) {
    updates.holdingRoleId = holdingRole.id
    configFixes.push(`Holding role: \`${cfg.holdingRoleId || 'NULL'}\` → \`${holdingRole.id}\``)
  }
  if (verifiedRole && cfg.verifiedRoleId !== verifiedRole.id) {
    updates.verifiedRoleId = verifiedRole.id
    configFixes.push(`Verified role: \`${cfg.verifiedRoleId || 'NULL'}\` → \`${verifiedRole.id}\``)
  }
  if (Object.keys(updates).length) {
    await updateGuildConfig(guild.id, updates)
    cfg = await getOrCreateGuildConfig(guild.id)
  }

  const discordMembers = await guild.members.fetch()

  // Get all discord IDs already tracked in the DB for this guild
  const dbRows = await query(
    'SELECT discordId FROM `guildmember` WHERE guildConfigId = ?',
    [cfg.id]
  )
  const trackedIds = new Set(dbRows.map((r) => r.discordId))

  // Filter to human members not yet in the DB (exclude bots)
  const missing = discordMembers.filter(
    (m) => !m.user.bot && !trackedIds.has(m.id)
  )

  if (missing.size === 0 && configFixes.length === 0) {
    return interaction.editReply({
      content: 'All guild members are already tracked and config is up to date. Nothing to reconcile.',
    })
  }
  if (missing.size === 0 && configFixes.length > 0) {
    const embed = new EmbedBuilder()
      .setTitle('Reconcile complete')
      .setDescription(`**Config fixed:**\n${configFixes.join('\n')}\n\nAll guild members are already tracked.`)
      .setColor(0x57f287)
    return interaction.editReply({ content: null, embeds: [embed] })
  }

  const reconciled = []
  const failed = []

  for (const [, member] of missing) {
    try {
      // Create DB record
      await db.guildMember.upsert({
        where: {
          guildId_discordId: { guildId: guild.id, discordId: member.id },
        },
        create: {
          guildId: guild.id,
          discordId: member.id,
          status: 'pending',
        },
        update: {},
      })

      // Assign holding role if they don't already have it
      if (cfg.holdingRoleId && !member.roles.cache.has(cfg.holdingRoleId)) {
        await member.roles.add(cfg.holdingRoleId).catch(() => {})
      }

      reconciled.push(member.user.tag)
    } catch (e) {
      failed.push({ tag: member.user.tag, reason: e?.message || 'Unknown error' })
    }
  }

  // Send welcome messages
  if (reconciled.length > 0 && cfg.onboardingChannelId) {
    const ch = await guild.channels.fetch(cfg.onboardingChannelId).catch(() => null)
    if (ch?.isTextBased()) {
      const tags = reconciled.map((t) => `**${t}**`).join(', ')
      await ch.send({
        content: `${tags} — you joined while the bot was offline. Run **/verify** to get a code sent to your email and complete verification.`,
      }).catch(() => {})
    }
  }

  const lines = []
  if (configFixes.length) {
    lines.push(`**Config fixed:**\n${configFixes.join('\n')}`)
  }
  if (reconciled.length) {
    lines.push(`**Reconciled (${reconciled.length}):** ${reconciled.map((t) => `\`${t}\``).join(', ')}`)
  }
  if (failed.length) {
    lines.push(`**Failed (${failed.length}):** ${failed.map((f) => `\`${f.tag}\` (${f.reason})`).join('; ')}`)
  }

  const embed = new EmbedBuilder()
    .setTitle('Reconcile complete')
    .setDescription(lines.join('\n\n'))
    .setColor(failed.length ? 0xfee75c : 0x57f287)
    .setFooter({ text: 'These members need to run /verify to complete onboarding' })

  await interaction.editReply({ content: null, embeds: [embed] })
}
