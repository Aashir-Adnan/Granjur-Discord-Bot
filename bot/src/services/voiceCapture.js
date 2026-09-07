import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  getVoiceConnection,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
} from "@discordjs/voice";
import prism from "prism-media";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db, { getOrCreateGuildConfig } from "../db/index.js";
import { meetingPipelineEnabled } from "../Database/meetingPipelineJob.helpers.js";
import { OggOpusEncoder } from "../utils/oggOpusStream.js";
import * as csaasClient from "./csaasClient.js";
import { createTranscriptFeed } from "./transcriptFeed.js";
import { resolveMeetingChannel } from "./meetingPipelineStages.js";
import { deriveMeetingName, formatMeetingDate } from "../commands/playback.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const activeConnections = new Map(); // meetingId -> connection
// meetingId -> the session's endMeetingSession closure, so /record stop can end the
// session properly (status row + pipeline enqueue) instead of only dropping the socket.
const sessionEnders = new Map();
const MAX_RECORDING_SECONDS = 60 * 60 * 2; // 2 hours
const CONNECTION_TIMEOUT_MS = 120000; // 120 seconds for voice connection to become ready (Discord can be slow on cloud hosts)
const MAX_CONNECTION_RETRIES = 2; // Number of connection retry attempts

/**
 * Wait for voice connection to reach Ready state with retry logic
 */
async function waitForConnectionReadyWithRetry(connection, timeoutMs = CONNECTION_TIMEOUT_MS, maxRetries = MAX_CONNECTION_RETRIES) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await waitForConnectionReady(connection, timeoutMs);
      return connection;
    } catch (err) {
      const isLastAttempt = attempt === maxRetries;
      console.error(`[voiceCapture] Voice connection attempt ${attempt + 1}/${maxRetries + 1} failed: ${err.message}`);

      if (isLastAttempt) {
        throw err;
      }

      // Wait before retry with exponential backoff
      const retryDelay = Math.min(1000 * Math.pow(2, attempt), 10000); // Max 10 seconds
      console.log(`[voiceCapture] Retrying voice connection in ${retryDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));

      // Check if connection is still valid before retrying
      if (connection.state.status === VoiceConnectionStatus.Destroyed ||
          connection.state.status === VoiceConnectionStatus.Disconnected) {
        console.error(`[voiceCapture] Connection is destroyed/disconnected, cannot retry`);
        throw new Error("Voice connection destroyed, cannot retry");
      }
    }
  }
}

/**
 * Wait for voice connection to reach Ready state
 */
function waitForConnectionReady(connection, timeoutMs = CONNECTION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    console.log(`[voiceCapture] Waiting for voice connection... current status: ${connection.state.status}`);

    if (connection.state.status === VoiceConnectionStatus.Ready) {
      console.log(`[voiceCapture] Voice connection already ready`);
      return resolve(connection);
    }

    const timeout = setTimeout(() => {
      console.error(`[voiceCapture] Voice connection timed out after ${timeoutMs}ms. Final status: ${connection.state.status}`);
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
      console.log(`[voiceCapture] Voice connection ready!`);
      cleanup();
      resolve(connection);
    };

    const onDisconnected = () => {
      console.error(`[voiceCapture] Voice connection disconnected before ready`);
      cleanup();
      reject(new Error("Voice connection disconnected before ready"));
    };

    const onDestroyed = () => {
      console.error(`[voiceCapture] Voice connection destroyed before ready`);
      cleanup();
      reject(new Error("Voice connection destroyed before ready"));
    };

    const onError = (error) => {
      console.error(`[voiceCapture] Voice connection error:`, error.message);
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

  // A session started by startMeetingRecording owns a full end path (finish streams,
  // mark completed, enqueue the pipeline job, tidy channels). Prefer it; the fallback
  // below only covers a legacy startRecording() connection.
  const endSession = sessionEnders.get(meetingId);
  if (endSession) {
    sessionEnders.delete(meetingId);
    await endSession();
    return true;
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
  const { deleteOnEnd = false, textChannelId = null, meetingTopic = null } = options;

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
  console.log(`[voiceCapture] Joining voice channel: ${voiceChannel.id} (${voiceChannel.name}) in guild: ${guild.id}`);
  console.log(`[voiceCapture] Bot user ID: ${guild.client.user.id}`);
  console.log(`[voiceCapture] Voice channel type: ${voiceChannel.type}, members: ${voiceChannel.members.size}`);

  // Check bot permissions in voice channel
  const botMember = voiceChannel.guild.members.cache.get(guild.client.user.id);
  if (botMember) {
    const perms = voiceChannel.permissionsFor(botMember);
    console.log(`[voiceCapture] Bot permissions in voice channel:`, {
      ViewChannel: perms?.has('ViewChannel'),
      Connect: perms?.has('Connect'),
      Speak: perms?.has('Speak'),
      UseVAD: perms?.has('UseVAD'),
    });
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  // Setup recording directory — named as meetingId-topic
  const safeTopic = (meetingTopic || "meeting")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
  const dirName = `${meetingId.slice(0, 8)}-${safeTopic}`;
  const recordingsDir = path.join(process.cwd(), "recordings", dirName);
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
          audioFormat: "ogg",
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

  // Track one continuous encoder/file per user
  const activeUserStreams = new Map();

  // The live transcript feed, set up once the connection is ready. Declared here
  // because endMeetingSession closes over it.
  let feed = null;

  // End meeting session
  const endMeetingSession = async () => {
    console.log(`[voiceCapture] Ending meeting session: ${meetingId}`);
    try {
      // Stop the live feed before tearing the streams down, so its final flush
      // still has a channel to post to.
      if (feed) {
        try { await feed.stop(); } catch (e) { console.warn(`[voiceCapture] feed stop failed: ${e?.message || e}`); }
      }

      // End all active user streams gracefully. opusStream is now per-utterance
      // and is absent whenever the speaker is between turns.
      for (const [userId, speaker] of activeUserStreams) {
        console.log(`[voiceCapture] Ending stream for user ${userId}`);
        try { speaker.opusStream?.destroy(); } catch (_) {}
        try { speaker.oggEncoder.end(); } catch (_) {}
      }

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

      try {
        const recs = await db.meetingRecording.findMany({ where: { meetingId } });
        if (recs.length && meetingPipelineEnabled()) {
          await db.meetingPipelineJob.create({ data: { guildConfigId: cfg.id, meetingId } });
          console.log(`[meetingPipeline] enqueued job for meeting ${meetingId}`);
        }
      } catch (e) {
        console.error('[meetingPipeline] enqueue failed:', e?.message || e);
      }
    } catch (err) {
      console.error(`[voiceCapture] Failed to update meeting status: ${err.message}`);
    }

    connection.destroy();
    try { cleanup(); } catch (_) {}

    if (deleteOnEnd) {
      try {
        console.log(`[voiceCapture] Deleting voice channel: ${voiceChannel.id}`);
        // Fetch fresh channel reference in case cache is stale
        const freshVoiceChannel = await guild.channels.fetch(voiceChannel.id).catch(() => voiceChannel);
        await freshVoiceChannel.delete(`Meeting ${meetingId} ended`).catch(() => {});
        console.log(`[voiceCapture] Voice channel deleted successfully`);
      } catch (e) {
        console.warn(`[voiceCapture] Failed to delete voice channel: ${e?.message || e}`);
      }
    }

    if (textChannelId) {
      try {
        console.log(`[voiceCapture] Deleting text channel: ${textChannelId}`);
        const textChannel = await guild.channels.fetch(textChannelId).catch(() => guild.channels.cache.get(textChannelId));
        if (textChannel?.isTextBased?.()) {
          await textChannel.delete(`Meeting ${meetingId} ended`).catch(() => {});
          console.log(`[voiceCapture] Text channel deleted successfully`);
        } else {
          console.warn(`[voiceCapture] Text channel not found or not text-based: ${textChannelId}`);
        }
      } catch (e) {
        console.warn(`[voiceCapture] Failed to delete text channel: ${e?.message || e}`);
      }
    }
  };

  sessionEnders.set(meetingId, endMeetingSession);

  // Check if channel is empty (only bot remains) with 2-minute grace period
  let emptyGraceTimeout = null;
  const EMPTY_GRACE_MS = 2 * 60 * 1000; // 2 minutes

  const checkChannelEmpty = () => {
    const voiceState = voiceChannel.members;
    const humanMembers = voiceState.filter(member => !member.user.bot);

    if (humanMembers.size === 0) {
      if (!emptyGraceTimeout) {
        console.log(`[voiceCapture] Channel empty, starting 5-minute grace period for meeting: ${meetingId}`);
        emptyGraceTimeout = setTimeout(() => {
          // Re-check after grace period
          const currentHumans = voiceChannel.members.filter(m => !m.user.bot);
          if (currentHumans.size === 0) {
            console.log(`[voiceCapture] Grace period expired, ending meeting: ${meetingId}`);
            endMeetingSession();
          } else {
            console.log(`[voiceCapture] Members rejoined during grace period, continuing meeting: ${meetingId}`);
            emptyGraceTimeout = null;
          }
        }, EMPTY_GRACE_MS);
      }
    } else if (emptyGraceTimeout) {
      // Members rejoined, cancel grace period
      console.log(`[voiceCapture] Members rejoined, cancelling grace period for meeting: ${meetingId}`);
      clearTimeout(emptyGraceTimeout);
      emptyGraceTimeout = null;
    }
  };

  // Handle cleanup
  const cleanup = () => {
    activeConnections.delete(meetingId);
    sessionEnders.delete(meetingId);
    clearTimeout(timeoutHandle);
    clearInterval(channelCheckInterval);
    if (emptyGraceTimeout) clearTimeout(emptyGraceTimeout);
  };

  // Monitor channel for empty state (check every 10 seconds)
  const channelCheckInterval = setInterval(() => {
    checkChannelEmpty();
  }, 10000);

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
    await waitForConnectionReady(connection, CONNECTION_TIMEOUT_MS);
    console.log(`[voiceCapture] Voice connection ready, starting speech detection for meeting: ${meetingId}`);
  } catch (err) {
    console.error(`[voiceCapture] Failed to establish voice connection for meeting ${meetingId}:`, err.message);
    connection.destroy();
    cleanup();
    return null;
  }

  // Play "Ready to Record" audio cue
  const readyAudioPath = path.join(__dirname, "../../assets/ready-to-record.ogg");
  if (fs.existsSync(readyAudioPath)) {
    try {
      const player = createAudioPlayer();
      const resource = createAudioResource(readyAudioPath);
      connection.subscribe(player);
      player.play(resource);
      await new Promise((resolve) => {
        player.on(AudioPlayerStatus.Idle, resolve);
        player.on("error", (err) => {
          console.error(`[voiceCapture] Ready audio error:`, err.message);
          resolve();
        });
        setTimeout(resolve, 5000); // safety timeout
      });
      console.log(`[voiceCapture] Played ready-to-record audio cue`);
    } catch (e) {
      console.warn(`[voiceCapture] Failed to play ready audio: ${e.message}`);
    }
  } else {
    console.warn(`[voiceCapture] Ready audio file not found at ${readyAudioPath}`);
  }


  // One long-lived encoder per speaker (the /playback artifact, unchanged), fed
  // by one short-lived subscription per utterance. Discord ends an AfterSilence
  // stream at the end of a turn and releases the user, so re-subscribing on the
  // next speaking.start is safe and gives us natural turn boundaries.
  const UTTERANCE_SILENCE_MS = 900;
  const MIN_UTTERANCE_MS = 500;
  const MAX_UTTERANCE_MS = 30000;
  const FRAME_MS = 20; // Opus frames from Discord are always 20 ms

  // A packet that arrives after the encoder was ended — a turn starting as the
  // meeting is torn down — would raise "write after end", and that error destroys
  // the write stream mid-flush and truncates the speaker's file.
  const writeToFile = (speaker, packet) => {
    if (speaker.oggEncoder.writableEnded || speaker.oggEncoder.destroyed) return;
    speaker.oggEncoder.write(packet);
  };

  const createSpeaker = async (userId) => {
    // Look up user email for file naming
    let userLabel = userId;
    try {
      const member = await db.guildMember.findUnique({
        where: { guildId_discordId: { guildId: guild.id, discordId: userId } },
      });
      if (member?.email) {
        userLabel = member.email.split("@")[0].replace(/[^a-z0-9._-]/gi, "_");
      }
    } catch (_) {}

    const fileName = `${userLabel}.ogg`;
    const filePath = path.join(recordingsDir, fileName);
    const startedAt = new Date();

    const oggEncoder = new OggOpusEncoder({ sampleRate: 48000, channels: 2 });
    const writeStream = fs.createWriteStream(filePath);

    oggEncoder.on("error", (err) => {
      console.error(`[voiceCapture] OGG encoder error for user ${userId}:`, err.message);
      writeStream.destroy();
    });

    writeStream.on("error", (err) => {
      console.error(`[voiceCapture] Write stream error for user ${userId}:`, err.message);
    });

    let resolveWrite;
    const writePromise = new Promise((resolve) => { resolveWrite = resolve; });
    pendingWrites.add(writePromise);

    // Exactly one MeetingRecording row per speaker: "finish", "error" and "close"
    // can each arrive, and pendingWrites has to resolve on every one of those
    // paths or endMeetingSession waits forever.
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      finishRecording(userId, filePath, startedAt, new Date(), fileName)
        .catch(() => {})
        .finally(() => {
          pendingWrites.delete(writePromise);
          resolveWrite();
          activeUserStreams.delete(userId);
        });
    };

    writeStream.on("finish", finalize);
    writeStream.on("error", finalize);
    writeStream.on("close", finalize);

    oggEncoder.pipe(writeStream);

    const speaker = {
      oggEncoder, writeStream, filePath, fileName, startedAt, writePromise, resolveWrite,
      opusStream: null, displayName: userId,
    };
    activeUserStreams.set(userId, speaker);

    // Deliberately not awaited: this is an HTTP round trip and the packets of the
    // turn that is starting right now must not wait behind it. The name is only
    // read when an utterance is handed to the feed, at least MIN_UTTERANCE_MS +
    // UTTERANCE_SILENCE_MS later.
    guild.members
      .fetch(userId)
      .then((m) => { speaker.displayName = m.displayName; })
      .catch(() => {});

    console.log(`[voiceCapture] Started recording user: ${userLabel} (${userId}) in meeting: ${meetingId}`);
    return speaker;
  };

  // speaking.start can fire again while the first setup is still awaiting the
  // database, so the in-flight setup is registered synchronously. Two speaker
  // objects for one user would mean two writers on one file and two rows.
  const speakerSetups = new Map();
  const speakerFor = (userId) => {
    const existing = activeUserStreams.get(userId);
    if (existing) return existing;
    let setup = speakerSetups.get(userId);
    if (!setup) {
      setup = createSpeaker(userId);
      speakerSetups.set(userId, setup);
      const forget = () => speakerSetups.delete(userId);
      setup.then(forget, forget);
    }
    return setup;
  };

  // userIds with a live per-utterance subscription. Kept outside the speaker so the
  // guard can be set before anything is awaited.
  const activeUtterances = new Set();

  receiver.speaking.on("start", (userId) => {
    if (activeUtterances.has(userId)) return; // already capturing this turn
    activeUtterances.add(userId);

    // Subscribed synchronously, inside the speaking event. VoiceReceiver raises
    // "start" and then delivers the packet that raised it only to a subscription
    // that already exists, so awaiting anything first would cost the leading 20 ms
    // of every turn — audio the old Manual subscription kept.
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: UTTERANCE_SILENCE_MS },
    });

    let speaker = null;
    const buffered = []; // packets captured before this speaker's encoder exists
    let packets = [];
    let frames = 0;
    let segmentStartedAt = new Date();
    let ended = false;

    // Resolves once, on the first turn only; every later turn hits the cache and
    // this settles on the next microtask, before any further packet can arrive.
    const setup = Promise.resolve(speakerFor(userId))
      .then((s) => {
        speaker = s;
        s.opusStream = opusStream;
        for (const p of buffered) writeToFile(s, p);
        buffered.length = 0;
      })
      .catch((err) => {
        console.error(`[voiceCapture] Failed to start recording user ${userId}:`, err?.message || err);
      });

    opusStream.on("error", (err) => {
      console.error(`[voiceCapture] Opus stream error for user ${userId}:`, err.message);
      try { opusStream.destroy(); } catch (_) {}
    });

    // Hand what has been captured so far to the feed as a small standalone OGG,
    // built by a throwaway encoder so the speaker's own file is never touched.
    const emitSegment = () => {
      const segment = packets;
      const durationMs = frames * FRAME_MS;
      const startedAt = segmentStartedAt;
      packets = [];
      frames = 0;
      segmentStartedAt = new Date();
      if (!feed || segment.length === 0 || durationMs < MIN_UTTERANCE_MS) return;

      const chunks = [];
      const enc = new OggOpusEncoder({ sampleRate: 48000, channels: 2 });
      enc.on("data", (c) => chunks.push(c));
      enc.on("end", () => {
        feed.push({
          speakerRef: userId,
          speakerName: speaker.displayName,
          startedAt,
          durationMs,
          buffer: Buffer.concat(chunks),
        });
      });
      enc.on("error", (err) => console.warn(`[voiceCapture] utterance encode failed: ${err.message}`));
      for (const p of segment) enc.write(p);
      enc.end();
    };

    opusStream.on("data", (packet) => {
      frames += 1;
      // Keep the meeting file complete regardless of what happens to the feed.
      if (speaker) writeToFile(speaker, packet);
      else buffered.push(packet);
      if (feed) packets.push(packet);
      // A monologue with no pause would otherwise never reach the feed. Only the
      // feed's segment is cut here: destroying the subscription would drop audio
      // from the .ogg until the speaker next paused, because speaking.start does
      // not fire again while packets keep arriving.
      if (speaker && frames * FRAME_MS >= MAX_UTTERANCE_MS) emitSegment();
    });

    const finishUtterance = () => {
      if (ended) return;
      ended = true;
      activeUtterances.delete(userId);
      // The turn can end before the speaker's encoder exists (a very short first
      // turn), so the flush waits for the setup it may have raced.
      setup.then(() => {
        if (!speaker) return;
        if (speaker.opusStream === opusStream) speaker.opusStream = null;
        emitSegment();
      });
    };

    opusStream.on("end", finishUtterance);
    opusStream.on("close", finishUtterance);
  });

  receiver.speaking.on("error", (err) => {
    console.error(`[voiceCapture] Speaking event error:`, err.message);
  });

  // The live transcript needs a CSAAS meeting_id while the meeting is still
  // running. createdStage would only make one after the recording ends, so the
  // meeting is created here and createdStage reuses the id. This runs after the
  // speaking handler is attached so that no audio is lost while CSAAS is called.
  if (csaasClient.isConfigured()) {
    try {
      const humans = voiceChannel.members.filter((m) => !m.user.bot).map((m) => m.displayName);
      // deriveMeetingName reads the *directory of* the path it is given, so it
      // gets a path inside recordingsDir rather than recordingsDir itself.
      const name = deriveMeetingName(path.join(recordingsDir, "meeting.ogg"), meetingId);
      const title = `${name} — ${formatMeetingDate(new Date())}`;
      const { meeting_id } = await csaasClient.createMeeting({ title, participants: humans });
      if (meeting_id) {
        await db.meeting.update({ where: { id: meetingId }, data: { csaasMeetingId: meeting_id } });
        const channel = await resolveMeetingChannel(guild.client, db, {
          meetingId, guildConfigId: cfg.id,
        });
        if (channel) {
          feed = createTranscriptFeed({
            db, csaasClient, channel,
            guildConfigId: cfg.id, meetingId, csaasMeetingId: meeting_id,
          });
          await feed.start();
          console.log(`[voiceCapture] Live transcript feed started for meeting ${meetingId}`);
        }
      }
    } catch (e) {
      // No live feed this meeting; recording and the existing pipeline are unaffected.
      feed = null;
      console.warn(`[voiceCapture] Live transcript unavailable: ${e?.message || e}`);
    }
  }

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