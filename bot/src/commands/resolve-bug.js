import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import db from '../db/index.js'
import { placeTicketForStatus } from '../services/ticketArchive.js'

export const data = new SlashCommandBuilder()
  .setName('resolve-bug')
  .setDescription('Resolve this bug ticket (bug channel only). Attach MD file describing the solution.')
  .addAttachmentOption((o) =>
    o.setName('doc').setDescription('MD file describing the fix').setRequired(false)
  )

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction already deferred
 * @param {{db?: object, move?: typeof placeTicketForStatus}} [deps]
 */
export async function execute(interaction, { db: dbArg = db, move = placeTicketForStatus } = {}) {
  const channel = interaction.channel
  const guild = interaction.guild
  if (!guild || !channel) return interaction.editReply({ content: 'Use this in a server channel.' })

  const ticket = await dbArg.bugTicket.findFirst({ where: { discordChannelId: channel.id } })
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

  const doc = await dbArg.ticketDoc.findFirst({ where: { taskId: ticket.id } })
  if (doc) await dbArg.ticketDoc.update({ where: { id: doc.id }, data: { content } })

  await dbArg.bugTicket.update({ where: { id: ticket.id }, data: { status: 'resolved', implementationStatus: 'done' } })

  const embed = new EmbedBuilder()
    .setTitle('Bug ticket resolved')
    .setDescription(`**${(ticket.title || 'Bug').slice(0, 200)}** has been resolved. Solution documentation has been saved.`)
    .setColor(0x57f287)

  await interaction.editReply({ embeds: [embed] }).catch(() => {})
  await channel.send({ content: 'This bug ticket has been resolved. This channel is now read-only and will be removed in 14 days.', embeds: [embed] }).catch(() => {})
  // Below the project's archive divider, locked, stamped for deletion in 14
  // days. The same placement every other status writer uses.
  try {
    await move({ guild, task: ticket, before: ticket, updates: { status: 'resolved' }, db: dbArg })
  } catch (e) {
    console.warn('[resolve-bug] archive placement:', e?.message || e)
  }
}
