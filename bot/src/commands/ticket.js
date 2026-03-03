import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Update bug ticket status — select ticket, then new status')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)

  const tickets = await db.bugTicket.findMany({
    where: { guildConfigId: cfg.id },
    orderBy: { createdAt: 'desc' },
    take: 25,
  })
  if (!tickets.length) {
    return interaction.editReply({ content: 'No bug tickets. Create one with **/create-task** (choose Bug).' })
  }

  const embed = new EmbedBuilder()
    .setTitle('Update ticket status')
    .setDescription('**Step 1:** Select the ticket.')
    .setColor(0xed4245)
    .setFooter({ text: 'Step 1 of 2' })

  const options = tickets.map((t) => ({
    label: (t.title || t.id).slice(0, 100),
    value: t.id,
    description: `Status: ${t.status} • ${t.createdAt.toISOString().slice(0, 10)}`,
  }))

  const select = new StringSelectMenuBuilder()
    .setCustomId('ticket_select')
    .setPlaceholder('Select ticket')
    .addOptions(options)

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  })
}

export async function handleTicketSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const ticketId = interaction.values[0]
  const cfg = await getOrCreateGuildConfig(guild.id)
  const ticket = await db.bugTicket.findFirst({ where: { id: ticketId, guildConfigId: cfg.id } })
  if (!ticket) return interaction.editReply({ content: 'Ticket not found.', components: [], embeds: [] }).catch(() => {})

  const embed = new EmbedBuilder()
    .setTitle('Update ticket status')
    .setDescription(`**Step 2:** Choose new status for **${ticket.title || ticket.id}**.`)
    .addFields({ name: 'Current status', value: ticket.status, inline: true })
    .setColor(0xed4245)
    .setFooter({ text: 'Step 2 of 2' })

  const select = new StringSelectMenuBuilder()
    .setCustomId(`ticket_status:${ticketId}`)
    .setPlaceholder('Select status')
    .addOptions(
      { label: 'Pending', value: 'pending', description: 'In progress' },
      { label: 'Resolved', value: 'resolved', description: 'Fixed' },
      { label: 'Abandoned', value: 'abandoned', description: 'Won\'t fix' }
    )

  await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] })
}

export async function handleStatusSelect(interaction) {
  const customId = interaction.customId || ''
  if (!customId.startsWith('ticket_status:')) return
  const ticketId = customId.slice('ticket_status:'.length)
  const status = interaction.values?.[0]
  if (!status) return

  await db.bugTicket.update({ where: { id: ticketId }, data: { status } })

  const embed = new EmbedBuilder()
    .setTitle('Ticket updated')
    .setDescription(`Status set to **${status}**.`)
    .setColor(0x57f287)

  await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {})
}
