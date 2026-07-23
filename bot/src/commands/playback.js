import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import db, { getOrCreateGuildConfig } from "../db/index.js";
import fs from "fs";
import path from "path";

export const data = new SlashCommandBuilder()
  .setName("playback")
  .setDescription("(CEO/Server Manager) Play back a meeting recording in a voice channel");

const activePlayers = new Map(); // guildId -> { player, connection }

export async function execute(interaction) {
  const guild = interaction.guild;
  if (!guild)
    return interaction.editReply({ content: "Use this in a server." });

  const cfg = await getOrCreateGuildConfig(guild.id);
  const recordings = await db.meetingRecording.findMany({
    where: { guildConfigId: cfg.id },
  });

  if (!recordings || recordings.length === 0) {
    return interaction.editReply({ content: "No recordings found." });
  }

  // Group by meeting, show most recent meetings
  const byMeeting = {};
  for (const r of recordings) {
    (byMeeting[r.meetingId] = byMeeting[r.meetingId] || []).push(r);
  }

  const meetingIds = Object.keys(byMeeting).slice(0, 25);
  const options = meetingIds.map((mid) => {
    const recs = byMeeting[mid];
    const date = recs[0]?.startedAt
      ? new Date(recs[0].startedAt).toISOString().slice(0, 16).replace("T", " ")
      : "unknown";
    const fileNames = recs.map((r) => r.fileName?.replace(".ogg", "")).join(", ");
    return {
      label: `${mid.slice(0, 8)}... (${date})`,
      value: mid,
      description: `${recs.length} recording(s): ${fileNames}`.slice(0, 100),
    };
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId("playback_select_meeting")
    .setPlaceholder("Select a meeting to play back")
    .addOptions(options);

  const embed = new EmbedBuilder()
    .setTitle("Playback — Select Meeting")
    .setDescription("Choose a meeting to see its recordings.")
    .setColor(0x5865f2);

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

export async function handleMeetingSelect(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const meetingId = interaction.values?.[0];
  if (!meetingId) return;

  const cfg = await getOrCreateGuildConfig(guild.id);
  const recordings = await db.meetingRecording.findMany({
    where: { guildConfigId: cfg.id, meetingId },
  });

  if (!recordings || recordings.length === 0) {
    return interaction.editReply({
      content: "No recordings found for this meeting.",
      embeds: [],
      components: [],
    });
  }

  const options = recordings
    .filter((r) => r.filePath && fs.existsSync(r.filePath))
    .slice(0, 25)
    .map((r) => ({
      label: r.fileName || r.memberId,
      value: r.id,
      description: `${r.durationSeconds || 0}s — ${r.memberId}`.slice(0, 100),
    }));

  if (options.length === 0) {
    return interaction.editReply({
      content: "No playable recordings found on disk for this meeting.",
      embeds: [],
      components: [],
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("playback_select_recording")
    .setPlaceholder("Select a recording to play")
    .addOptions(options);

  const embed = new EmbedBuilder()
    .setTitle("Playback — Select Recording")
    .setDescription(
      `Found **${options.length}** recording(s) on disk.\nSelect one to play in your current voice channel.\n\n**You must be in a voice channel.**`,
    )
    .setColor(0x5865f2);

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

export async function handleRecordingSelect(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const recordingId = interaction.values?.[0];
  if (!recordingId) return;

  const cfg = await getOrCreateGuildConfig(guild.id);
  const recordings = await db.meetingRecording.findMany({
    where: { guildConfigId: cfg.id },
  });
  const recording = (recordings || []).find((r) => r.id === recordingId);

  if (!recording || !recording.filePath || !fs.existsSync(recording.filePath)) {
    return interaction.editReply({
      content: "Recording file not found on disk.",
      embeds: [],
      components: [],
    });
  }

  // User must be in a voice channel
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.editReply({
      content: "You must be in a voice channel to play recordings.",
      embeds: [],
      components: [],
    });
  }

  // Stop any existing playback
  const existing = activePlayers.get(guild.id);
  if (existing) {
    try { existing.player.stop(); } catch (_) {}
    try { existing.connection.destroy(); } catch (_) {}
    activePlayers.delete(guild.id);
  }

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    const player = createAudioPlayer();
    const resource = createAudioResource(recording.filePath);

    player.play(resource);
    connection.subscribe(player);

    activePlayers.set(guild.id, { player, connection });

    player.on(AudioPlayerStatus.Idle, () => {
      connection.destroy();
      activePlayers.delete(guild.id);
    });

    player.on("error", (err) => {
      console.error(`[playback] Player error:`, err.message);
      connection.destroy();
      activePlayers.delete(guild.id);
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      activePlayers.delete(guild.id);
    });

    await interaction.editReply({
      content: `Playing **${recording.fileName}** in <#${voiceChannel.id}>`,
      embeds: [],
      components: [],
    });
  } catch (err) {
    console.error(`[playback] Failed to play:`, err.message);
    await interaction.editReply({
      content: `Failed to play recording: ${err.message}`,
      embeds: [],
      components: [],
    });
  }
}
