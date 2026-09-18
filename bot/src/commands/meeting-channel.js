import { SlashCommandBuilder, ChannelType } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { ensureMeetingChannel } from '../services/meetingListener.js'
import { ensureGuidelinesPinned } from '../config/meetingGuidelines.js'
import { projectFromChannel } from '../services/projectSection.js'
import { projectChoices } from './update-task.js'
import { CATEGORY_SOFT_CAP } from '../constants.js'

const CATEGORY_MEETINGS = '📋 Meetings'

/** A meeting makes two channels: the text one and the voice one. */
const CHANNELS_PER_MEETING = 2

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
  .addStringOption((option) =>
    option
      .setName('project')
      .setDescription('Start typing a project name (default: the project whose channel you are in)')
      .setRequired(false)
      .setAutocomplete(true),
  )

const valuesOf = (cache) =>
  cache?.values ? [...cache.values()] : Array.isArray(cache) ? cache : []

const PROJECT_READ_FAILED =
  'I could not load the projects just now, so nothing was created. Try again in a moment.'

/**
 * The project this meeting belongs to: the one named by the `project` option,
 * else the one whose section the command was run in, else none.
 *
 * Returns `{ project }` (null project = no project, today's behaviour) or
 * `{ refusal }` when nothing should be created. A named project that does not
 * resolve is refused rather than quietly turned into a public meeting, and so
 * is a failed project read: inside a project's section that would otherwise
 * put the meeting in the public category.
 */
async function resolveProject(interaction, cfg, dbArg) {
  const raw = String(interaction.options.getString('project') || '').trim()
  if (raw) {
    let row
    try {
      row = await dbArg.project.findFirst({ where: { id: raw } })
    } catch (e) {
      console.warn(`[meeting-channel] project read failed: ${e?.message || e}`)
      return { refusal: PROJECT_READ_FAILED }
    }
    if (!row || row.guildConfigId !== cfg.id) {
      return {
        refusal: `No project matches **${raw.slice(0, 80)}**. Start typing a project name and pick one from the list.`,
      }
    }
    return { project: row }
  }
  let projects
  try {
    projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
  } catch (e) {
    console.warn(`[meeting-channel] project read failed: ${e?.message || e}`)
    return { refusal: PROJECT_READ_FAILED }
  }
  const inferred = projectFromChannel(projects, interaction.channel)
  if (inferred && inferred.guildConfigId === cfg.id) return { project: inferred }
  return { project: null }
}

/**
 * The project's own category when it can take this meeting's two channels,
 * else `{ category: null, note }` saying why the meeting falls back to the
 * global category.
 */
async function projectCategoryFor(guild, project) {
  const id = project?.discordCategoryId ? String(project.discordCategoryId) : null
  const noSection = `**${project?.name}** has no section yet — run \`/project-setup\` — so this meeting went to the global **${CATEGORY_MEETINGS}** category instead.`
  if (!id) return { category: null, note: noSection }
  const cached = guild.channels?.cache?.get?.(id)
  const category =
    cached ?? (await Promise.resolve(guild.channels?.fetch?.(id)).catch(() => null)) ?? null
  if (!category || category.type !== ChannelType.GuildCategory) {
    return { category: null, note: noSection }
  }
  const children = valuesOf(guild.channels?.cache).filter((c) => c?.parentId === category.id).length
  if (children + CHANNELS_PER_MEETING > CATEGORY_SOFT_CAP) {
    return {
      category: null,
      note: `**${project.name}**'s section is at Discord's ${CATEGORY_SOFT_CAP}-channel cap, so this meeting went to the global **${CATEGORY_MEETINGS}** category instead.`,
    }
  }
  return { category, note: null }
}

async function globalMeetingsCategory(guild) {
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
  return category
}

export async function execute(
  interaction,
  { db: dbArg = db, getConfig = getOrCreateGuildConfig, ensureMeeting = ensureMeetingChannel } = {},
) {
  const guild = interaction.guild
  if (!guild) {
    return interaction.editReply({ content: 'Use this command inside a server.' })
  }

  const cfg = await getConfig(guild.id)
  if (!cfg) {
    return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })
  }

  const resolved = await resolveProject(interaction, cfg, dbArg)
  if (resolved.refusal) return interaction.editReply({ content: resolved.refusal })
  const project = resolved.project

  const placement = project ? await projectCategoryFor(guild, project) : { category: null, note: null }
  // In the project's own category both channels are created with NO overwrites,
  // so Discord copies the category's (@everyone denied, the project role
  // allowed). Anywhere else the creation calls are exactly as they always were,
  // including the voice channel's @everyone allow.
  const inProject = Boolean(placement.category)
  const category = placement.category ?? (await globalMeetingsCategory(guild))

  const baseName = `${makeFriendlyBaseName(interaction.options.getString('name'))}-${Date.now().toString(36)}`
  const textChannel = await guild.channels.create({
    name: `${baseName}-text`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: 'Meeting chat is stored in the database with the sender and timestamp.',
  })

  await ensureGuidelinesPinned(textChannel, guild.client.user.id)

  const voiceChannel = inProject
    ? await guild.channels.create({
        name: `${baseName}-voice`,
        type: ChannelType.GuildVoice,
        parent: category.id,
      })
    : await guild.channels.create({
        name: `${baseName}-voice`,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [
              'ViewChannel',
              'Connect',
              'Speak',
              'UseVAD',
              'ReadMessageHistory',
            ],
          },
        ],
      })

  // The meeting belongs to the project even when its channels fell back.
  const meetingChannel = await ensureMeeting(guild, voiceChannel.id, {
    textChannelId: textChannel.id,
    ...(project ? { projectId: project.id } : {}),
  })

  const lines = [
    project
      ? `Created a dedicated meeting pair for **${project.name}**.`
      : 'Created a dedicated meeting pair for this session.',
    `Voice: <#${voiceChannel.id}>`,
    `Text: <#${textChannel.id}>`,
    `DB link: meeting ${meetingChannel?.meetingId || 'pending'}`,
  ]
  if (placement.note) lines.push(placement.note)
  await interaction.editReply({ content: lines.join('\n') })
}

export async function autocomplete(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'project') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getConfig(interaction.guild.id)
    const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
    return interaction.respond(projectChoices(projects, focused.value, { withDetach: false })).catch(() => {})
  } catch (e) {
    console.error('[meeting-channel] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}
