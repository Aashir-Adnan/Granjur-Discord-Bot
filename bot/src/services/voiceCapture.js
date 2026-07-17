import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import prism from "prism-media";
import fs from "fs";
import path from "path";

const activeConnections = new Map(); // meetingId -> connection

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
