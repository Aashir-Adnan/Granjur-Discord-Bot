import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig, getGuildConfigById } from '../db/index.js'
import { isAllowedEmail } from '../config.js'
import { sendEmail, otpEmailHtml } from '../Mailer/sendEmail.js'
import * as flowStore from '../flows/store.js'
import { EPHEMERAL } from '../constants.js'

const OTP_EXPIRY_MINUTES = 10
const OTP_LENGTH = 6

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

/** Capitalise first letter of string (for nickname from email local part) */
export function nicknameFromEmail(email) {
  if (!email || typeof email !== 'string') return null
  const local = email.split('@')[0]?.trim()
  if (!local) return null
  return local.charAt(0).toUpperCase() + local.slice(1).toLowerCase()
}

export const data = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Verify your identity — we DM you a 6-digit code to enter here')
  .setDefaultMemberPermissions(null) // Allow everyone (including new users with no roles) to run this command
  .addStringOption((o) =>
    o.setName('code').setDescription('6-digit code from DM (skip the form)').setRequired(false).setMaxLength(6).setMinLength(6)
  )

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run `/init` first.' })

  const codeOpt = interaction.options.getString('code')
  if (codeOpt && codeOpt.trim().length === 6) {
    const fakeModalInteraction = {
      ...interaction,
      fields: { getTextInputValue: () => codeOpt.trim() },
    }
    return handleOtpModal(fakeModalInteraction)
  }

  const embed = new EmbedBuilder()
    .setTitle('Verify your identity')
    .setDescription(
      'Click the button to receive a **6-digit code** in your DMs.\n\n' +
        'We’ll Enter the code here to verify.\n\n' +
        'After verifying, you’ll be in **Holding** until a CEO or Server Manager approves you. '
    )
    .setColor(0x5865f2)
    .setFooter({ text: 'Verification via DM' })

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify_get_code').setLabel('Send verification code').setStyle(ButtonStyle.Primary)
  )

  await interaction.editReply({ embeds: [embed], components: [row] })
}

export async function handleGetCode(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized.', components: [] }).catch(() => {})

  try {
    const code = generateOtp()
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000)
    await db.verificationOtp.create({
      data: {
        guildConfigId: cfg.id,
        discordId: interaction.user.id,
        email: '', // DM flow: no email
        code,
        expiresAt,
      },
    })

    const dmMessage = `Your **${guild.name}** verification code is: **${code}**\n\nEnter this code in the server when prompted. It expires in ${OTP_EXPIRY_MINUTES} minutes.`
    let dmSent = false
    try {
      await interaction.user.send(dmMessage)
      dmSent = true
    } catch (_) {
      // User may have DMs disabled
    }

    if (!dmSent) {
      await db.verificationOtp.delete({
        where: { guildId_discordId: { guildId: guild.id, discordId: interaction.user.id } },
      }).catch(() => {})
      return interaction.editReply({
        content: 'I couldn\'t DM you. Please **allow DMs from server members** (Server Settings → Privacy), then try again.',
        components: [],
      }).catch(() => {})
    }

    flowStore.set(interaction.user.id, guild.id, 'verify_otp', {})

    const embed = new EmbedBuilder()
      .setTitle('Code sent')
      .setDescription('Check your **DMs** for the 6-digit code. Click the button below and enter it here.')
      .setColor(0x57f287)
      .setFooter({ text: 'Code expires in ' + OTP_EXPIRY_MINUTES + ' minutes' })

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify_enter_otp').setLabel('Enter code').setStyle(ButtonStyle.Primary)
    )
    await interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {})
  } catch (e) {
    const msg = e?.message ?? String(e)
    await interaction.editReply({ content: `Something went wrong: ${msg}`, components: [] }).catch(() => {})
  }
}

export async function handleEmailModal(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.' }).catch(() => {})

  const email = (interaction.fields.getTextInputValue('email') || '').trim().toLowerCase()
  if (!isAllowedEmail(email)) {
    return interaction.editReply({
      content: 'That email domain is not allowed. Use an allowed address (e.g. @granjur.com).',
    }).catch(() => {})
  }

  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    if (!cfg) return interaction.editReply({ content: 'Server not initialized.' }).catch(() => {})

    const code = generateOtp()
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000)

    await db.verificationOtp.create({
      data: {
        guildConfigId: cfg.id,
        discordId: interaction.user.id,
        email,
        code,
        expiresAt,
      },
    })

    const html = otpEmailHtml(code, OTP_EXPIRY_MINUTES)
    const result = await sendEmail(email, 'Your Granjur verification code', html, { guildConfigId: cfg.id })

    if (!result.ok) {
      await db.verificationOtp.delete({
        where: { guildId_discordId: { guildId: guild.id, discordId: interaction.user.id } },
      }).catch(() => {})
      return interaction.editReply({
        content: `Could not send the code to your email: ${result.message || 'Unknown error'}. Check that the address is correct and try again.`,
      }).catch(() => {})
    }

    flowStore.set(interaction.user.id, guild.id, 'verify_otp', { email })

    const embed = new EmbedBuilder()
      .setTitle('Code sent')
      .setDescription(`A 6-digit code was sent to **${email}**. Click the button below and enter it.`)
      .setColor(0x57f287)
      .setFooter({ text: 'Code expires in ' + OTP_EXPIRY_MINUTES + ' minutes' })

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify_enter_otp').setLabel('Enter code').setStyle(ButtonStyle.Primary)
    )
    await interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {})
  } catch (e) {
    const msg = e?.message ?? String(e)
    await interaction.editReply({ content: `Something went wrong: ${msg}` }).catch(() => {})
  }
}

export async function handleEnterOtpButton(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.', components: [] }).catch(() => {})

  const modal = new ModalBuilder()
    .setCustomId('verify_otp_modal')
    .setTitle('Enter verification code')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('code')
        .setLabel('6-digit code from your DMs')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('123456')
        .setRequired(true)
        .setMinLength(OTP_LENGTH)
        .setMaxLength(OTP_LENGTH)
    )
  )
  await interaction.showModal(modal)
}

export async function handleOtpModal(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.' }).catch(() => {})

  const code = (interaction.fields.getTextInputValue('code') || '').trim()
  const row = await db.verificationOtp.findValidByCode(guild.id, interaction.user.id, code)
  if (!row) {
    return interaction.editReply({
      content: 'Invalid or expired code. Run **/verify** and request a new code.',
    }).catch(() => {})
  }
  const email = (row.email && row.email.trim()) || null

  try {
    const cfg = await getOrCreateGuildConfig(guild.id).catch(() => {})

    await db.guildMember.upsert({
      where: { guildId_discordId: { guildId: guild.id, discordId: interaction.user.id } },
      create: {
        guildId: guild.id,
        discordId: interaction.user.id,
        email: email ?? undefined,
        verifiedAt: new Date(),
        status: 'holding',
      },
      update: { email: email ?? undefined, verifiedAt: new Date(), status: 'holding' },
    })
    await db.verificationOtp.delete({ where: { guildId_discordId: { guildId: guild.id, discordId: interaction.user.id } } }).catch(() => {})
    flowStore.clear(interaction.user.id, guild.id, 'verify_otp')

    let member
    try {
      member = await guild.members.fetch(interaction.user.id)
      const nickname = email ? nicknameFromEmail(email) : (member.displayName || member.user.username || '').trim() || null
      if (nickname && member.moderatable) {
        await member.setNickname(nickname).catch(() => {})
      }
      if (cfg.holdingRoleId) {
        await member.roles.add(cfg.holdingRoleId).catch(() => {})
      }
    } catch (_) {}

    try {
      const { notifyBacklogUpdate } = await import('../services/backlogNotify.js')
      await notifyBacklogUpdate(guild, member, email || undefined)
    } catch (_) {}

    await interaction.editReply({
      content: `**Verified.**  You’re in **Holding** until a CEO or Server Manager approves you.`,
    }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Verification failed: ${e?.message ?? String(e)}` }).catch(() => {})
  }
}

/** Legacy: complete verification from external link (e.g. verify page) — still supports token flow */
export async function completeVerification(token, email, discordClient = null) {
  if (!isAllowedEmail(email)) return { ok: false, message: 'Email domain not allowed.' }
  const tokenRow = await db.verificationToken.findUnique({ where: { token } })
  if (!tokenRow || new Date() > tokenRow.expiresAt) {
    return { ok: false, message: 'Invalid or expired token.' }
  }
  const cfg = await getGuildConfigById(tokenRow.guildConfigId)
  if (!cfg) return { ok: false, message: 'Guild not found.' }

  await db.guildMember.upsert({
    where: { guildId_discordId: { guildId: cfg.guildId, discordId: tokenRow.discordId } },
    create: {
      guildId: cfg.guildId,
      discordId: tokenRow.discordId,
      email,
      verifiedAt: new Date(),
      status: 'holding',
    },
    update: { email, verifiedAt: new Date(), status: 'holding' },
  })
  await db.verificationToken.delete({ where: { token } }).catch(() => {})

  if (discordClient && cfg.holdingRoleId) {
    try {
      const guild = await discordClient.guilds.fetch(cfg.guildId)
      const member = await guild.members.fetch(tokenRow.discordId)
      const nickname = nicknameFromEmail(email)
      if (nickname && member.moderatable) await member.setNickname(nickname).catch(() => {})
      await member.roles.add(cfg.holdingRoleId)
      const { notifyBacklogUpdate } = await import('../services/backlogNotify.js')
      await notifyBacklogUpdate(guild, member, email)
    } catch (_) {}
  }

  return {
    ok: true,
    discordId: tokenRow.discordId,
    guildId: tokenRow.guildId,
    message: 'Verified. You are in holding until CEO/Server Manager approves.',
  }
}
