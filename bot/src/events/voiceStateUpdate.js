import db, { getOrCreateGuildConfig } from "../db/index.js";
import {
  startRecording,
  stopRecording,
  stopMeetingRecording,
  isRecording,
} from "../services/voiceCapture.js";
import { ensureMeetingChannel } from "../services/meetingListener.js";

/**
 * Fires whenever ANYONE's voice state changes (join, leave, mute, switch channel, etc).
 * We care about meeting voice channels that are already linked in the database,
 * regardless of their dynamic Discord name.
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

  if (joinedChannel && joinedChannel.id !== leftChannel?.id) {
    const meetingChannel = await findMeetingLink(joinedChannel);
    if (!meetingChannel?.meetingId) return;

    const humanCount = joinedChannel.members.filter((m) => !m.user.bot).size;
    if (humanCount === 1 && !isRecording(meetingChannel.meetingId)) {
      try {
        startRecording(joinedChannel, meetingChannel.meetingId);
        console.log(
          `[voiceAutoJoin] joined & recording in ${joinedChannel.name}`,
        );
      } catch (e) {
        console.error("[voiceAutoJoin] failed to start:", e.message);
      }
    }
  }

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
