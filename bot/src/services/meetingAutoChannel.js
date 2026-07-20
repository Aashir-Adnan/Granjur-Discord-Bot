import db, { ensureStringArray, getGuildConfig } from "../db/index.js";
import { PermissionFlagsBits, ChannelType, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } from "discord.js";
import { startMeetingRecording } from "./voiceCapture.js";
import { ensureMeetingChannel } from "./meetingListener.js";

const INTERVAL_MS = 60 * 1000; // check every minute, same as meetingReminder.js
const GRACE_PERIOD_MS = 20000; // 20 seconds for members to join before empty check could end meeting

/**
 * Send meeting start notifications to invited members with a link to join the voice channel
 */
async function notifyMeetingStart(guild, voiceChannel, meeting, memberIds) {
  if (!memberIds?.length) return;

  const shortId = meeting.id.slice(0, 8);
  const joinUrl = `https://discord.com/channels/${guild.id}/${voiceChannel.id}`;
  const topic = meeting.topic || "Meeting";

  // Try to find a text channel to post the notification (prefer admin channel or meeting text channel)
  let textChannel = null;
  const cfg = await getGuildConfig(guild.id);
  if (cfg?.adminChannelId) {
    textChannel = guild.channels.cache.get(cfg.adminChannelId);
  }

  // If no admin channel, try to find the meeting text channel
  if (!textChannel && voiceChannel.guild.channels.cache) {
    // Look for a text channel with similar name
    textChannel = guild.channels.cache.find(c =>
      c.isTextBased() && c.name.includes(shortId)
    );
  }

  // If still no text channel, we'll DM the members
  const mentionList = memberIds.map(id => `<@${id}>`).join(' ');
  const embed = new EmbedBuilder()
    .setTitle(`🎙️ Meeting Starting: ${topic}`)
    .setDescription(`Your meeting is starting now. Click the button below to join the voice channel.`)
    .addFields(
      { name: 'Voice Channel', value: `<#${voiceChannel.id}>`, inline: true },
      { name: 'Started', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
    )
    .setColor(0x5865f2)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Join Voice Channel')
      .setStyle(ButtonStyle.Link)
      .setURL(joinUrl)
  );

  // Try to send to text channel first
  if (textChannel) {
    try {
      await textChannel.send({ content: mentionList, embeds: [embed], components: [row] });
      console.log(`[meetingAutoChannel] Posted meeting start notification to #${textChannel.name}`);
      return;
    } catch (e) {
      console.warn(`[meetingAutoChannel] Failed to post to text channel: ${e.message}`);
    }
  }

  // Fallback: DM each member
  for (const userId of memberIds) {
    try {
      const user = await guild.client.users.fetch(userId);
      await user.send({ embeds: [embed], components: [row] });
      console.log(`[meetingAutoChannel] Sent meeting start DM to ${user.tag}`);
    } catch (e) {
      console.warn(`[meetingAutoChannel] Failed to DM ${userId}: ${e.message}`);
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
  // Use member objects to avoid "Supplied parameter is not a cached User or Role" error
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
  ];

  // Add permissions for each allowed user (fetch to ensure they're cached)
  for (const userId of allowedIds) {
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        permissionOverwrites.push({
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
          ],
        });
      }
    } catch (e) {
      console.warn(`[meetingAutoChannel] Failed to fetch member ${userId}: ${e.message}`);
    }
  }

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
  // forceNewMeeting: true ensures a NEW meeting record is created each time (not reusing old one)
  const meetingChannel = await ensureMeetingChannel(guild, voiceChannel.id, { forceNewMeeting: true });

  // Notify invited members to join the voice channel
  await notifyMeetingStart(guild, voiceChannel, meeting, memberIds);

  // Give members a grace period to join before starting recording
  // This prevents the empty-channel check from ending the meeting immediately
  console.log(`[meetingAutoChannel] Waiting ${GRACE_PERIOD_MS/1000}s for members to join...`);
  await new Promise(resolve => setTimeout(resolve, GRACE_PERIOD_MS));

  // Check if anyone joined; if not, log warning but continue
  const humanCount = voiceChannel.members.filter(m => !m.user.bot).size;
  if (humanCount === 0) {
    console.warn(`[meetingAutoChannel] No human members joined voice channel ${voiceChannel.id} after grace period`);
  } else {
    console.log(`[meetingAutoChannel] ${humanCount} human member(s) in voice channel`);
  }

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
