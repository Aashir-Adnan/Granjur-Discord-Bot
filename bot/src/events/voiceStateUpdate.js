import {
  startRecording,
  stopRecording,
  isRecording,
} from "../services/voiceCapture.js";
import { ensureMeetingChannel } from "../services/meetingListener.js";

/**
 * Fires whenever ANYONE's voice state changes (join, leave, mute, switch channel, etc).
 * We only care about: a real (non-bot) user joining a voice channel that previously
 * had no one in it (so we don't re-join every time a second/third person arrives),
 * and everyone leaving a channel we were recording (so we auto-stop).
 */
export async function handleVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  // Ignore the bot's own voice state changes
  if (newState.member?.user?.bot) return;

  const joinedChannel = newState.channel;
  const leftChannel = oldState.channel;

  // Only auto-join the dedicated meeting-voice channel (created by /init),
  // not casual voice channels like voice-lounge — don't record everything.
  const isMeetingVoiceChannel = (channel) =>
    channel && channel.name?.toLowerCase() === "meeting-voice";

  // Case 1: someone joined the meeting-voice channel — auto-join if not already there
  if (
    joinedChannel &&
    joinedChannel.id !== leftChannel?.id &&
    isMeetingVoiceChannel(joinedChannel)
  ) {
    const humanCount = joinedChannel.members.filter((m) => !m.user.bot).size;
    if (humanCount === 1) {
      // first human in this channel — trigger auto-join + start recording
      try {
        const meetingChannel = await ensureMeetingChannel(
          guild,
          joinedChannel.id,
        );
        if (!isRecording(meetingChannel.meetingId)) {
          startRecording(joinedChannel, meetingChannel.meetingId);
          console.log(
            `[voiceAutoJoin] joined & recording in ${joinedChannel.name}`,
          );
        }
      } catch (e) {
        console.error("[voiceAutoJoin] failed to start:", e.message);
      }
    }
  }

  // Case 2: someone left the meeting-voice channel — if now empty, stop recording
  if (
    leftChannel &&
    leftChannel.id !== joinedChannel?.id &&
    isMeetingVoiceChannel(leftChannel)
  ) {
    const remainingHumans = leftChannel.members.filter((m) => !m.user.bot).size;
    if (remainingHumans === 0) {
      try {
        const meetingChannel = await ensureMeetingChannel(
          guild,
          leftChannel.id,
        );
        if (isRecording(meetingChannel.meetingId)) {
          stopRecording(meetingChannel.meetingId);
          console.log(
            `[voiceAutoJoin] stopped recording, ${leftChannel.name} is empty`,
          );
        }
      } catch (e) {
        console.error("[voiceAutoJoin] failed to stop:", e.message);
      }
    }
  }
}
