// Review-UI interaction handlers + /meeting-review and /meeting-retry slash commands.
// Component handlers ack with interaction.update(...) / interaction.reply({ ephemeral });
// slash execute runs after index.js has deferReply'd, so it uses interaction.editReply(...).

import { SlashCommandBuilder } from 'discord.js'
import db from '../db/index.js'
import { applyReviewAction, buildReviewMessage } from '../services/meetingReviewUI.js'

const KINDS = new Set([
  'mtg_assignee',
  'mtg_gh',
  'mtg_taskreject',
  'mtg_page',
  'mtg_approve',
  'mtg_reject',
])

/**
 * Pure. `mtg_<kind>:<jobId>[:<taskId...>]`.
 * taskId is undefined for approve/reject; for mtg_page it is the page number as a string.
 * A taskId containing ':' is preserved intact.
 */
export function parseReviewCustomId(customId) {
  const raw = String(customId || '')
  const idx = raw.indexOf(':')
  if (idx === -1) return { kind: raw, jobId: undefined, taskId: undefined }
  const kind = raw.slice(0, idx)
  const rest = raw.slice(idx + 1)
  const j = rest.indexOf(':')
  if (j === -1) return { kind, jobId: rest, taskId: undefined }
  return { kind, jobId: rest.slice(0, j), taskId: rest.slice(j + 1) }
}

function isActive(job) {
  return !!job && job.stage === 'awaiting_review' && job.status === 'blocked'
}

async function handleComponentAction(interaction, kind, jobId, taskId) {
  const job = await db.meetingPipelineJob.findById(jobId).catch(() => null)
  if (!isActive(job)) {
    return interaction.reply({ content: 'This review is no longer active.', ephemeral: true })
  }

  let action
  if (kind === 'mtg_assignee') {
    const ref = interaction.values?.[0] ?? null
    action = { type: 'assignee', taskId, ref }
  } else if (kind === 'mtg_gh') {
    action = { type: 'toggleGithub', taskId }
  } else if (kind === 'mtg_taskreject') {
    action = { type: 'rejectTask', taskId }
  } else if (kind === 'mtg_page') {
    action = { type: 'page', page: Number(taskId) }
  } else {
    return
  }

  const newState = applyReviewAction(job.dataJson.review, action)
  const updatedJob = await db.meetingPipelineJob.update(jobId, {
    dataJson: { ...job.dataJson, review: newState },
  })

  return interaction.update(
    buildReviewMessage({
      job: updatedJob,
      notes: job.dataJson.notes,
      reportPath: null,
      state: newState,
      roster: job.dataJson.roster,
    }),
  )
}

async function handleApprove(interaction, jobId) {
  const job = await db.meetingPipelineJob.findById(jobId).catch(() => null)
  if (!job || job.status !== 'blocked') {
    return interaction.reply({ content: 'Already processed.', ephemeral: true })
  }
  const ok = await db.meetingPipelineJob.updateIf(
    jobId, { stage: 'approved', status: 'pending' }, { status: 'blocked' },
  )
  if (!ok) {
    return interaction.reply({ content: 'This review was already processed.', ephemeral: true })
  }
  return interaction.update({ content: '✅ Approved — assigning tasks…', embeds: [], components: [] })
}

async function handleReject(interaction, jobId) {
  const job = await db.meetingPipelineJob.findById(jobId).catch(() => null)
  if (!job || job.status !== 'blocked') {
    return interaction.reply({ content: 'Already processed.', ephemeral: true })
  }
  const ok = await db.meetingPipelineJob.updateIf(
    jobId,
    {
      dataJson: { ...job.dataJson, review: { ...job.dataJson.review, meetingRejected: true } },
      stage: 'approved',
      status: 'pending',
    },
    { status: 'blocked' },
  )
  if (!ok) {
    return interaction.reply({ content: 'This review was already processed.', ephemeral: true })
  }
  return interaction.update({ content: '❌ Meeting rejected — no tasks created.', embeds: [], components: [] })
}

/** Router used by handlers/interactions.js for any `mtg_`-prefixed component. */
export async function route(interaction) {
  const { kind, jobId, taskId } = parseReviewCustomId(interaction.customId || '')
  if (!KINDS.has(kind) || !jobId) {
    return interaction.reply({ content: 'This review is no longer active.', ephemeral: true }).catch(() => {})
  }
  if (kind === 'mtg_approve') return handleApprove(interaction, jobId)
  if (kind === 'mtg_reject') return handleReject(interaction, jobId)
  return handleComponentAction(interaction, kind, jobId, taskId)
}

// ---- slash commands -----------------------------------------------------

export const data = [
  new SlashCommandBuilder()
    .setName('meeting-review')
    .setDescription('Re-post the task-review UI for a meeting')
    .addStringOption((o) =>
      o.setName('meeting').setDescription('Meeting id (from the bot) — "latest" is not supported').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('meeting-retry')
    .setDescription('Re-queue a failed meeting pipeline job')
    .addStringOption((o) => o.setName('meeting').setDescription('Meeting id (from the bot)').setRequired(true)),
]

async function resolveJob(meetingArg) {
  if (!meetingArg || meetingArg === 'latest') return null
  return db.meetingPipelineJob.findByMeeting(meetingArg).catch(() => null)
}

export async function execute(interaction) {
  const name = interaction.commandName
  const meetingArg = interaction.options.getString('meeting')

  if (name === 'meeting-review') {
    if (meetingArg === 'latest') {
      return interaction.editReply({
        content: '"latest" is not supported — pass a meeting id (there is no findLatest in the DB layer).',
      })
    }
    const job = await resolveJob(meetingArg)
    if (!job) return interaction.editReply({ content: 'No pipeline job found for that meeting.' })
    if (job.stage !== 'awaiting_review') {
      return interaction.editReply({ content: `That job is not awaiting review (stage: ${job.stage}).` })
    }
    const payload = buildReviewMessage({
      job,
      notes: job.dataJson?.notes,
      reportPath: null,
      state: job.dataJson?.review,
      roster: job.dataJson?.roster,
    })
    const msg = await interaction.channel.send(payload)
    await db.meetingPipelineJob.update(job.id, { reviewMessageId: msg.id }).catch(() => {})
    return interaction.editReply({ content: 'Re-posted the review UI in this channel.' })
  }

  if (name === 'meeting-retry') {
    const job = await resolveJob(meetingArg)
    if (!job) return interaction.editReply({ content: 'No pipeline job found for that meeting.' })
    if (job.status !== 'failed') {
      return interaction.editReply({ content: `That job is not in a failed state (${job.status}).` })
    }
    await db.meetingPipelineJob.update(job.id, {
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    })
    return interaction.editReply({ content: 'Re-queued the meeting pipeline job.' })
  }
}
