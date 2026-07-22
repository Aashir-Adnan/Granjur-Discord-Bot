import db, { getOrCreateGuildConfig } from '../db/index.js'
import { query } from '../Database/connection.js'
import { appendMeetingNotes } from '../services/meetingListener.js'

export async function handleMeetingMessageCreate(message) {
  if (!message.guild || message.author.bot || !message.channel?.isTextBased?.()) return

  const cfg = await getOrCreateGuildConfig(message.guild.id)
  const meetingChannel = await db.meetingChannel.findFirst({
    where: {
      guildConfigId: cfg.id,
      textChannelId: message.channel.id,
    },
  })

  if (!meetingChannel?.id || !meetingChannel?.meetingId) return

  const attachmentUrls = message.attachments?.map((attachment) => attachment.url) || []

  try {
    await query(
      `INSERT INTO meetingmessage (id, guildConfigId, meetingId, channelId, authorId, authorTag, content, attachmentUrls, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        message.id,
        cfg.id,
        meetingChannel.meetingId,
        message.channel.id,
        message.author.id,
        message.author.tag,
        message.content || '(no text)',
        JSON.stringify(attachmentUrls),
        new Date(),
      ],
    )
    console.log(`[meetingMessage] saved message ${message.id} for meeting ${meetingChannel.meetingId}`)
  } catch (err) {
    console.error('[meetingMessage] failed to save message:', err.message)
    return
  }

  await appendMeetingNotes(
    meetingChannel.id,
    message.author.id,
    message.author.tag,
    message.content || '(no text)',
    attachmentUrls,
  )
}
