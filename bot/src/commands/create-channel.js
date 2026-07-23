import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
} from "discord.js";
import db, { getOrCreateGuildConfig, ensureStringArray } from "../db/index.js";

export const data = new SlashCommandBuilder()
  .setName("create-channel")
  .setDescription("Create a private voice + text channel pair with designated access")
  .addStringOption((opt) =>
    opt
      .setName("name")
      .setDescription("Channel name")
      .setRequired(true),
  )
  .addUserOption((opt) =>
    opt.setName("member1").setDescription("Member who can access").setRequired(false),
  )
  .addUserOption((opt) =>
    opt.setName("member2").setDescription("Member who can access").setRequired(false),
  )
  .addUserOption((opt) =>
    opt.setName("member3").setDescription("Member who can access").setRequired(false),
  )
  .addUserOption((opt) =>
    opt.setName("member4").setDescription("Member who can access").setRequired(false),
  )
  .addUserOption((opt) =>
    opt.setName("member5").setDescription("Member who can access").setRequired(false),
  );

export async function execute(interaction) {
  const guild = interaction.guild;
  if (!guild)
    return interaction.editReply({ content: "Use this in a server." });

  const channelName = interaction.options
    .getString("name")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80);

  // Collect designated members
  const memberIds = new Set([interaction.user.id]);
  for (let i = 1; i <= 5; i++) {
    const user = interaction.options.getUser(`member${i}`);
    if (user) memberIds.add(user.id);
  }

  const cfg = await getOrCreateGuildConfig(guild.id);

  // Build permission overwrites — hidden from everyone, visible to designated members + bot
  const voiceOverwrites = [
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
  const textOverwrites = [
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

  for (const userId of memberIds) {
    voiceOverwrites.push({
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    });
    textOverwrites.push({
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  let voiceChannel, textChannel;
  try {
    voiceChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      permissionOverwrites: voiceOverwrites,
    });
    textChannel = await guild.channels.create({
      name: `${channelName}-chat`,
      type: ChannelType.GuildText,
      permissionOverwrites: textOverwrites,
    });
  } catch (e) {
    // Clean up if one was created
    if (voiceChannel) await voiceChannel.delete().catch(() => {});
    return interaction.editReply({
      content: `Failed to create channels: ${e.message}`,
    });
  }

  // Track in DB so /cleanup skips these
  try {
    await db.userChannel.create({
      data: {
        guildConfigId: cfg.id,
        voiceChannelId: voiceChannel.id,
        textChannelId: textChannel.id,
        name: channelName,
        createdBy: interaction.user.id,
        memberIds: Array.from(memberIds),
      },
    });
  } catch (e) {
    console.error("[create-channel] DB save failed:", e.message);
  }

  const memberList = Array.from(memberIds)
    .map((id) => `<@${id}>`)
    .join(", ");

  const embed = new EmbedBuilder()
    .setTitle("Channels Created")
    .setDescription(
      `**Voice:** <#${voiceChannel.id}>\n**Text:** <#${textChannel.id}>\n\n**Access:** ${memberList}`,
    )
    .setColor(0x57f287)
    .setFooter({ text: "These channels are protected from /cleanup" });

  await interaction.editReply({ embeds: [embed] });
}
