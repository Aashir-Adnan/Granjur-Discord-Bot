import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js'
import db, { getGuildConfig } from '../db/index.js'
import { CHANNEL_BARE_TEXT, CHANNEL_BARE_VOICE } from '../constants.js'
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('scrap')
  .setDescription('Reset server to bare bones — confirm to remove EVERYTHING (one text + one voice channel only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
function debug(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}]`, ...args)
}

export async function execute(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

    const embed = new EmbedBuilder()
      .setTitle('Reset server (scrap)')
      .setDescription(
        'This will **remove EVERYTHING**:\n' +
          '• Delete **all** channels (categories, text, voice)\n' +
          '• Delete **all** custom roles\n' +
          '• Clear all stored config and data for this server\n' +
          '• Create only **one text channel** and **one voice channel**\n\n' +
          'Run **/init** after to rebuild. **This cannot be undone.**'
      )
      .setColor(0xed4245)
      .setFooter({ text: 'Step 1 of 2 — Confirm' })

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('scrap_confirm').setLabel('Yes, reset server').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('scrap_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    )

    await interaction.editReply({ embeds: [embed], components: [row] })
  } catch (e) {
    const msg = e?.message ?? String(e)
    console.error('[scrap] execute error:', e)
    debug('scrap execute error', msg)
    await interaction.editReply({ content: `Could not show reset options: ${msg}` }).catch(() => {})
  }
}

export async function handleConfirm(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.', components: [] }).catch(() => {})

  try {
    const removed = { channels: 0, roles: 0, config: false }

    // 1. Delete ALL channels (non-category first so children are gone, then categories)
    const channels = await guild.channels.fetch()
    const byType = { category: [], other: [] }
    for (const [, ch] of channels) {
      if (ch.isThread()) continue
      if (ch.type === ChannelType.GuildCategory) byType.category.push(ch)
      else byType.other.push(ch)
    }
    for (const ch of byType.other) {
      try {
        await ch.delete()
        removed.channels++
      } catch (_) {}
    }
    for (const ch of byType.category) {
      try {
        await ch.delete()
        removed.channels++
      } catch (_) {}
    }

    // 2. Delete ALL custom roles (except @everyone and managed/bot roles)
    const roles = await guild.roles.fetch()
    for (const [, role] of roles) {
      if (role.id === guild.id) continue // @everyone
      if (role.managed) continue
      try {
        await role.delete()
        removed.roles++
      } catch (_) {}
    }

    // 3. Clear DB config for this guild (cascade will clear related rows)
    await db.guildConfig.delete({ where: { guildId: guild.id } })
    removed.config = true

    // 4. Create exactly one text and one voice channel
    const textChannel = await guild.channels.create({ name: CHANNEL_BARE_TEXT, type: ChannelType.GuildText })
    await guild.channels.create({ name: CHANNEL_BARE_VOICE, type: ChannelType.GuildVoice })

    const embed = new EmbedBuilder()
      .setTitle('Server reset complete')
      .setDescription(
        `Removed ${removed.channels} channels and ${removed.roles} roles.\n` +
          `Database config cleared.\n\n` +
          `Server now has only **#${CHANNEL_BARE_TEXT}** (text) and **${CHANNEL_BARE_VOICE}** (voice). Run **/init** to rebuild.`
      )
      .setColor(0x57f287)

    // Original message was in a channel we just deleted — editReply will fail; send result to the new #general
    await interaction.editReply({ embeds: [embed], components: [] }).catch(async () => {
      try {
        await textChannel.send({ embeds: [embed] })
      } catch (err) {
        console.error('[scrap] Could not send result to new channel:', err)
      }
    })
  } catch (e) {
    const msg = e?.message ?? String(e)
    console.error('[scrap] handleConfirm error:', e)
    debug('scrap handleConfirm error', msg)
    const failPayload = {
      content: `Reset failed: ${msg}`,
      embeds: [],
      components: [],
    }
    await interaction.editReply(failPayload).catch(async () => {
      try {
        const ch = guild.channels.cache.find((c) => c.isTextBased() && !c.isThread())
        if (ch) await ch.send(failPayload)
      } catch (err) {
        console.error('[scrap] Could not send failure message:', err)
      }
    })
  }
}

export async function handleCancel(interaction) {
  await interaction.editReply({
    content: 'Reset cancelled.',
    embeds: [],
    components: [],
  }).catch(() => {})
}
