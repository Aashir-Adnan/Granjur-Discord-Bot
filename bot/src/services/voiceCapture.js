import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  getVoiceConnection,
  AudioPlayerStatus,
} from "@discordjs/voice";
import prism from "prism-media";
import fs from "fs";
import path from "path";
import db, { getOrCreateGuildConfig } from "../db/index.js";

const activeConnections = new Map(); // meetingId -> connection
const MAX_RECORDING_SECONDS = 60 * 60 * 2; // 2 hours

/**
 * Wait for voice connection to reach Ready state
 */
function waitForConnectionReady(connection, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (connection.state.status === VoiceConnectionStatus.Ready) {
      return resolve(connection);
    }

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Voice connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      connection.off(VoiceConnectionStatus.Ready, onReady);
      connection.off(VoiceConnectionStatus.Disconnected, onDisconnected);
      connection.off(VoiceConnectionStatus.Destroyed, onDestroyed);
      connection.off(VoiceConnectionStatus.Error, onError);
    };

    const onReady = () => {
      console.log(`[voiceCapture] Voice connection ready for meeting`);
      cleanup();
      resolve(connection);
    };

    const onDisconnected = () => {
      cleanup();
      reject(new Error("Voice connection disconnected before ready"));
    };

    const onDestroyed = () => {
      cleanup();
      reject(new Error("Voice connection destroyed before ready"));
    };

    const onError = (error) => {
      cleanup();
      reject(new Error(`Voice connection error: ${error.message}`));
    };

    connection.on(VoiceConnectionStatus.Ready, onReady);
    connection.on(VoiceConnectionStatus.Disconnected, onDisconnected);
    connection.on(VoiceConnectionStatus.Destroyed, onDestroyed);
    connection.on(VoiceConnectionStatus.Error, onError);
  });
}

/**
 * Start recording audio from a voice channel (legacy function)
 */
export function startRecording(voiceChannel, meetingId) {
  if (activeConnections.has(meetingId)) {
    console.log(`[voiceCapture] Already recording meeting: ${meetingId}`);
    return activeConnections.get(meetingId);
  }

  console.log(`[voiceCapture] Starting recording for meeting: ${meetingId} in channel: ${voiceChannel.id}`);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  const receiver = connection.receiver;
  const recordingsDir = path.join(process.cwd(), "recordings", meetingId);
  fs.mkdirSync(recordingsDir, { recursive: true });
  console.log(`[voiceCapture] Created recordings directory: ${recordingsDir}`);

  // Wait for connection to be ready before listening for speech
  waitForConnectionReady(connection)
    .then(() => {
      console.log(`[voiceCapture] Connection ready, listening for speech in meeting: ${meetingId}`);

      receiver.speaking.on("start", (userId) => {
        console.log(`[voiceCapture] User started speaking: ${userId} in meeting: ${meetingId}`);

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

        // Handle stream errors
        opusStream.on("error", (err) => {
          console.error(`[voiceCapture] Opus stream error for user ${userId}:`, err.message);
          outputFile.destroy();
        });

        opusDecoder.on("error", (err) => {
          console.error(`[voiceCapture] Opus decoder error for user ${userId}:`, err.message);
          outputFile.destroy();
        });

        outputFile.on("error", (err) => {
          console.error(`[voiceCapture] Write stream error for user ${userId}:`, err.message);
        });

        outputFile.on("finish", () => {
          console.log(`[voiceCapture] Saved recording: ${filename}`);
        });

        // Properly handle stream lifecycle
        opusStream.on("end", () => {
          console.log(`[voiceCapture] Opus stream ended for user ${userId}`);
          opusDecoder.end();
        });

        opusDecoder.on("end", () => {
          outputFile.end();
        });

        opusStream.pipe(opusDecoder).pipe(outputFile);
      });

      receiver.speaking.on("error", (err) => {
        console.error(`[voiceCapture] Speaking event error:`, err.message);
      });
    })
    .catch((err) => {
      console.error(`[voiceCapture] Failed to establish voice connection for meeting ${meetingId}:`, err.message);
      connection.destroy();
      activeConnections.delete(meetingId);
    });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    console.log(`[voiceCapture] Connection disconnected for meeting: ${meetingId}`);
    activeConnections.delete(meetingId);
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    console.log(`[voiceCapture] Connection destroyed for meeting: ${meetingId}`);
    activeConnections.delete(meetingId);
  });

  connection.on(VoiceConnectionStatus.Error, (error) => {
    console.error(`[voiceCapture] Connection error for meeting ${meetingId}:`, error.message);
  });

  activeConnections.set(meetingId, connection);
  return connection;
}

export function stopRecording(meetingId) {
  const connection = activeConnections.get(meetingId);
  if (!connection) {
    console.log(`[voiceCapture] No active recording to stop for meeting: ${meetingId}`);
    return false;
  }
  console.log(`[voiceCapture] Stopping recording for meeting: ${meetingId}`);
  connection.destroy();
  activeConnections.delete(meetingId);
  return true;
}

/**
 * Stop meeting recording and update database status
 */
export async function stopMeetingRecording(meetingId) {
  const connection = activeConnections.get(meetingId);
  if (!connection) {
    console.warn(`[voiceCapture] No active connection for meeting: ${meetingId}`);
    return false;
  }

  try {
    await db.meetingRecordingStatus.update({
      where: { meetingId },
      data: {
        status: "completed",
        endedAt: new Date(),
      },
    });
    console.log(`[voiceCapture] Updated meeting status to completed: ${meetingId}`);
  } catch (err) {
    console.error(`[voiceCapture] Failed to update meeting status: ${err.message}`);
  }

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
 * Ends recording when all human members leave the channel.
 */
export async function startMeetingRecording(voiceChannel, guild, meetingId, voiceChannelId, options = {}) {
  const { deleteOnEnd = false, textChannelId = null } = options;

  if (!voiceChannel || !guild || !meetingId) {
    console.error(`[voiceCapture] Invalid parameters for startMeetingRecording`);
    return null;
  }

  if (activeConnections.has(meetingId)) {
    console.log(`[voiceCapture] Already recording meeting: ${meetingId}`);
    return activeConnections.get(meetingId);
  }

  console.log(`[voiceCapture] Starting meeting recording for: ${meetingId} in channel: ${voiceChannel.id}`);

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
  console.log(`[voiceCapture] Created recordings directory: ${recordingsDir}`);

  const receiver = connection.receiver;
  const pendingWrites = new Set();

  // Database logging for each recording
  const finishRecording = async (userId, filePath, startedAt, endedAt, fileName) => {
    const durationSeconds = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));

    console.log(`[voiceCapture] Recording duration: ${durationSeconds}s for user ${userId}`);
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
      console.log(`[voiceCapture] Saved recording to DB: ${result.id}`);
    } catch (err) {
      console.error(`[voiceCapture] Failed to save recording to DB: ${err.message}`, err);
    }
  };

  // End meeting session
  const endMeetingSession = async () => {
    console.log(`[voiceCapture] Ending meeting session: ${meetingId}`);
    try {
      try {
        await Promise.all(Array.from(pendingWrites));
      } catch (e) {
        console.warn(`[voiceCapture] Error waiting for pending writes: ${e?.message || e}`);
      }

      await db.meetingRecordingStatus.update({
        where: { meetingId },
        data: {
          status: "completed",
          endedAt: new Date(),
        },
      });
      console.log(`[voiceCapture] Updated meeting status to completed: ${meetingId}`);
    } catch (err) {
      console.error(`[voiceCapture] Failed to update meeting status: ${err.message}`);
    }

    connection.destroy();
    try { cleanup(); } catch (_) {}

    if (deleteOnEnd) {
      try {
        await voiceChannel.delete(`Meeting ${meetingId} ended`).catch(() => {});
      } catch (e) {
        console.warn(`[voiceCapture] Failed to delete voice channel: ${e?.message || e}`);
      }
    }

    if (textChannelId) {
      try {
        const textChannel = guild.channels.cache.get(textChannelId);
        if (textChannel?.isTextBased?.()) {
          await textChannel.delete(`Meeting ${meetingId} ended`).catch(() => {});
        }
      } catch (e) {
        console.warn(`[voiceCapture] Failed to delete text channel: ${e?.message || e}`);
      }
    }
  };

  // Check if channel is empty (only bot remains)
  const checkChannelEmpty = () => {
    const voiceState = voiceChannel.members;
    const humanMembers = voiceState.filter(member => !member.user.bot);

    if (humanMembers.size === 0) {
      console.log(`[voiceCapture] Channel is empty, ending meeting: ${meetingId}`);
      endMeetingSession();
      return true;
    }
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
    console.log(`[voiceCapture] Max recording duration reached, ending meeting: ${meetingId}`);
    endMeetingSession();
  }, MAX_RECORDING_SECONDS * 1000);

  // Listen for disconnection/destruction
  connection.on(VoiceConnectionStatus.Disconnected, cleanup);
  connection.on(VoiceConnectionStatus.Destroyed, cleanup);
  connection.on(VoiceConnectionStatus.Error, (error) => {
    console.error(`[voiceCapture] Connection error for meeting ${meetingId}:`, error.message);
  });

  // Wait for connection to be ready, then start listening for speech
  try {
    await waitForConnectionReady(connection, 15000);
    console.log(`[voiceCapture] Voice connection ready, starting speech detection for meeting: ${meetingId}`);
  } catch (err) {
    console.error(`[voiceCapture] Failed to establish voice connection for meeting ${meetingId}:`, err.message);
    connection.destroy();
    cleanup();
    return null;
  }

  // Handle user speech and record
  receiver.speaking.on("start", (userId) => {
    console.log(`[voiceCapture] User started speaking: ${userId} in meeting: ${meetingId}`);

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

    // Handle stream errors
    opusStream.on("error", (err) => {
      console.error(`[voiceCapture] Opus stream error for user ${userId}:`, err.message);
      writeStream.destroy();
    });

    writeStream.on("error", (err) => {
      console.error(`[voiceCapture] Write stream error for user ${userId}:`, err.message);
    });

    // Create a promise that resolves once this recording has been saved to DB
    let resolveWrite;
    const writePromise = new Promise((resolve) => { resolveWrite = resolve; });
    pendingWrites.add(writePromise);

    opusStream.on("end", () => {
      console.log(`[voiceCapture] Opus stream ended for user ${userId}`);
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

    opusStream.pipe(writeStream);
  });

  receiver.speaking.on("error", (err) => {
    console.error(`[voiceCapture] Speaking event error:`, err.message);
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