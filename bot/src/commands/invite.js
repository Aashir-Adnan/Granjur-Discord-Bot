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
import db, { getOrCreateGuildConfig, guildMemberFindByEmail } from '../db/index.js'
import { sendEmail, inviteEmailHtml } from '../Mailer/sendEmail.js'
import { setInviteUses } from '../events/inviteUsesCache.js'
import { EPHEMERAL } from '../constants.js'
import * as flowStore from '../flows/store.js'

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
function debug(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}]`, ...args)
}

const MAX_BATCH_INVITES = 20

/** Parse raw input into trimmed, lowercased, unique emails (comma / newline / semicolon separated) */
export function parseEmails(raw) {
  if (!raw || typeof raw !== 'string') return []
  return [...new Set(
    raw
      .split(/[\n,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  )]
}

/** Basic email format check */
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export const data = new SlashCommandBuilder()
  .setName('invite')
  .setDescription('Send server invite links via email (batch supported)')
  .addStringOption((o) =>
    o.setName('emails').setDescription('Emails (comma/semicolon/newline separated)').setRequired(false).setMaxLength(2000)
  )
  .addBooleanOption((o) =>
    o.setName('client').setDescription('Invite as a client: any email domain; they will see only the support channels').setRequired(false)
  )

export async function execute(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

    const cfg = await getOrCreateGuildConfig(guild.id)
    if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

    const asClient = interaction.options.getBoolean('client') === true
    const emailsOpt = interaction.options.getString('emails')
    if (emailsOpt && emailsOpt.trim()) {
      // Pass the addresses as a value. Spreading the interaction to fake a modal
      // submission drops every method on it — discord.js keeps editReply and the
      // `guild` getter on the prototype, not as own properties — which is how this
      // path came to throw "interaction.editReply is not a function".
      // handleInviteModal owns validation for both entry points, so there is
      // nothing to pre-check here.
      return handleInviteModal(interaction, emailsOpt, { client: asClient })
    }

    // The modal path has no options; remember the flag for its submit.
    flowStore.clear(interaction.user.id, guild.id, 'invite')
    flowStore.set(interaction.user.id, guild.id, 'invite', { client: asClient })

    const embed = new EmbedBuilder()
      .setTitle('Invite by email (batch)')
      .setDescription(
        'Enter one or more email addresses (comma, newline, or semicolon separated). ' +
        'Or use **/invite emails:one@example.com,two@example.com** to skip the form.' +
        (asClient ? '\n\n**These invites are for clients.**' : '')
      )
      .setColor(0x5865f2)
      .setFooter({ text: `Up to ${MAX_BATCH_INVITES} per batch` })

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
        .setLabel('Emails')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('one@example.com\ntwo@example.com')
        .setRequired(true)
        .setMaxLength(2000)
    )
  )
  await interaction.showModal(modal)
}

/**
 * Send the invites. Reached two ways:
 *   - the modal, which carries the addresses in `interaction.fields`
 *   - `/invite emails:...`, which passes them as `rawEmails`
 * A slash-command interaction has no `fields`, so read it only when it is there.
 */
export async function handleInviteModal(interaction, rawEmails = null, {
  client = null,
  db: dbArg = db,
  getConfig = getOrCreateGuildConfig,
  sendEmail: send = sendEmail,
  findMemberByEmail = guildMemberFindByEmail,
} = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.' }).catch(() => {})
  const asClient = client ?? Boolean(flowStore.get(interaction.user?.id, guild.id, 'invite')?.client)

  const fromFields = interaction.fields
    ? interaction.fields.getTextInputValue('emails') || interaction.fields.getTextInputValue('email') || ''
    : ''
  const raw = rawEmails ?? fromFields
  const all = parseEmails(raw)
  const valid = all.filter((e) => isValidEmail(e))
  const invalid = all.filter((e) => !isValidEmail(e))

  const toSend = valid.slice(0, MAX_BATCH_INVITES)
  const capped = valid.length > MAX_BATCH_INVITES

  if (toSend.length === 0) {
    const invalidList = invalid.length ? invalid.map((e) => `• ${e}`).join('\n') : '(none)'
    return interaction.editReply({
      content: 'No valid email addresses to invite.',
      embeds: invalid.length
        ? [new EmbedBuilder().setTitle('Invalid emails').setDescription(invalidList).setColor(0xed4245)]
        : [],
    }).catch(() => {})
  }

  try {
    const cfg = await getConfig(guild.id)
    if (!cfg) return interaction.editReply({ content: 'Server not initialized.' }).catch(() => {})

    // Get a channel to create the invite (e.g. onboarding or first text channel)
    let inviteChannel = null
    if (cfg.onboardingChannelId) {
      inviteChannel = await guild.channels.fetch(cfg.onboardingChannelId).catch(() => null)
    }
    if (!inviteChannel) {
      const channels = await guild.channels.fetch()
      inviteChannel = [...channels.values()].find((c) => c.isTextBased() && !c.isThread()) || null
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
        await dbArg.pendingInvite.create({
          data: { guildConfigId: cfg.id, inviteCode: invite.code, email, kind: asClient ? 'client' : 'staff' },
        }).catch(() => {})
        setInviteUses(guild.id, invite.code, 0)
        const html = inviteEmailHtml(invite.url, serverName)
        const result = await send(email, `You're invited to ${serverName}`, html, { guildConfigId: cfg.id })

        if (!result.ok) {
          failed.push({ email, reason: result.message || 'Email send failed' })
          continue
        }

        const memberRow = await findMemberByEmail(guild.id, email)
        if (memberRow?.discordId) {
          try {
            const user = await interaction.client.users.fetch(memberRow.discordId).catch(() => null)
            if (user) {
              await user.send({
                content: `**You're invited to ${serverName}**\n\nHere's your invite link (also sent to ${email}):\n${invite.url}\n\nLink expires in 7 days and can be used once.`,
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
      lines.push(`**Invites sent (${sent.length})${asClient ? ' as clients' : ''}:** ${sent.map((e) => `\`${e}\``).join(', ')}`)
    }
    if (capped) {
      lines.push(`_Only first ${MAX_BATCH_INVITES} valid addresses were processed._`)
    }
    if (failed.length) {
      lines.push(`**Failed to send (${failed.length}):** ${failed.map((f) => `\`${f.email}\` (${f.reason})`).join('; ')}`)
    }
    if (invalid.length) {
      lines.push(`**Invalid emails (not sent):** ${invalid.map((e) => `\`${e}\``).join(', ')}`)
    }

    const resultEmbed = new EmbedBuilder()
      .setTitle('Batch invite result')
      .setDescription(lines.join('\n\n'))
      .setColor(invalid.length || failed.length ? 0xfee75c : 0x57f287)

    await interaction.editReply({ content: null, embeds: [resultEmbed] }).catch(() => {})
    flowStore.clear(interaction.user?.id, guild.id, 'invite')
  } catch (e) {
    const msg = e?.message ?? String(e)
    debug('invite modal error', msg)
    await interaction.editReply({ content: `Invite failed: ${msg}` }).catch(() => {})
  }
}
