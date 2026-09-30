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
// meeting.transcript is a TEXT column: 65,535 bytes, not characters.
const MAX_TRANSCRIPT_BYTES = 65535

const withoutExtension = (name) => String(name || 'document').replace(/\.[^./\\]+$/, '') || 'document'

// index.js has already deferred this command PUBLICLY (PUBLIC_REPLY_COMMANDS),
// so the accepted reply is the deferred one. Discord fixes the ephemeral flag
// at the first acknowledgement, so a refusal removes the public placeholder and
// sends an ephemeral follow-up instead.
async function refuse(interaction, content) {
  await interaction.deleteReply().catch(() => {})
  return interaction.followUp({ content, flags: EPHEMERAL })
}

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
  if (!guild) return refuse(interaction, 'Use this command inside a server.')
  if (!enabled() || !configured()) return refuse(interaction, NOT_AVAILABLE)

  const cfg = await getConfig(guild.id)
  if (!cfg) return refuse(interaction, 'Server not initialized. Run **/init** first.')

  const rawProject = String(interaction.options.getString('project') || '').trim()
  let project = null
  if (rawProject) {
    project = await dbArg.project.findFirst({ where: { id: rawProject } }).catch(() => null)
    if (!project || project.guildConfigId !== cfg.id) return refuse(interaction, NO_PROJECT)
  }

  const attachment = interaction.options.getAttachment('file')
  const fileName = attachment.name
  let text
  try {
    const buffer = await download(attachment)
    ;({ text } = await extract({ buffer, fileName }))
    if (Buffer.byteLength(text, 'utf8') > MAX_TRANSCRIPT_BYTES) {
      throw new DocTextError(`**${fileName}** is too long to store. Split it into smaller files.`)
    }
  } catch (e) {
    if (e instanceof DocTextError) return refuse(interaction, e.message)
    throw e
  }

  const title = String(interaction.options.getString('title') || '').trim() || withoutExtension(fileName)

  const meeting = await dbArg.meeting.create({
    data: {
      guildConfigId: cfg.id,
      channelId: interaction.channelId,
      ...(project ? { projectId: project.id } : {}),
      transcript: text,
    },
  })
  try {
    // One write, so the worker can never claim the job before it knows it is a document job.
    await dbArg.meetingPipelineJob.create({
      data: {
        guildConfigId: cfg.id,
        meetingId: meeting.id,
        dataJson: { source: 'document', reviewChannelId: interaction.channelId, documentName: fileName, title },
      },
    })
  } catch (e) {
    // No job will ever read this meeting; do not leave it behind.
    await dbArg.meeting.delete({ where: { id: meeting.id } }).catch((err) => {
      console.warn('[tasks-from-doc] could not remove the meeting after the job failed:', err?.message || err)
    })
    throw e
  }

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
