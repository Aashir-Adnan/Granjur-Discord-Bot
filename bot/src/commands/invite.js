import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig, guildMemberFindByEmail } from '../db/index.js'
import { sendEmail, inviteEmailHtml } from '../Mailer/sendEmail.js'
import { setInviteUses } from '../events/inviteUsesCache.js'
import { INVITE_ALLOWED_DOMAIN } from '../constants.js'
import { EPHEMERAL } from '../constants.js'

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
function debug(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}]`, ...args)
}

const MAX_BATCH_INVITES = 20

/** Parse raw input into trimmed, lowercased, unique emails (comma / newline / semicolon separated) */
function parseEmails(raw) {
  if (!raw || typeof raw !== 'string') return []
  return [...new Set(
    raw
      .split(/[\n,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  )]
}

export const data = new SlashCommandBuilder()
  .setName('invite')
  .setDescription(`Send server invite links to @${INVITE_ALLOWED_DOMAIN} emails (batch supported)`)
  .setDefaultMemberPermissions(PermissionFlagsBits.CreateInstantInvite | PermissionFlagsBits.ManageGuild)
  .addStringOption((o) =>
    o.setName('emails').setDescription(`Emails (comma/semicolon/newline separated, @${INVITE_ALLOWED_DOMAIN} only)`).setRequired(false).setMaxLength(2000)
  )

export async function execute(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

    const cfg = await getOrCreateGuildConfig(guild.id)
    if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

    const emailsOpt = interaction.options.getString('emails')
    if (emailsOpt && emailsOpt.trim()) {
      const all = parseEmails(emailsOpt)
      const valid = all.filter((e) => (e.split('@')[1] || '').toLowerCase() === INVITE_ALLOWED_DOMAIN)
      const invalid = all.filter((e) => (e.split('@')[1] || '').toLowerCase() !== INVITE_ALLOWED_DOMAIN)
      const toSend = valid.slice(0, MAX_BATCH_INVITES)
      const capped = valid.length > MAX_BATCH_INVITES
      if (invalid.length) {
        return interaction.editReply({
          content: `Invalid or wrong-domain: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}. Only **@${INVITE_ALLOWED_DOMAIN}** allowed.`,
        })
      }
      if (!toSend.length) {
        return interaction.editReply({ content: `No valid **@${INVITE_ALLOWED_DOMAIN}** emails in the list.` })
      }
      const fakeModalInteraction = {
        ...interaction,
        fields: { getTextInputValue: () => emailsOpt },
      }
      return handleInviteModal(fakeModalInteraction)
    }

    const embed = new EmbedBuilder()
      .setTitle('Invite by email (batch)')
      .setDescription(
        `Enter one or more **@${INVITE_ALLOWED_DOMAIN}** email addresses (comma, newline, or semicolon separated). ` +
        `Or use **/invite emails:one@${INVITE_ALLOWED_DOMAIN},two@${INVITE_ALLOWED_DOMAIN}** to skip the form.`
      )
      .setColor(0x5865f2)
      .setFooter({ text: `Only @${INVITE_ALLOWED_DOMAIN} · Up to ${MAX_BATCH_INVITES} per batch` })

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('invite_enter_email').setLabel('Enter emails').setStyle(ButtonStyle.Primary)
    )

    await interaction.editReply({ embeds: [embed], components: [row] })
  } catch (e) {
    const msg = e?.message ?? String(e)
    debug('invite execute error', msg)
    await interaction.editReply({ content: `Invite step failed: ${msg}` }).catch(() => {})
  }
}

export async function handleInviteButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('invite_email_modal')
    .setTitle('Invite by email (batch)')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('emails')
        .setLabel(`Emails (@${INVITE_ALLOWED_DOMAIN} only)`)
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder(`one@${INVITE_ALLOWED_DOMAIN}\ntwo@${INVITE_ALLOWED_DOMAIN}`)
        .setRequired(true)
        .setMaxLength(2000)
    )
  )
  await interaction.showModal(modal)
}

export async function handleInviteModal(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.' }).catch(() => {})

  const raw = interaction.fields.getTextInputValue('emails') || interaction.fields.getTextInputValue('email') || ''
  const all = parseEmails(raw)
  const valid = all.filter((e) => (e.split('@')[1] || '').toLowerCase() === INVITE_ALLOWED_DOMAIN)
  const invalid = all.filter((e) => (e.split('@')[1] || '').toLowerCase() !== INVITE_ALLOWED_DOMAIN)

  const toSend = valid.slice(0, MAX_BATCH_INVITES)
  const capped = valid.length > MAX_BATCH_INVITES

  if (toSend.length === 0) {
    const invalidList = invalid.length ? invalid.map((e) => `• ${e}`).join('\n') : '(none)'
    return interaction.editReply({
      content: `No valid **@${INVITE_ALLOWED_DOMAIN}** addresses to invite.`,
      embeds: invalid.length
        ? [new EmbedBuilder().setTitle('Invalid or wrong domain').setDescription(invalidList).setColor(0xed4245)]
        : [],
    }).catch(() => {})
  }

  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    if (!cfg) return interaction.editReply({ content: 'Server not initialized.' }).catch(() => {})

    // Get a channel to create the invite (e.g. onboarding or first text channel)
    let inviteChannel = null
    if (cfg.onboardingChannelId) {
      inviteChannel = await guild.channels.fetch(cfg.onboardingChannelId).catch(() => null)
    }
    if (!inviteChannel) {
      const channels = await guild.channels.fetch()
      inviteChannel = channels.find((c) => c.isTextBased() && !c.isThread()) || null
    }
    if (!inviteChannel) {
      return interaction.editReply({
        content: 'No channel available to create invites. Create a text channel first.',
      }).catch(() => {})
    }

    const serverName = guild.name || 'Granjur'
    const sent = []
    const failed = []

    for (const email of toSend) {
      try {
        const invite = await guild.invites.create(inviteChannel, {
          maxAge: 60 * 24 * 7,
          maxUses: 1,
          reason: `Invite sent to ${email} via /invite (batch)`,
        })
        await db.pendingInvite.create({
          data: { guildConfigId: cfg.id, inviteCode: invite.code, email },
        }).catch(() => {})
        setInviteUses(guild.id, invite.code, 0)
        const html = inviteEmailHtml(invite.url, serverName)
        const result = await sendEmail(email, `You're invited to ${serverName}`, html, { guildConfigId: cfg.id })

        if (!result.ok) {
          failed.push({ email, reason: result.message || 'Email send failed' })
          continue
        }

        const memberRow = await guildMemberFindByEmail(guild.id, email)
        if (memberRow?.discordId) {
      try {
        const user = await interaction.client.users.fetch(memberRow.discordId).catch(() => null)
        if (user) {
          await user.send({
            content: `**You're invited to ${serverName}**\n\nHere’s your invite link (also sent to ${email}):\n${invite.url}\n\nLink expires in 7 days and can be used once.`,
          }).catch(() => {})
        }
      } catch (_) {}
    }

        sent.push(email)
      } catch (err) {
        failed.push({ email, reason: err?.message || 'Unknown error' })
      }
    }

    const lines = []
    if (sent.length) {
      lines.push(`**Invites sent (${sent.length}):** ${sent.map((e) => `\`${e}\``).join(', ')}`)
    }
    if (capped) {
      lines.push(`_Only first ${MAX_BATCH_INVITES} valid addresses were processed._`)
    }
    if (failed.length) {
      lines.push(`**Failed to send (${failed.length}):** ${failed.map((f) => `\`${f.email}\` (${f.reason})`).join('; ')}`)
    }
    if (invalid.length) {
      lines.push(`**Invalid / wrong domain (not sent):** ${invalid.map((e) => `\`${e}\``).join(', ')}`)
    }

    const resultEmbed = new EmbedBuilder()
      .setTitle('Batch invite result')
      .setDescription(lines.join('\n\n'))
      .setColor(invalid.length || failed.length ? 0xfee75c : 0x57f287)

    await interaction.editReply({ content: null, embeds: [resultEmbed] }).catch(() => {})
  } catch (e) {
    const msg = e?.message ?? String(e)
    debug('invite modal error', msg)
    await interaction.editReply({ content: `Invite failed: ${msg}` }).catch(() => {})
  }
}
