/**
 * Meeting channels: bot joins voice, records/transcribes (optional), creates text channel for notes.
 * Store transcript and notes in DB; optional transcription API.
 * Multilanguage transcription can be wired to TRANSCRIPTION_API_KEY (e.g. OpenAI Whisper).
 */

import db, { getOrCreateGuildConfig } from '../db/index.js'
import { config } from '../config.js'

export async function ensureMeetingChannel(guild, voiceChannelId, options = {}) {
  const { forceNewMeeting = false, textChannelId } = options;
  const cfg = await getOrCreateGuildConfig(guild.id)
  const existing = await db.meetingChannel.findFirst({
    where: { guildConfigId: cfg.id, voiceChannelId },
  })

  if (!forceNewMeeting && existing) {
    if (textChannelId && existing.textChannelId !== textChannelId) {
      return db.meetingChannel.update({
        where: { id: existing.id },
        data: { textChannelId },
      })
    }
    return existing
  }

  const meeting = await db.meeting.create({
    data: {
      guildConfigId: cfg.id,
      channelId: voiceChannelId,
    },
  })

  if (existing) {
    await db.meetingChannel.update({
      where: { id: existing.id },
      data: { meetingId: meeting.id, ...(textChannelId ? { textChannelId } : {}) },
    });
    return { ...existing, meetingId: meeting.id, textChannelId: textChannelId ?? existing.textChannelId };
  }

  const meetingChannel = await db.meetingChannel.create({
    data: {
      guildConfigId: cfg.id,
      voiceChannelId,
      textChannelId: textChannelId ?? null,
      meetingId: meeting.id,
    },
  })
  return meetingChannel
}

export async function appendMeetingNotes(meetingChannelId, userId, userTag, content, attachmentUrls = []) {
  const mc = await db.meetingChannel.findUnique({
    where: { id: meetingChannelId },
  })
  if (!mc?.meetingId) return
  const meeting = await db.meeting.findUnique({ where: { id: mc.meetingId } })
  if (!meeting) return
  const notes = (meeting.notes || '') + `\n[${new Date().toISOString()}] ${userTag}: ${content}`
  if (attachmentUrls.length) {
    notes += '\nAttachments: ' + attachmentUrls.join(', ')
  }
  await db.meeting.update({
    where: { id: mc.meetingId },
    data: { notes: notes.slice(-10000) },
  })
}

export async function setMeetingTranscript(meetingId, transcript) {
  await db.meeting.update({
    where: { id: meetingId },
    data: { transcript: transcript?.slice(0, 50000) },
  })
}

/** Optional: call external transcription API (e.g. Whisper) for multilanguage support */
export async function transcribeAudio(audioBufferOrUrl) {
  if (!config.transcription?.apiKey) return null
  // Placeholder: implement with OpenAI Whisper or similar
  return null
}