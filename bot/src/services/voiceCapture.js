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
  // Track pending file-write promises for this meeting recording session
  const pendingWrites = new Set();
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

/**
 * Stop meeting recording and update database status
 */
export async function stopMeetingRecording(meetingId) {
  const connection = activeConnections.get(meetingId);
  if (!connection) {
    console.warn(`[voiceCapture] no active connection for meeting: ${meetingId}`);
    return false;
  }

  try {
    // Update meeting status to completed
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
      // Wait for any in-flight file writes/DB saves to finish first.
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
    // cleanup timers/intervals and activeConnections
    try { cleanup(); } catch (_) {}
  };

  // Check if channel is empty (only bot remains)
  const checkChannelEmpty = () => {
    const voiceState = voiceChannel.members;
    const humanMembers = voiceState.filter(member => !member.user.bot);
    
    if (humanMembers.size === 0) {
      console.log(`[voiceCapture] channel is empty, ending meeting: ${meetingId}`);
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
    console.log(`[voiceCapture] max recording duration reached, ending meeting: ${meetingId}`);
    endMeetingSession();
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

  activeConnections.set(meetingId, connection);
  return connection;
}
