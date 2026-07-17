import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import {
  startRecording,
  stopRecording,
  isRecording,
} from "../services/voiceCapture.js";
import { ensureMeetingChannel } from "../services/meetingListener.js";

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
    startRecording(voiceChannel, meetingChannel.meetingId);
    const embed = new EmbedBuilder()
      .setTitle("Recording started")
      .setDescription(
        `Recording individual voices in **${voiceChannel.name}**. Run \`/record action:stop\` when done.`,
      )
      .setColor(0x57f287);
    return interaction.editReply({ embeds: [embed] });
  }

  const stopped = stopRecording(meetingChannel.meetingId);
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
