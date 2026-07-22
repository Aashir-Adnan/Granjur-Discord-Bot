import db, { ensureStringArray, getGuildConfig } from "../db/index.js";
import { PermissionFlagsBits, ChannelType, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } from "discord.js";
import { startMeetingRecording } from "./voiceCapture.js";
import { ensureMeetingChannel } from "./meetingListener.js";

const INTERVAL_MS = 60 * 1000; // check every minute, same as meetingReminder.js
const GRACE_PERIOD_MS = 20000; // 20 seconds for members to join before empty check could end meeting

/**
 * Send meeting start notifications to invited members with a link to join the voice channel
 */
async function notifyMeetingStart(guild, voiceChannel, textChannel, meeting, memberIds) {
  if (!memberIds?.length) return;

  const joinUrl = `https://discord.com/channels/${guild.id}/${voiceChannel.id}`;
  const topic = meeting.topic || "Meeting";
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

  // Prefer the dedicated meeting text channel created for this room.
  if (textChannel) {
    try {
      await textChannel.send({ content: mentionList, embeds: [embed], components: [row] });
      console.log(`[meetingAutoChannel] Posted meeting start notification to #${textChannel.name}`);
      return;
    } catch (e) {
      console.warn(`[meetingAutoChannel] Failed to post to text channel: ${e.message}`);
    }
  }

  // Fallback: admin channel or DM
  const cfg = await getGuildConfig(guild.id);
  let fallbackChannel = null;
  if (cfg?.adminChannelId) {
    fallbackChannel = guild.channels.cache.get(cfg.adminChannelId);
  }

  if (fallbackChannel) {
    try {
      await fallbackChannel.send({ content: mentionList, embeds: [embed], components: [row] });
      console.log(`[meetingAutoChannel] Posted meeting start notification to #${fallbackChannel.name}`);
      return;
    } catch (e) {
      console.warn(`[meetingAutoChannel] Failed to post to admin channel: ${e.message}`);
    }
  }

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
  const memberIds = ensureStringArray(meeting.memberIds);
  const allowedIds = Array.from(
    new Set([...memberIds, meeting.createdBy].filter(Boolean)),
  );

  const shortId = meeting.id.slice(0, 8);
  const safeTopic = (meeting.topic || "meeting")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
  const channelName = `meet-${safeTopic}-${shortId}`;
  const meetingsCategory = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name === '📋 Meetings',
  );

  const voicePermissionOverwrites = [
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
  const textPermissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: guild.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  for (const userId of allowedIds) {
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        voicePermissionOverwrites.push({
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
          ],
        });
        textPermissionOverwrites.push({
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        });
      }
    } catch (e) {
      console.warn(`[meetingAutoChannel] Failed to fetch member ${userId}: ${e.message}`);
    }
  }

  let voiceChannel = null;
  let createdNewVoiceChannel = false;

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
        parent: meetingsCategory?.id,
        permissionOverwrites: voicePermissionOverwrites,
      });
      createdNewVoiceChannel = true;
    } catch (e) {
      console.error("[meetingAutoChannel] failed to create voice channel:", e.message);
      return;
    }
  }

  let textChannel = null;
  try {
    textChannel = await guild.channels.create({
      name: `${channelName}-chat`,
      type: ChannelType.GuildText,
      parent: meetingsCategory?.id,
      topic: 'Meeting chat is stored in the database with the sender and timestamp.',
      permissionOverwrites: textPermissionOverwrites,
    });
  } catch (e) {
    console.error("[meetingAutoChannel] failed to create text channel:", e.message);
    return;
  }

  await db.scheduledMeeting.setChannel(meeting.id, voiceChannel.id);

  const meetingChannel = await ensureMeetingChannel(guild, voiceChannel.id, {
    forceNewMeeting: true,
    textChannelId: textChannel.id,
  });

  await notifyMeetingStart(guild, voiceChannel, textChannel, meeting, memberIds);

  // Small delay to allow Discord to propagate channel creation before joining
  console.log(`[meetingAutoChannel] Waiting 3s for channel propagation...`);
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log(`[meetingAutoChannel] Waiting ${GRACE_PERIOD_MS/1000}s for members to join...`);
  await new Promise(resolve => setTimeout(resolve, GRACE_PERIOD_MS));

  const humanCount = voiceChannel.members.filter(m => !m.user.bot).size;
  if (humanCount === 0) {
    console.warn(`[meetingAutoChannel] No human members joined voice channel ${voiceChannel.id} after grace period`);
  } else {
    console.log(`[meetingAutoChannel] ${humanCount} human member(s) in voice channel`);
  }

  await startMeetingRecording(
    voiceChannel,
    guild,
    meetingChannel.meetingId,
    voiceChannel.id,
    {
      deleteOnEnd: createdNewVoiceChannel,
      textChannelId: textChannel.id,
    },
  );

  console.log(
    `[meetingAutoChannel] created ${channelName} for meeting ${meeting.id}, recording started`,
  );
}
