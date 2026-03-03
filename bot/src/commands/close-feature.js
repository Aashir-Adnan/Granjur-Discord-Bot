import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import db from '../db/index.js'
import { lockChannelAndScheduleDeletion } from '../utils/channels.js'
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('close-feature')
  .setDescription('Close this feature ticket (feature channel only). Attach MD file describing the feature.')
  .addAttachmentOption((o) =>
    o.setName('doc').setDescription('MD file describing the feature').setRequired(false)
  )

export async function execute(interaction) {
  const channel = interaction.channel
  const guild = interaction.guild
  if (!guild || !channel) return interaction.editReply({ content: 'Use this in a server channel.' })

  const feature = await db.feature.findFirst({ where: { discordChannelId: channel.id } })
  if (!feature) {
    return interaction.editReply({
      content: 'This command can only be used inside a **feature ticket** channel. Open one with **/create-task** (choose Feature) first.',
    })
  }
  if (feature.status === 'closed') {
    return interaction.editReply({ content: 'This feature ticket is already closed.' })
  }

  const attachment = interaction.options.getAttachment('doc')
  let content = null
  if (attachment) {
    if (!attachment.contentType?.startsWith('text/') && !attachment.name?.toLowerCase().endsWith('.md')) {
      return interaction.editReply({
        content: 'Please attach a Markdown (.md) or text file describing the feature.',
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
      content: 'Please run **/close-feature** again and attach an **MD file** that describes the contents of the feature implemented.',
    })
  }

  const doc = await db.ticketDoc.findFirst({ where: { taskId: feature.id } })
  if (doc) await db.ticketDoc.update({ where: { id: doc.id }, data: { content } })

  await db.feature.update({ where: { id: feature.id }, data: { status: 'closed', implementationStatus: 'done' } })

  const embed = new EmbedBuilder()
    .setTitle('Feature ticket closed')
    .setDescription(`**${feature.title?.slice(0, 200)}** has been closed. Documentation has been saved.`)
    .setColor(0x57f287)

  await interaction.editReply({ embeds: [embed] }).catch(() => {})
  await channel.send({ content: 'This feature ticket has been closed. This channel will be locked and deleted in 5 minutes.', embeds: [embed] }).catch(() => {})
  await lockChannelAndScheduleDeletion(channel)
}
