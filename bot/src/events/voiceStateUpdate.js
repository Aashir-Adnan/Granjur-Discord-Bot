import db, { getOrCreateGuildConfig } from "../db/index.js";
import { stopMeetingRecording, isRecording } from "../services/voiceCapture.js";

/**
 * Fires whenever ANYONE's voice state changes (join, leave, mute, switch channel, etc).
 * For scheduled meetings we only use the DB-linked voice channel record to decide
 * whether a channel is a tracked meeting room. We do not start a second recorder here.
 */
export async function handleVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  const joinedChannel = newState.channel;
  const leftChannel = oldState.channel;

  const cfg = await getOrCreateGuildConfig(guild.id);

  const findMeetingLink = async (channel) => {
    if (!channel || !channel.isVoiceBased?.()) return null;
    return db.meetingChannel.findFirst({
      where: {
        guildConfigId: cfg.id,
        voiceChannelId: channel.id,
      },
    });
  };

  if (leftChannel && leftChannel.id !== joinedChannel?.id) {
    const meetingChannel = await findMeetingLink(leftChannel);
    if (!meetingChannel?.meetingId) return;

    const remainingHumans = leftChannel.members.filter((m) => !m.user.bot).size;
    if (remainingHumans === 0 && isRecording(meetingChannel.meetingId)) {
      try {
        await stopMeetingRecording(meetingChannel.meetingId);
        console.log(
          `[voiceAutoJoin] stopped recording and ended meeting, ${leftChannel.name} is empty`,
        );
      } catch (e) {
        console.error("[voiceAutoJoin] failed to stop:", e.message);
      }
    }
  }
}
