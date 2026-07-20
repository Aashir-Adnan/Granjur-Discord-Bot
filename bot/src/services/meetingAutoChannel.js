import db, { ensureStringArray, getGuildConfig } from "../db/index.js";
import { PermissionFlagsBits, ChannelType } from "discord.js";
import { startMeetingRecording } from "./voiceCapture.js";
import { ensureMeetingChannel } from "./meetingListener.js";

const INTERVAL_MS = 60 * 1000; // check every minute, same as meetingReminder.js

/**
 * Move invited members to the voice channel
 */
async function moveMembersToVoiceChannel(guild, voiceChannel, memberIds) {
  if (!memberIds?.length) return;

  const members = await guild.members.fetch({ user: memberIds, cache: true }).catch(() => new Map());

  for (const [userId, member] of members) {
    if (member.voice.channelId !== voiceChannel.id) {
      try {
        await member.voice.setChannel(voiceChannel);
        console.log(`[meetingAutoChannel] Moved member ${userId} to voice channel ${voiceChannel.id}`);
      } catch (e) {
        console.warn(`[meetingAutoChannel] Failed to move member ${userId} to voice channel: ${e.message}`);
      }
    }
  }
}

/**
 * Every minute: find scheduled meetings whose start time has arrived and that
 * don't have a channel yet, create a PRIVATE voice channel visible only to
 * the invited members (+ the meeting creator), move the bot in, and start
 * recording. Each meeting gets its own unique channel (named with the
 * meeting's own DB id, so no collisions).
 */
export function startMeetingAutoChannels(client) {
  if (!client?.guilds) return;
  setInterval(async () => {
    try {
      const now = new Date();
      for (const [guildId, guild] of client.guilds.cache) {
        try {
          const meetings = await db.scheduledMeeting.findDueToStart(
            guildId,
            now,
          );
          if (!meetings?.length) continue;

          for (const meeting of meetings) {
            await createMeetingChannelAndJoin(guild, meeting);
          }
        } catch (e) {
          console.error("[meetingAutoChannel] guild loop error:", e.message);
        }
      }
    } catch (e) {
      console.error("[meetingAutoChannel] interval error:", e.message);
    }
  }, INTERVAL_MS);
}

async function createMeetingChannelAndJoin(guild, meeting) {
  const cfg = await getGuildConfig(guild.id);
  const memberIds = ensureStringArray(meeting.memberIds);
  // Everyone who should see this private channel: invitees + whoever scheduled it
  const allowedIds = Array.from(
    new Set([...memberIds, meeting.createdBy].filter(Boolean)),
  );

  // Unique, readable channel name using the meeting's own id (short suffix)
  const shortId = meeting.id.slice(0, 8);
  const safeTopic = (meeting.topic || "meeting")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
  const channelName = `meet-${safeTopic}-${shortId}`;

  // Deny @everyone, allow only invited members + the bot itself
  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: guild.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    },
    ...allowedIds.map((userId) => ({
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    })),
  ];

  let voiceChannel = null;

  if (meeting.voiceChannelId) {
    const existingChannel = guild.channels.cache.get(meeting.voiceChannelId);
    if (existingChannel?.isVoiceBased?.()) {
      voiceChannel = existingChannel;
    }
  }

  if (!voiceChannel) {
    try {
      voiceChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        permissionOverwrites,
      });
    } catch (e) {
      console.error("[meetingAutoChannel] failed to create channel:", e.message);
      return;
    }
  }

  // Mark this meeting as started/assigned to a voice channel so we don't process it again.
  await db.scheduledMeeting.setChannel(meeting.id, voiceChannel.id);

  // Link this channel into the existing Meeting/MeetingChannel DB tables
  const meetingChannel = await ensureMeetingChannel(guild, voiceChannel.id);

  // Move invited members to the voice channel BEFORE starting recording
  // This ensures they're present when the empty-channel check runs (every 5s in voiceCapture.js)
  await moveMembersToVoiceChannel(guild, voiceChannel, memberIds);

  // Bot joins and starts recording each person's voice individually
  await startMeetingRecording(
    voiceChannel,
    guild,
    meetingChannel.meetingId,
    voiceChannel.id,
  );

  console.log(
    `[meetingAutoChannel] created ${channelName} for meeting ${meeting.id}, recording started`,
  );
}
