import { SlashCommandBuilder, ChannelType } from 'discord.js'
import { getOrCreateGuildConfig } from '../db/index.js'
import { ensureMeetingChannel } from '../services/meetingListener.js'

const CATEGORY_MEETINGS = '📋 Meetings'

function makeFriendlyBaseName(input) {
  const raw = (input || 'meeting').trim()
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

  return cleaned || 'meeting'
}

export const data = new SlashCommandBuilder()
  .setName('meeting-channel')
  .setDescription('Create a dedicated meeting voice + text channel pair for note capture')
  .addStringOption((option) =>
    option
      .setName('name')
      .setDescription('Optional meeting name for the new channels')
      .setRequired(false),
  )

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) {
    return interaction.editReply({ content: 'Use this command inside a server.' })
  }

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) {
    return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })
  }

  let category = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildCategory && channel.name === CATEGORY_MEETINGS,
  )

  if (!category) {
    category = await guild.channels.create({
      name: CATEGORY_MEETINGS,
      type: ChannelType.GuildCategory,
    })
  }

  const baseName = `${makeFriendlyBaseName(interaction.options.getString('name'))}-${Date.now().toString(36)}`
  const textChannel = await guild.channels.create({
    name: `${baseName}-text`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: 'Meeting chat is stored in the database with the sender and timestamp.',
  })

  const voiceChannel = await guild.channels.create({
    name: `${baseName}-voice`,
    type: ChannelType.GuildVoice,
    parent: category.id,
  })

  const meetingChannel = await ensureMeetingChannel(guild, voiceChannel.id, {
    textChannelId: textChannel.id,
  })

  await interaction.editReply({
    content: `Created a dedicated meeting pair for this session.\nVoice: <#${voiceChannel.id}>\nText: <#${textChannel.id}>\nDB link: meeting ${meetingChannel?.meetingId || 'pending'}`,
  })
}
