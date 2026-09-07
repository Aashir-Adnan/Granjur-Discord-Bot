import { EmbedBuilder } from 'discord.js'

// The footer is how an already-pinned copy is recognised on a later call.
// Changing this string orphans every existing pin — don't.
export const GUIDELINES_MARKER = 'Granjur meeting guidelines'

export function buildGuidelinesEmbed() {
  return new EmbedBuilder()
    .setTitle('📋 How meetings work here')
    .setColor(0x5865f2)
    .setDescription(
      '**This channel receives a live transcript.** While the bot is recording, ' +
      'everything said in the voice channel appears here as text, attributed to ' +
      'whoever said it.',
    )
    .addFields(
      {
        name: 'Commands',
        value: [
          '`/record action:start` — start recording the voice channel you are in',
          '`/record action:stop` — stop recording and start the analysis',
          '`/schedule` — schedule a meeting; the bot creates the channels and joins',
          '`/meetings` — list scheduled meetings',
          '`/meeting-channel` — create a dedicated meeting voice + text channel',
          '`/meeting-review` — reopen the task review for a meeting',
          '`/meeting-retry` — retry a meeting whose processing failed',
          '`/playback` — play back a recorded meeting',
        ].join('\n'),
      },
      {
        name: 'The flow, start to end',
        value: [
          '**1.** The bot joins and plays a short cue — recording has started.',
          '**2.** The transcript appears here as people speak.',
          '**3.** Recording ends when the last person leaves (after a 2-minute grace period) or someone runs `/record action:stop`.',
          '**4.** The transcript is analysed and turned into proposed tasks.',
          '**5.** A review message posts here: check each task, set its assignee, approve or reject.',
          '**6.** On approval the tasks are created, each gets a private ticket channel, and assignees are notified.',
        ].join('\n'),
      },
    )
    .setFooter({ text: GUIDELINES_MARKER })
}

// Recording consent. It used to be posted by the live transcript feed, which only
// exists when CSAAS answered — so a meeting recorded against a down backend was
// announced by nothing at all. Consent is unconditional, so this is posted from
// the recording-start path instead, whatever the backend is doing.
export const CONSENT_NOTICE =
  '🎙️ **This meeting is being recorded and transcribed.** ' +
  'Everything said in the voice channel will appear in this channel as text.'

/**
 * Post the recording-consent notice. Never throws: a channel the bot cannot post
 * in must not stop the recording that is already starting.
 */
export async function postConsentNotice(channel) {
  if (!channel?.isTextBased?.()) return false
  try {
    await channel.send({ content: CONSENT_NOTICE, allowedMentions: { parse: [] } })
    return true
  } catch (e) {
    console.warn(`[meetingGuidelines] could not post the consent notice: ${e?.message || e}`)
    return false
  }
}

export function findGuidelinesPin(messages, botUserId) {
  for (const m of messages || []) {
    if (m?.author?.id !== botUserId) continue
    const hit = (m.embeds || []).some((e) => e?.footer?.text === GUIDELINES_MARKER)
    if (hit) return m
  }
  return null
}

/**
 * Post and pin the guidelines unless they are already pinned here.
 * Never throws: a missing permission must not take down channel creation or
 * `/record`, which is what actually matters at these call sites.
 */
export async function ensureGuidelinesPinned(channel, botUserId) {
  if (!channel?.isTextBased?.()) return false
  try {
    const pinned = await channel.messages.fetchPinned()
    if (findGuidelinesPin(pinned.values ? [...pinned.values()] : pinned, botUserId)) return false
    const msg = await channel.send({ embeds: [buildGuidelinesEmbed()] })
    await msg.pin()
    return true
  } catch (e) {
    console.warn(`[meetingGuidelines] could not pin guidelines: ${e?.message || e}`)
    return false
  }
}
