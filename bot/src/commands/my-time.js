import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { isLeadershipFor } from '../utils/timeAccess.js'
import { showTimePanel } from '../services/timePanel.js'

export const data = new SlashCommandBuilder()
  .setName('my-time')
  .setDescription('See your tracked time, and fix or delete an entry')
  .addStringOption((o) =>
    o.setName('range').setDescription('How far back to look (default: this week)').setRequired(false).addChoices(
      { name: 'Today', value: 'today' },
      { name: 'This week', value: 'week' },
      { name: 'This month', value: 'month' },
      { name: 'All time', value: 'all' },
    ))
  .addUserOption((o) =>
    o.setName('person').setDescription('Whose time to show (CEO and Server Manager only)').setRequired(false))

export const NOT_LEADERSHIP = "Only CEO and Server Manager can view someone else's time."

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig, now = new Date() } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  // Somebody else's time is for leadership only, and is refused before any read.
  // Naming yourself is harmless and shows your own panel.
  const person = interaction.options.getUser('person')
  if (person && person.id !== interaction.user.id && !isLeadershipFor(guild, interaction.member, cfg)) {
    return interaction.editReply({ content: NOT_LEADERSHIP })
  }

  const rangeKey = interaction.options.getString('range') ?? 'week'
  return showTimePanel(interaction, { ownerId: person?.id ?? interaction.user.id, rangeKey, cfg }, { db: dbArg, getConfig, now })
}
