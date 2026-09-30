import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import * as csaasClient from '../services/csaasClient.js'
import { meetingPipelineEnabled } from '../Database/meetingPipelineJob.helpers.js'
import { extractDocText, downloadAttachment, DocTextError } from '../services/docText.js'
import { projectChoices } from './update-task.js'
import { EPHEMERAL } from '../constants.js'
import { PROJECT_DELETED, isDeletedProject } from '../utils/projectDeleted.js'

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
const CANT_POST = "I can't post in this channel — run /tasks-from-doc where I can send messages and attach files."
const QUEUE_FULL = 'This server already has 3 documents being turned into tasks. Try again when one is reviewed.'
// meeting.transcript (here and in CSAAS) is a TEXT column: 65,535 bytes, not
// characters. CSAAS stores "[segment_0]\n" + text, so leave room for its marker.
const MAX_TRANSCRIPT_BYTES = 65535 - 64
// CSAAS parses request bodies up to 100 KB; JSON escaping can grow the text a lot.
const MAX_JSON_BYTES = 95_000
const MAX_OPEN_DOCUMENT_JOBS = 3
// The review, the notes files and the pings all go to the command's channel.
const POST_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
]

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

  const perms = interaction.channel?.permissionsFor?.(interaction.client.user)
  if (!perms?.has(POST_PERMISSIONS)) return refuse(interaction, CANT_POST)

  const unfinished = await dbArg.meetingPipelineJob.findUnfinishedByGuild(cfg.id)
  const openDocuments = unfinished.filter(
    (j) => j.dataJson?.source === 'document' && j.status !== 'done' && j.status !== 'failed',
  )
  if (openDocuments.length >= MAX_OPEN_DOCUMENT_JOBS) return refuse(interaction, QUEUE_FULL)

  const rawProject = String(interaction.options.getString('project') || '').trim()
  let project = null
  if (rawProject) {
    project = await dbArg.project.findFirst({ where: { id: rawProject } }).catch(() => null)
    if (!project || project.guildConfigId !== cfg.id) return refuse(interaction, NO_PROJECT)
    if (isDeletedProject(project)) return refuse(interaction, PROJECT_DELETED)
  }

  const attachment = interaction.options.getAttachment('file')
  const fileName = attachment.name
  let text
  try {
    const buffer = await download(attachment)
    ;({ text } = await extract({ buffer, fileName }))
    if (
      Buffer.byteLength(text, 'utf8') > MAX_TRANSCRIPT_BYTES ||
      Buffer.byteLength(JSON.stringify(text), 'utf8') > MAX_JSON_BYTES
    ) {
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

  // A public message holding a user-chosen file name: it must not ping anyone.
  return interaction.editReply({
    content: `Reading **${fileName}** — the proposed tasks will be posted here for review.`,
    allowedMentions: { parse: [] },
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
