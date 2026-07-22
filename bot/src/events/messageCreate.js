import db, { getOrCreateGuildConfig } from '../db/index.js'
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

  await db.query(
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
  ).catch(() => {})

  await appendMeetingNotes(
    meetingChannel.id,
    message.author.id,
    message.author.tag,
    message.content || '(no text)',
    attachmentUrls,
  )
}
