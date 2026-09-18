import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import {
  startMeetingRecording,
  stopMeetingRecording,
  isRecording,
} from "../services/voiceCapture.js";
import { ensureMeetingChannel } from "../services/meetingListener.js";
import { resolveMeetingChannel } from "../services/meetingPipelineStages.js";
import { ensureGuidelinesPinned } from "../config/meetingGuidelines.js";
import db from "../db/index.js";

export const data = new SlashCommandBuilder()
  .setName("record")
  .setDescription(
    "Start or stop recording individual voices in your current voice channel",
  )
  .addStringOption((o) =>
    o
      .setName("action")
      .setDescription("start or stop")
      .setRequired(true)
      .addChoices(
        { name: "start", value: "start" },
        { name: "stop", value: "stop" },
      ),
  );

export async function execute(interaction) {
  const guild = interaction.guild;
  if (!guild)
    return interaction.editReply({ content: "Use this in a server." });

  const member = await guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice?.channel;
  if (!voiceChannel) {
    return interaction.editReply({
      content: "Join a voice channel first, then run this command.",
    });
  }

  const action = interaction.options.getString("action");
  const meetingChannel = await ensureMeetingChannel(guild, voiceChannel.id);

  if (action === "start") {
    if (isRecording(meetingChannel.meetingId)) {
      return interaction.editReply({
        content: "Already recording this meeting.",
      });
    }
    // The unified session: per-user capture, MeetingRecordingStatus row, empty-channel
    // grace timer, and the meeting-pipeline enqueue when the session ends.
    await startMeetingRecording(voiceChannel, guild, meetingChannel.meetingId, voiceChannel.id);
    // The channel the transcript and the review will land in gets the guidelines.
    // Recording is already running by this point, so a database blip here must not
    // reach the command's error path: "Something went wrong, please try again" for
    // a live recording invites the user to start a second one.
    try {
      const target = await resolveMeetingChannel(interaction.client, db, {
        meetingId: meetingChannel.meetingId,
        guildConfigId: meetingChannel.guildConfigId,
      });
      if (target) await ensureGuidelinesPinned(target, guild.client.user.id);
    } catch (e) {
      console.warn(`[record] could not pin the guidelines: ${e?.message || e}`);
    }
    const embed = new EmbedBuilder()
      .setTitle("Recording started")
      .setDescription(
        `Recording individual voices in **${voiceChannel.name}**. Run \`/record action:stop\` when done.`,
      )
      .setColor(0x57f287);
    return interaction.editReply({ embeds: [embed] });
  }

  const stopped = await stopMeetingRecording(meetingChannel.meetingId);
  const embed = new EmbedBuilder()
    .setTitle(stopped ? "Recording stopped" : "Not recording")
    .setDescription(
      stopped
        ? `Stopped recording **${voiceChannel.name}**. Audio saved per-user in \`recordings/${meetingChannel.meetingId}/\`.`
        : "No active recording found for this channel.",
    )
    .setColor(stopped ? 0x57f287 : 0xed4245);
  return interaction.editReply({ embeds: [embed] });
}
