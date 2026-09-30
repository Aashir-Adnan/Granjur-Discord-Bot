import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import * as csaasClient from '../services/csaasClient.js'
import { meetingPipelineEnabled } from '../Database/meetingPipelineJob.helpers.js'
import { extractDocText, downloadAttachment, DocTextError } from '../services/docText.js'
import { projectChoices } from './update-task.js'
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('tasks-from-doc')
  .setDescription('Turn a document into proposed tasks, reviewed here like a meeting')
  .addAttachmentOption((o) =>
    o.setName('file').setDescription('A .txt, .md, .json, .pdf or .docx file').setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName('project')
      .setDescription('Start typing a project name (default: none)')
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addStringOption((o) =>
    o.setName('title').setDescription('A title for the review (default: the file name)').setRequired(false).setMaxLength(100),
  )

const NOT_AVAILABLE = 'Tasks from documents are not available on this server yet.'
const NO_PROJECT = 'No project matches that name.'

const withoutExtension = (name) => String(name || 'document').replace(/\.[^./\\]+$/, '') || 'document'

// The accepted reply is public, and Discord fixes the ephemeral flag when the
// interaction is first acknowledged. So this command is NOT deferred by
// index.js (see MODAL_FIRST_COMMANDS in commands/index.js): the cheap refusals
// go out as ephemeral replies, and only then is the reply deferred publicly
// for the download and extraction. A DocTextError after that point is sent
// with editReply, so it is public.
export async function execute(
  interaction,
  {
    db: dbArg = db,
    getConfig = getOrCreateGuildConfig,
    enabled = meetingPipelineEnabled,
    configured = csaasClient.isConfigured,
    download = downloadAttachment,
    extract = extractDocText,
  } = {},
) {
  const guild = interaction.guild
  if (!guild) return interaction.reply({ content: 'Use this command inside a server.', flags: EPHEMERAL })
  if (!enabled() || !configured()) return interaction.reply({ content: NOT_AVAILABLE, flags: EPHEMERAL })

  const cfg = await getConfig(guild.id)
  if (!cfg) return interaction.reply({ content: 'Server not initialized. Run **/init** first.', flags: EPHEMERAL })

  const rawProject = String(interaction.options.getString('project') || '').trim()
  let project = null
  if (rawProject) {
    project = await dbArg.project.findFirst({ where: { id: rawProject } }).catch(() => null)
    if (!project || project.guildConfigId !== cfg.id) {
      return interaction.reply({ content: NO_PROJECT, flags: EPHEMERAL })
    }
  }

  await interaction.deferReply()

  const attachment = interaction.options.getAttachment('file')
  let text
  try {
    const buffer = await download(attachment)
    ;({ text } = await extract({ buffer, fileName: attachment.name }))
  } catch (e) {
    if (e instanceof DocTextError) return interaction.editReply({ content: e.message })
    throw e
  }

  const fileName = attachment.name
  const title = String(interaction.options.getString('title') || '').trim() || withoutExtension(fileName)

  const meeting = await dbArg.meeting.create({
    data: {
      guildConfigId: cfg.id,
      channelId: interaction.channelId,
      ...(project ? { projectId: project.id } : {}),
      transcript: text,
    },
  })
  // One write, so the worker can never claim the job before it knows it is a document job.
  await dbArg.meetingPipelineJob.create({
    data: {
      guildConfigId: cfg.id,
      meetingId: meeting.id,
      dataJson: { source: 'document', reviewChannelId: interaction.channelId, documentName: fileName, title },
    },
  })

  return interaction.editReply({
    content: `Reading **${fileName}** — the proposed tasks will be posted here for review.`,
  })
}

export async function autocomplete(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'project') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getConfig(interaction.guild.id)
    const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
    return interaction.respond(projectChoices(projects, focused.value, { withDetach: false })).catch(() => {})
  } catch (e) {
    console.error('[tasks-from-doc] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}
