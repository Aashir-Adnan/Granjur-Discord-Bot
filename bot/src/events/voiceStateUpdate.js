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
    if (remainingHumans === 0) {
      // Stop recording if active
      if (isRecording(meetingChannel.meetingId)) {
        try {
          await stopMeetingRecording(meetingChannel.meetingId);
          console.log(
            `[voiceAutoJoin] stopped recording and ended meeting, ${leftChannel.name} is empty`,
          );
        } catch (e) {
          console.error("[voiceAutoJoin] failed to stop:", e.message);
        }
      }

      // Delete the voice and text channels when meeting ends (last user leaves)
      try {
        // Delete voice channel
        const voiceChannel = await guild.channels.fetch(leftChannel.id).catch(() => leftChannel);
        if (voiceChannel?.isVoiceBased?.()) {
          await voiceChannel.delete("Meeting ended - last user left").catch(() => {});
          console.log(`[voiceAutoJoin] deleted voice channel: ${leftChannel.name}`);
        }

        // Delete associated text channel if exists
        if (meetingChannel.textChannelId) {
          const textChannel = await guild.channels.fetch(meetingChannel.textChannelId).catch(() => null);
          if (textChannel?.isTextBased?.()) {
            await textChannel.delete("Meeting ended - last user left").catch(() => {});
            console.log(`[voiceAutoJoin] deleted text channel: ${textChannel.name}`);
          }
        }

        // Clean up database records
        await db.meetingChannel.deleteMany({
          where: {
            guildConfigId: cfg.id,
            voiceChannelId: leftChannel.id,
          },
        }).catch(() => {});

        // Clear the voiceChannelId from scheduledMeeting
        await db.query(
          "UPDATE `scheduledmeeting` SET voiceChannelId = NULL WHERE guildConfigId = ? AND voiceChannelId = ?",
          [cfg.id, leftChannel.id]
        ).catch(() => {});

      } catch (e) {
        console.error("[voiceAutoJoin] failed to clean up meeting channels:", e.message);
      }
    }
  }
}
