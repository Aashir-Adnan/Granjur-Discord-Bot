import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import prism from "prism-media";
import fs from "fs";
import path from "path";
import { once } from "node:events";
import db, { getOrCreateGuildConfig } from "../db/index.js";

const activeConnections = new Map(); // meetingId -> { connection, guild, voiceChannel }
const MAX_RECORDING_SECONDS = 60 * 60 * 2; // 2 hours

export function startRecording(voiceChannel, meetingId) {
  if (activeConnections.has(meetingId)) {
    return activeConnections.get(meetingId).connection; // already recording
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

  activeConnections.set(meetingId, { connection, guild: voiceChannel.guild, voiceChannel });
  return connection;
}

export async function stopRecording(meetingId) {
  const recorder = activeConnections.get(meetingId);
  if (!recorder) return false;
  const { connection, guild, voiceChannel } = recorder;
  connection.destroy();

  try {
    const botMember = await guild.members.fetch(guild.client.user.id).catch(() => null);
    if (botMember?.voice?.channelId === voiceChannel.id) {
      await botMember.voice.disconnect("Meeting ended");
      console.log(`[voiceCapture] explicit disconnect done for meeting ${meetingId}`);
    }
  } catch (e) {
    console.warn(`[voiceCapture] explicit disconnect failed for meeting ${meetingId}: ${e?.message || e}`);
  }

  activeConnections.delete(meetingId);
  return true;
}

/**
 * Stop meeting recording and update database status
 */
export async function stopMeetingRecording(meetingId) {
  const recorder = activeConnections.get(meetingId);
  if (!recorder) {
    console.warn(`[voiceCapture] no active connection for meeting: ${meetingId}`);
    return false;
  }

  const { connection, guild, voiceChannel } = recorder;

  try {
    await db.meetingRecordingStatus.update({
      where: { meetingId },
      data: {
        status: "completed",
        endedAt: new Date(),
      },
    });
    console.log(`[voiceCapture] updated meeting status to completed: ${meetingId}`);
  } catch (err) {
    console.error(`[voiceCapture] failed to update meeting status: ${err.message}`);
  }

  connection.destroy();

  try {
    const botMember = await guild.members.fetch(guild.client.user.id).catch(() => null);
    if (botMember?.voice?.channelId === voiceChannel.id) {
      await botMember.voice.disconnect("Meeting ended");
      console.log(`[voiceCapture] explicit disconnect done for meeting ${meetingId}`);
    }
  } catch (e) {
    console.warn(`[voiceCapture] explicit disconnect failed for meeting ${meetingId}: ${e?.message || e}`);
  }

  activeConnections.delete(meetingId);
  return true;
}

export function isRecording(meetingId) {
  return activeConnections.has(meetingId);
}

/**
 * Unified meeting recording: joins voice channel, records audio, and tracks in database.
 * Combines voice channel joining + audio recording + meeting record tracking.
 * Ends recording when all human members leave the channel.
 */
export async function startMeetingRecording(voiceChannel, guild, meetingId, voiceChannelId, options = {}) {
  const { deleteOnEnd = false, textChannelId = null } = options;
  if (!voiceChannel || !guild || !meetingId) return null;
  if (activeConnections.has(meetingId)) {
    return activeConnections.get(meetingId).connection; // already recording
  }

  const cfg = await getOrCreateGuildConfig(guild.id);

  // Join voice channel
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  console.log(`[voiceCapture] joining voice channel ${voiceChannel.id} for meeting ${meetingId}`);

  try {
    await once(connection, VoiceConnectionStatus.Ready);
    console.log(`[voiceCapture] voice connection ready for meeting ${meetingId}`);
  } catch (e) {
    console.error(`[voiceCapture] voice connection did not become ready for meeting ${meetingId}: ${e?.message || e}`);
    connection.destroy();
    return null;
  }

  // Setup recording directory
  const recordingsDir = path.join(process.cwd(), "recordings", meetingId);
  fs.mkdirSync(recordingsDir, { recursive: true });
  console.log(`[voiceCapture] recording directory ready: ${recordingsDir}`);

  const receiver = connection.receiver;
  // Track pending file-write promises for this meeting recording session
  const pendingWrites = new Set();

  // Database logging for each recording
  const finishRecording = async (userId, filePath, startedAt, endedAt, fileName) => {
    const durationSeconds = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));

    console.log(`[voiceCapture] duration of recording ${durationSeconds}s`)
    try {
      const result = await db.meetingRecording.create({
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
      });
      console.log(`[voiceCapture] saved recording to DB: ${result.id}`);
    } catch (err) {
      console.error(`[voiceCapture] failed to save recording: ${err.message}`, err);
    }
  };

  // End meeting session
  const endMeetingSession = async () => {
    console.log(`[voiceCapture] ending meeting session: ${meetingId}`);
    try {
      try {
        await Promise.all(Array.from(pendingWrites));
      } catch (e) {
        console.warn(`[voiceCapture] error while waiting for pending writes: ${e?.message || e}`);
      }

      await db.meetingRecordingStatus.update({
        where: { meetingId },
        data: {
          status: "completed",
          endedAt: new Date(),
        },
      });
      console.log(`[voiceCapture] updated meeting status to completed: ${meetingId}`);
    } catch (err) {
      console.error(`[voiceCapture] failed to update meeting status: ${err.message}`);
    }

    connection.destroy();

    try {
      const me = guild.members.me;
      if (me?.voice?.channelId === voiceChannel.id) {
        await me.voice.disconnect("Meeting ended");
        console.log(`[voiceCapture] explicitly disconnected bot from ${voiceChannel.id}`);
      }
    } catch (e) {
      console.warn(`[voiceCapture] bot disconnect fallback failed: ${e?.message || e}`);
    }

    try { cleanup(); } catch (_) {}

    if (deleteOnEnd) {
      try {
        await voiceChannel.delete(`Meeting ${meetingId} ended`).catch(() => {});
      } catch (e) {
        console.warn(`[voiceCapture] failed to delete voice channel: ${e?.message || e}`);
      }
    }

    if (textChannelId) {
      try {
        const textChannel = guild.channels.cache.get(textChannelId);
        if (textChannel?.isTextBased?.()) {
          await textChannel.delete(`Meeting ${meetingId} ended`).catch(() => {});
        }
      } catch (e) {
        console.warn(`[voiceCapture] failed to delete text channel: ${e?.message || e}`);
      }
    }
  };

  let emptyChecks = 0;
  const checkChannelEmpty = () => {
    const voiceState = voiceChannel.members;
    const humanMembers = voiceState.filter(member => !member.user.bot);

    if (humanMembers.size === 0) {
      emptyChecks += 1;
      if (emptyChecks >= 2) {
        console.log(`[voiceCapture] channel is empty for consecutive checks, ending meeting: ${meetingId}`);
        endMeetingSession();
        return true;
      }
      return false;
    }

    emptyChecks = 0;
    return false;
  };

  // Handle cleanup
  const cleanup = () => {
    activeConnections.delete(meetingId);
    clearTimeout(timeoutHandle);
    clearInterval(channelCheckInterval);
  };

  // Monitor channel for empty state (check every 5 seconds)
  const channelCheckInterval = setInterval(() => {
    checkChannelEmpty();
  }, 5000);

  // Auto-disconnect after max duration
  const timeoutHandle = setTimeout(() => {
    console.log(`[voiceCapture] max recording duration reached, ending meeting: ${meetingId}`);
    endMeetingSession();
  }, MAX_RECORDING_SECONDS * 1000);

  // Listen for disconnection/destruction
  connection.on(VoiceConnectionStatus.Disconnected, cleanup);
  connection.on(VoiceConnectionStatus.Destroyed, cleanup);

  // Handle user speech and record
  receiver.speaking.on("start", (userId) => {
    console.log(`[voiceCapture] speaking start detected for user ${userId} in meeting ${meetingId}`);

    const fileName = `meeting-${meetingId}-${userId}-${Date.now()}.opus`;
    const filePath = path.join(recordingsDir, fileName);
    const startedAt = new Date();

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 500,
      },
    });

    console.log(`[voiceCapture] subscribed to voice stream for user ${userId}, writing ${filePath}`);

    const writeStream = fs.createWriteStream(filePath);
    opusStream.pipe(writeStream);

    // Create a promise that resolves once this recording has been saved to DB
    let resolveWrite;
    const writePromise = new Promise((resolve) => { resolveWrite = resolve; });
    pendingWrites.add(writePromise);

    opusStream.on("end", () => {
      writeStream.end();
    });

    const finalize = () => {
      finishRecording(userId, filePath, startedAt, new Date(), fileName)
        .catch(() => {})
        .finally(() => {
          pendingWrites.delete(writePromise);
          resolveWrite();
        });
    };

    writeStream.on("finish", finalize);
    writeStream.on("error", finalize);
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

  activeConnections.set(meetingId, { connection, guild, voiceChannel });
  return connection;
}
