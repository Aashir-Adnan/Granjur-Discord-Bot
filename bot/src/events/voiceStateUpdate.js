import db, { getOrCreateGuildConfig } from "../db/index.js";
import { isRecording } from "../services/voiceCapture.js";

/**
 * Fires whenever ANYONE's voice state changes (join, leave, mute, switch channel, etc).
 * For scheduled meetings we only use the DB-linked voice channel record to decide
 * whether a channel is a tracked meeting room.
 *
 * Channel cleanup is handled by voiceCapture's endMeetingSession (with 5-minute grace period)
 * so this handler only logs the event — it does NOT delete channels or stop recording.
 */
export async function handleVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  const leftChannel = oldState.channel;

  if (!leftChannel || leftChannel.id === newState.channel?.id) return;

  const cfg = await getOrCreateGuildConfig(guild.id);

  const meetingChannel = await db.meetingChannel.findFirst({
    where: {
      guildConfigId: cfg.id,
      voiceChannelId: leftChannel.id,
    },
  });

  if (!meetingChannel?.meetingId) return;

  const remainingHumans = leftChannel.members.filter((m) => !m.user.bot).size;
  if (remainingHumans === 0) {
    console.log(
      `[voiceStateUpdate] Last human left ${leftChannel.name}, voiceCapture grace period will handle cleanup`,
    );
  }
}
