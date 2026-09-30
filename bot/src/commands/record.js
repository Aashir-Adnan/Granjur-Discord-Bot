import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import {
  startMeetingRecording,
  stopMeetingRecording,
  isRecording,
} from "../services/voiceCapture.js";
import { ensureMeetingChannel } from "../services/meetingListener.js";
import { resolveMeetingChannel } from "../services/meetingPipelineStages.js";
import { ensureGuidelinesPinned } from "../config/meetingGuidelines.js";
import { downloadAttachment, extractDocText, DocTextError } from "../services/docText.js";
import db from "../db/index.js";

// What is sent to CSAAS as the brief, and how much of it Claude's analysis reads.
export const MAX_BRIEF_CHARS = 20000;
export const ANALYSIS_READS_CHARS = 3000;

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
  )
  .addAttachmentOption((o) =>
    o
      .setName("document")
      .setDescription("Optional background for start: a .txt, .md, .json, .pdf or .docx file")
      .setRequired(false),
  );

// The lines appended to the start reply for a document: what was used, or why not.
export function documentReplyLines({ fileName, chars, error }) {
  if (error) return [`The document was not used: ${error}`];
  const lines = [`Using **${fileName}** as background for this meeting.`];
  if (chars > ANALYSIS_READS_CHARS) {
    lines.push(`Claude reads the first ${ANALYSIS_READS_CHARS.toLocaleString("en-US")} characters of it.`);
  }
  return lines;
}

// The whole document read (download + extraction) gets this long before the
// recording starts without it.
export const READ_TIMEOUT_MS = 20_000;

// Reads the attached document. Nothing here may stop the recording, so every
// failure comes back as the sentence to show the user: a DocTextError keeps its
// own, anything else is logged and becomes a generic one.
export async function readBrief(
  attachment,
  { download = downloadAttachment, extract = extractDocText, timeoutMs = READ_TIMEOUT_MS } = {},
) {
  const fileName = attachment.name;
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ error: `**${fileName}** took too long to read.` }), timeoutMs);
  });
  const read = (async () => {
    try {
      const buffer = await download(attachment);
      const { text } = await extract({ buffer, fileName });
      return { fileName, text: text.slice(0, MAX_BRIEF_CHARS), chars: text.length };
    } catch (e) {
      if (e instanceof DocTextError) return { error: e.message };
      console.warn("[record] document read failed:", e?.message || e);
      return { error: `**${fileName}** could not be read.` };
    }
  })();
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export async function execute(
  interaction,
  {
    start = startMeetingRecording,
    stop = stopMeetingRecording,
    recording = isRecording,
    ensureChannel = ensureMeetingChannel,
    resolveChannel = resolveMeetingChannel,
    pinGuidelines = ensureGuidelinesPinned,
    download = downloadAttachment,
    extract = extractDocText,
    db: dbArg = db,
    readTimeoutMs = READ_TIMEOUT_MS,
  } = {},
) {
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
  const meetingChannel = await ensureChannel(guild, voiceChannel.id);

  if (action === "start") {
    if (recording(meetingChannel.meetingId)) {
      return interaction.editReply({
        content: "Already recording this meeting.",
      });
    }
    // The document is read before the recording starts so its text can go to CSAAS
    // with the meeting. It is not stored (meeting.notes is the channel chat log), so
    // a meeting CSAAS cannot create at the start goes without its brief.
    const attachment = interaction.options.getAttachment("document");
    const brief = attachment ? await readBrief(attachment, { download, extract, timeoutMs: readTimeoutMs }) : null;
    // The unified session: per-user capture, MeetingRecordingStatus row, empty-channel
    // grace timer, and the meeting-pipeline enqueue when the session ends.
    await start(
      voiceChannel, guild, meetingChannel.meetingId, voiceChannel.id,
      brief?.text ? { preMeetingNotes: brief.text } : {},
    );
    // The channel the transcript and the review will land in gets the guidelines.
    // Recording is already running by this point, so a database blip here must not
    // reach the command's error path: "Something went wrong, please try again" for
    // a live recording invites the user to start a second one.
    try {
      const target = await resolveChannel(interaction.client, dbArg, {
        meetingId: meetingChannel.meetingId,
        guildConfigId: meetingChannel.guildConfigId,
      });
      if (target) await pinGuidelines(target, guild.client.user.id);
    } catch (e) {
      console.warn(`[record] could not pin the guidelines: ${e?.message || e}`);
    }
    const lines = [
      `Recording individual voices in **${voiceChannel.name}**. Run \`/record action:stop\` when done.`,
    ];
    if (brief) lines.push(...documentReplyLines(brief));
    const embed = new EmbedBuilder()
      .setTitle("Recording started")
      .setDescription(lines.join("\n"))
      .setColor(0x57f287);
    return interaction.editReply({ embeds: [embed] });
  }

  const stopped = await stop(meetingChannel.meetingId);
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
