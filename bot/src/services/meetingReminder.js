import db, { ensureStringArray } from '../db/index.js'
import { ensureMeetingChannel } from './meetingListener.js'
import { joinMeetingVoiceChannel, startMeetingAudioRecording } from './meetingAudioRecorder.js'

const CHANNEL_UPCOMING_MEETINGS = 'upcoming-meetings'
const WINDOW_MS = 10 * 60 * 1000 // 10 minutes
const INTERVAL_MS = 60 * 1000 // check every minute

/**
 * Start the meeting reminder loop. Every minute, finds meetings in the next 10 minutes
 * that haven't been reminded, posts to #upcoming-meetings and tags the invited members.
 */
export function startMeetingReminder(client) {
  if (!client?.guilds) return
  setInterval(async () => {
    try {
      const now = new Date()
      for (const [guildId, guild] of client.guilds.cache) {
        try {
          const meetings = await db.scheduledMeeting.findDueForReminder(guildId, now, WINDOW_MS)
          if (!meetings?.length) continue
          const channel = guild.channels.cache.find((c) => c.name === CHANNEL_UPCOMING_MEETINGS && c.isTextBased())
          if (!channel) continue
          for (const m of meetings) {
            const memberIds = ensureStringArray(m.memberIds)
            const mentions = memberIds.map((id) => `<@${id}>`).join(' ')
            const at = new Date(m.scheduledAt).toLocaleString()
            await channel.send({
              content: `**Meeting in ~10 minutes** — **${(m.topic || 'Meeting').slice(0, 100)}** at ${at}${mentions ? `\n${mentions}` : ''}`,
            }).catch(() => {})

            if (m.voiceChannelId && m.recordingEnabled) {
              try {
                const voiceChannel = guild.channels.cache.get(m.voiceChannelId)
                if (voiceChannel?.isVoiceBased?.()) {
                  const meetingChannel = await ensureMeetingChannel(guild, m.voiceChannelId)
                  const connection = await joinMeetingVoiceChannel(guild, voiceChannel, meetingChannel.meetingId)
                  if (connection) {
                    await startMeetingAudioRecording(connection, guild, meetingChannel.meetingId, m.voiceChannelId)
                  }
                }
              } catch (_) {}
            }

            await db.scheduledMeeting.update(m.id, { reminderSentAt: now })
          }
        } catch (_) {}
      }
    } catch (_) {}
  }, INTERVAL_MS)
}
