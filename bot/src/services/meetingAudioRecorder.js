import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { EndBehaviorType, VoiceConnectionStatus } from '@discordjs/voice'
import db, { getOrCreateGuildConfig } from '../db/index.js'

const RECORDINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../recordings')
const MAX_RECORDING_SECONDS = 60 * 60 * 2
const ACTIVE_MEETING_CONNECTIONS = new Set()

function ensureRecordingsDir() {
  if (!existsSync(RECORDINGS_DIR)) {
    mkdirSync(RECORDINGS_DIR, { recursive: true })
  }
}

export async function startMeetingAudioRecording(connection, guild, meetingId, voiceChannelId) {
  if (!connection || ACTIVE_MEETING_CONNECTIONS.has(meetingId)) return
  ACTIVE_MEETING_CONNECTIONS.add(meetingId)

  ensureRecordingsDir()
  const cfg = await getOrCreateGuildConfig(guild.id)

  const finishRecording = async (userId, filePath, startedAt, endedAt, fileName) => {
    const durationSeconds = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))
    await db.meetingRecording.create({
      data: {
        guildConfigId: cfg.id,
        meetingId,
        memberId: userId,
        filePath,
        fileName,
        audioFormat: 'opus',
        startedAt,
        endedAt,
        durationSeconds,
      },
    }).catch(() => {})
  }

  const cleanup = () => {
    ACTIVE_MEETING_CONNECTIONS.delete(meetingId)
    clearTimeout(timeoutHandle)
  }

  const timeoutHandle = setTimeout(() => {
    connection.destroy()
  }, MAX_RECORDING_SECONDS * 1000)

  connection.on(VoiceConnectionStatus.Disconnected, cleanup)
  connection.on(VoiceConnectionStatus.Destroyed, cleanup)

  connection.receiver.speaking.on('start', (userId) => {
    const fileName = `meeting-${meetingId}-${userId}-${Date.now()}.opus`
    const filePath = join(RECORDINGS_DIR, fileName)
    const startedAt = new Date()
    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 500,
      },
    })

    const writeStream = createWriteStream(filePath)
    opusStream.pipe(writeStream)

    opusStream.on('end', () => {
      writeStream.end()
    })

    writeStream.on('finish', () => {
      finishRecording(userId, filePath, startedAt, new Date(), fileName).catch(() => {})
    })

    writeStream.on('error', () => {
      finishRecording(userId, filePath, startedAt, new Date(), fileName).catch(() => {})
    })
  })

  if (voiceChannelId) {
    try {
      await db.meetingRecordingStatus.upsert({
        where: { meetingId },
        create: {
          meetingId,
          guildConfigId: cfg.id,
          status: 'recording',
          voiceChannelId,
          startedAt: new Date(),
        },
        update: {
          status: 'recording',
          voiceChannelId,
          startedAt: new Date(),
        },
      }).catch(() => {})
    } catch (_) {}
  }
}
