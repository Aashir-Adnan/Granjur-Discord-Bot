import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import prism from "prism-media";
import fs from "fs";
import path from "path";
import db, { getOrCreateGuildConfig } from "../db/index.js";

const activeConnections = new Map(); // meetingId -> connection
const MAX_RECORDING_SECONDS = 60 * 60 * 2; // 2 hours

export function startRecording(voiceChannel, meetingId) {
  if (activeConnections.has(meetingId)) {
    return activeConnections.get(meetingId); // already recording
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  const receiver = connection.receiver;
  const recordingsDir = path.join(process.cwd(), "recordings", meetingId);
  fs.mkdirSync(recordingsDir, { recursive: true });

  receiver.speaking.on("start", (userId) => {
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const opusDecoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });
    const filename = path.join(recordingsDir, `${userId}_${Date.now()}.pcm`);
    const outputFile = fs.createWriteStream(filename);

    opusStream.pipe(opusDecoder).pipe(outputFile);
    outputFile.on("finish", () => {
      console.log(`[voiceCapture] saved ${filename}`);
    });
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    activeConnections.delete(meetingId);
  });

  activeConnections.set(meetingId, connection);
  return connection;
}

export function stopRecording(meetingId) {
  const connection = activeConnections.get(meetingId);
  if (!connection) return false;
  connection.destroy();
  activeConnections.delete(meetingId);
  return true;
}

export function isRecording(meetingId) {
  return activeConnections.has(meetingId);
}

/**
 * Unified meeting recording: joins voice channel, records audio, and tracks in database.
 * Combines voice channel joining + audio recording + meeting record tracking.
 */
export async function startMeetingRecording(voiceChannel, guild, meetingId, voiceChannelId) {
  if (!voiceChannel || !guild || !meetingId) return null;
  if (activeConnections.has(meetingId)) {
    return activeConnections.get(meetingId); // already recording
  }

  const cfg = await getOrCreateGuildConfig(guild.id);

  // Join voice channel
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  // Setup recording directory
  const recordingsDir = path.join(process.cwd(), "recordings", meetingId);
  fs.mkdirSync(recordingsDir, { recursive: true });

  const receiver = connection.receiver;

  // Database logging for each recording
  const finishRecording = async (userId, filePath, startedAt, endedAt, fileName) => {
    const durationSeconds = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
    await db.meetingRecording
      .create({
        data: {
          guildConfigId: cfg.id,
          meetingId,
          memberId: userId,
          filePath,
          fileName,
          audioFormat: "opus",
          startedAt,
          endedAt,
          durationSeconds,
        },
      })
      .catch(() => {});
  };

  // Handle cleanup
  const cleanup = () => {
    activeConnections.delete(meetingId);
    clearTimeout(timeoutHandle);
  };

  // Auto-disconnect after max duration
  const timeoutHandle = setTimeout(() => {
    connection.destroy();
  }, MAX_RECORDING_SECONDS * 1000);

  // Listen for disconnection/destruction
  connection.on(VoiceConnectionStatus.Disconnected, cleanup);
  connection.on(VoiceConnectionStatus.Destroyed, cleanup);

  // Handle user speech and record
  receiver.speaking.on("start", (userId) => {
    const fileName = `meeting-${meetingId}-${userId}-${Date.now()}.opus`;
    const filePath = path.join(recordingsDir, fileName);
    const startedAt = new Date();

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 500,
      },
    });

    const writeStream = fs.createWriteStream(filePath);
    opusStream.pipe(writeStream);

    opusStream.on("end", () => {
      writeStream.end();
    });

    writeStream.on("finish", () => {
      finishRecording(userId, filePath, startedAt, new Date(), fileName).catch(() => {});
    });

    writeStream.on("error", () => {
      finishRecording(userId, filePath, startedAt, new Date(), fileName).catch(() => {});
    });
  });

  // Update meeting recording status in database
  if (voiceChannelId) {
    try {
      await db.meetingRecordingStatus
        .upsert({
          where: { meetingId },
          create: {
            meetingId,
            guildConfigId: cfg.id,
            status: "recording",
            voiceChannelId,
            startedAt: new Date(),
          },
          update: {
            status: "recording",
            voiceChannelId,
            startedAt: new Date(),
          },
        })
        .catch(() => {});
    } catch (_) {}
  }

  activeConnections.set(meetingId, connection);
  return connection;
}
