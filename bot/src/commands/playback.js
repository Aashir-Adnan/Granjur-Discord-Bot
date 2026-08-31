import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
} from "@discordjs/voice";
import prism from "prism-media";
import db, { getOrCreateGuildConfig } from "../db/index.js";
import fs from "fs";
import path from "path";

const SEEK_STEP = 10; // seconds for rewind/forward

// Seek needs ffmpeg (via ffmpeg-static, auto-detected by prism-media). If it's
// missing we still play from the start and just disable the seek buttons.
let _ffmpegOk = null;
function ffmpegAvailable() {
  if (_ffmpegOk === null) {
    try {
      prism.FFmpeg.getInfo();
      _ffmpegOk = true;
    } catch (_) {
      _ffmpegOk = false;
      console.warn("[playback] ffmpeg not found — rewind/forward disabled. Install ffmpeg-static.");
    }
  }
  return _ffmpegOk;
}

export const data = new SlashCommandBuilder()
  .setName("playback")
  .setDescription("(CEO/Server Manager) Play back a meeting recording in a voice channel");

const activePlayers = new Map(); // guildId -> { player, connection }

// Resolve a human-friendly name for a Discord member id.
// Tries the guild member display name, then their stored email local-part, then the raw id.
async function resolveDisplayName(guild, memberId) {
  try {
    const gm = await guild.members.fetch(memberId);
    if (gm?.displayName) return gm.displayName;
  } catch (_) {}
  try {
    const record = await db.guildMember.findUnique({
      where: { guildId_discordId: { guildId: guild.id, discordId: memberId } },
    });
    if (record?.email) return record.email.split("@")[0];
  } catch (_) {}
  return memberId;
}

// Derive a readable meeting name from the recordings directory
// (voiceCapture names it "<meetingId8>-<topic-slug>"), falling back to the id.
function deriveMeetingName(filePath, meetingId) {
  try {
    if (filePath) {
      const dir = path.basename(path.dirname(filePath));
      const slug = dir.replace(/^[0-9a-f]{6,8}-/i, "").trim();
      if (slug && slug.toLowerCase() !== "meeting") {
        return slug
          .split(/[-_\s]+/)
          .filter(Boolean)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
      }
    }
  } catch (_) {}
  return `Meeting ${String(meetingId).slice(0, 8)}`;
}

function formatMeetingDate(value) {
  if (!value) return "date unknown";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "date unknown";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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

  // Most recent meetings first (recordings are returned newest-first from the DB)
  const meetingIds = Object.keys(byMeeting)
    .sort((a, b) => {
      const ta = new Date(byMeeting[a][0]?.startedAt || 0).getTime();
      const tb = new Date(byMeeting[b][0]?.startedAt || 0).getTime();
      return tb - ta;
    })
    .slice(0, 25);

  const options = meetingIds.map((mid) => {
    const recs = byMeeting[mid];
    // Earliest recording = when the meeting started
    const startedAt = recs
      .map((r) => r.startedAt)
      .filter(Boolean)
      .sort((a, b) => new Date(a) - new Date(b))[0];
    const name = deriveMeetingName(recs[0]?.filePath, mid);
    const date = formatMeetingDate(startedAt);
    return {
      label: `${name} — ${date}`.slice(0, 100),
      value: mid,
      description: `${recs.length} recording(s)`.slice(0, 100),
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

  const playable = recordings
    .filter((r) => r.filePath && fs.existsSync(r.filePath))
    .slice(0, 25);

  const options = await Promise.all(
    playable.map(async (r) => {
      const name = await resolveDisplayName(guild, r.memberId);
      return {
        label: `${name} Recording`.slice(0, 100),
        value: r.id,
        description: `${r.durationSeconds || 0}s`.slice(0, 100),
      };
    }),
  );

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

// ---------- transport controls ----------

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, "0")}`;
}

function progressBar(pos, dur, width = 18) {
  if (!dur || dur <= 0) return "▬".repeat(width);
  const i = Math.min(width - 1, Math.max(0, Math.round((pos / dur) * (width - 1))));
  return "▬".repeat(i) + "🔘" + "▬".repeat(width - 1 - i);
}

function currentPos(state) {
  const played = state.resource ? state.resource.playbackDuration / 1000 : 0;
  const p = state.offsetSec + played;
  return state.durationSec ? Math.min(state.durationSec, p) : p;
}

function controlsRow(paused) {
  const canSeek = ffmpegAvailable();
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("playback_rewind").setEmoji("⏪").setLabel("10s").setStyle(ButtonStyle.Secondary).setDisabled(!canSeek),
    new ButtonBuilder().setCustomId("playback_toggle").setEmoji(paused ? "▶️" : "⏸️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("playback_forward").setEmoji("⏩").setLabel("10s").setStyle(ButtonStyle.Secondary).setDisabled(!canSeek),
    new ButtonBuilder().setCustomId("playback_stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
  );
}

function nowPlayingEmbed(state, { ended = false } = {}) {
  const pos = ended ? state.durationSec : currentPos(state);
  const label = ended ? "Finished" : state.paused ? "Paused" : "Playing";
  return new EmbedBuilder()
    .setTitle(`${label} — ${state.speakerName} Recording`)
    .setDescription(
      `${progressBar(pos, state.durationSec)}\n\`${fmtTime(pos)} / ${fmtTime(state.durationSec)}\` · <#${state.channelId}>`,
    )
    .setColor(ended ? 0x99aab5 : state.paused ? 0xfaa61a : 0x57f287);
}

function startFfmpeg(filePath, seconds) {
  const args = [
    "-ss", String(Math.max(0, seconds)),
    "-i", filePath,
    "-analyzeduration", "0",
    "-loglevel", "0",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
  ];
  const ff = new prism.FFmpeg({ args });
  const resource = createAudioResource(ff, { inputType: StreamType.Raw });
  return { ff, resource };
}

function playFrom(state, seconds, paused) {
  try { state.ff?.destroy(); } catch (_) {}
  seconds = Math.max(0, seconds);
  let resource;
  let ff = null;
  if (seconds === 0 && !ffmpegAvailable()) {
    // No ffmpeg — play the file directly (prism demuxes the OGG). No seeking.
    resource = createAudioResource(state.filePath);
  } else {
    ({ ff, resource } = startFfmpeg(state.filePath, seconds));
  }
  state.ff = ff;
  state.resource = resource;
  state.offsetSec = seconds;
  state.paused = !!paused;
  state.player.play(resource);
  if (paused) state.player.pause();
}

async function editControlMessage(state, { ended = false } = {}) {
  if (!state.ixn) return;
  await state.ixn
    .editReply({
      content: "",
      embeds: [nowPlayingEmbed(state, { ended })],
      components: ended ? [] : [controlsRow(state.paused)],
    })
    .catch(() => {});
}

function teardown(guildId, announceIxn) {
  const state = activePlayers.get(guildId);
  if (!state) return;
  activePlayers.delete(guildId);
  try { state.ff?.destroy(); } catch (_) {}
  try { state.player.stop(); } catch (_) {}
  try { state.connection.destroy(); } catch (_) {}
  if (announceIxn) {
    announceIxn
      .editReply({
        content: `Stopped **${state.speakerName} Recording**.`,
        embeds: [],
        components: [],
      })
      .catch(() => {});
  }
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

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.editReply({
      content: "You must be in a voice channel to play recordings.",
      embeds: [],
      components: [],
    });
  }

  teardown(guild.id); // stop any existing playback

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);

    const state = {
      guildId: guild.id,
      player,
      connection,
      ff: null,
      resource: null,
      filePath: recording.filePath,
      speakerName: await resolveDisplayName(guild, recording.memberId),
      channelId: voiceChannel.id,
      durationSec: recording.durationSeconds || 0,
      offsetSec: 0,
      paused: false,
      ended: false,
      ixn: interaction,
    };
    activePlayers.set(guild.id, state);

    player.on(AudioPlayerStatus.Idle, () => {
      const s = activePlayers.get(guild.id);
      if (!s || s.paused || s.ended) return;
      // Ignore the brief Idle that happens between resources during a seek.
      if (s.durationSec && currentPos(s) < s.durationSec - 1.5) return;
      s.ended = true;
      editControlMessage(s, { ended: true }).finally(() => {
        setTimeout(() => teardown(guild.id), 1500);
      });
    });

    player.on("error", (err) => {
      console.error(`[playback] Player error:`, err.message);
      teardown(guild.id);
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      activePlayers.delete(guild.id);
    });

    playFrom(state, 0, false);

    await interaction.editReply({
      content: "",
      embeds: [nowPlayingEmbed(state)],
      components: [controlsRow(false)],
    });
  } catch (err) {
    console.error(`[playback] Failed to play:`, err.message);
    teardown(guild.id);
    await interaction.editReply({
      content: `Failed to play recording: ${err.message}`,
      embeds: [],
      components: [],
    });
  }
}

export async function handleControl(interaction) {
  const guild = interaction.guild;
  const state = guild && activePlayers.get(guild.id);
  if (!state) {
    return interaction
      .editReply({ content: "Playback has ended.", embeds: [], components: [] })
      .catch(() => {});
  }
  state.ixn = interaction;
  const id = interaction.customId;

  if (id === "playback_stop") {
    teardown(guild.id, interaction);
    return;
  }
  if (state.ended) return editControlMessage(state, { ended: true });

  if ((id === "playback_rewind" || id === "playback_forward") && !ffmpegAvailable()) {
    return editControlMessage(state);
  }

  if (id === "playback_toggle") {
    if (state.paused) {
      state.player.unpause();
      state.paused = false;
    } else {
      state.player.pause();
      state.paused = true;
    }
  } else if (id === "playback_rewind") {
    playFrom(state, Math.max(0, currentPos(state) - SEEK_STEP), state.paused);
  } else if (id === "playback_forward") {
    const target = currentPos(state) + SEEK_STEP;
    if (state.durationSec && target >= state.durationSec - 1) {
      state.ended = true;
      try { state.player.stop(); } catch (_) {}
      await editControlMessage(state, { ended: true });
      setTimeout(() => teardown(guild.id), 1500);
      return;
    }
    playFrom(state, target, state.paused);
  }

  await editControlMessage(state);
}
