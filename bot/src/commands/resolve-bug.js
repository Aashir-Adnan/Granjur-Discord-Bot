import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import db from '../db/index.js'
import { lockChannelAndScheduleDeletion } from '../utils/channels.js'
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('resolve-bug')
  .setDescription('Resolve this bug ticket (bug channel only). Attach MD file describing the solution.')
  .addAttachmentOption((o) =>
    o.setName('doc').setDescription('MD file describing the fix').setRequired(false)
  )

export async function execute(interaction) {
  const channel = interaction.channel
  const guild = interaction.guild
  if (!guild || !channel) return interaction.editReply({ content: 'Use this in a server channel.' })

  const ticket = await db.bugTicket.findFirst({ where: { discordChannelId: channel.id } })
  if (!ticket) {
    return interaction.editReply({
      content: 'This command can only be used inside a **bug ticket** channel. Open one with **/create-task** (choose Bug) first.',
    })
  }
  if (ticket.status === 'resolved') {
    return interaction.editReply({ content: 'This bug ticket is already resolved.' })
  }

  const attachment = interaction.options.getAttachment('doc')
  let content = null
  if (attachment) {
    if (!attachment.contentType?.startsWith('text/') && !attachment.name?.toLowerCase().endsWith('.md')) {
      return interaction.editReply({
        content: 'Please attach a Markdown (.md) or text file describing the solution.',
      })
    }
    try {
      const res = await fetch(attachment.url)
      content = await res.text()
    } catch (e) {
      return interaction.editReply({ content: `Could not read the file: ${e?.message || 'Unknown error'}` })
    }
  } else {
    return interaction.editReply({
      content: 'Please run **/resolve-bug** again and attach an **MD file** that describes the solution to the bug.',
    })
  }

  const doc = await db.ticketDoc.findFirst({ where: { taskId: ticket.id } })
  if (doc) await db.ticketDoc.update({ where: { id: doc.id }, data: { content } })

  await db.bugTicket.update({ where: { id: ticket.id }, data: { status: 'resolved', implementationStatus: 'done' } })

  const embed = new EmbedBuilder()
    .setTitle('Bug ticket resolved')
    .setDescription(`**${(ticket.title || 'Bug').slice(0, 200)}** has been resolved. Solution documentation has been saved.`)
    .setColor(0x57f287)

  await interaction.editReply({ embeds: [embed] }).catch(() => {})
  await channel.send({ content: 'This bug ticket has been resolved. This channel will be locked and deleted in 5 minutes.', embeds: [embed] }).catch(() => {})
  await lockChannelAndScheduleDeletion(channel)
}
