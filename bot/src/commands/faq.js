import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('faq')
  .setDescription('Ask or search FAQs — pass question/query in command to skip form')
  .addSubcommand((s) =>
    s
      .setName('ask')
      .setDescription('Ask a new FAQ question')
      .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(false).setMaxLength(1000))
      .addStringOption((o) => o.setName('repo').setDescription('Repository name (optional)').setRequired(false))
  )
  .addSubcommand((s) =>
    s
      .setName('search')
      .setDescription('Search existing FAQs')
      .addStringOption((o) => o.setName('query').setDescription('Search term').setRequired(false))
      .addStringOption((o) => o.setName('repo').setDescription('Repository (optional)').setRequired(false))
  )

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  const sub = interaction.options.getSubcommand(false)

  if (sub === 'ask') {
    const questionOpt = interaction.options.getString('question')
    const repoOpt = interaction.options.getString('repo') || ''
    if (questionOpt) {
      try {
        let repositoryId = null
        if (repoOpt) {
          const repo = await db.repository.findFirst({
            where: { guildConfigId: cfg.id, name: repoOpt },
          })
          repositoryId = repo?.id
        }
        await db.faq.create({
          data: {
            guildConfigId: cfg.id,
            repositoryId,
            question: questionOpt,
            askedBy: interaction.user.id,
            status: 'open',
          },
        })
        const embed = new EmbedBuilder()
          .setTitle('FAQ recorded')
          .setDescription(`Your question has been recorded.${repoOpt ? ` (Repo: ${repoOpt})` : ''}`)
          .setColor(0x57f287)
        return interaction.editReply({ embeds: [embed] }).catch(() => {})
      } catch (e) {
        return interaction.editReply({ content: `Failed: ${e?.message ?? String(e)}` }).catch(() => {})
      }
    }
  }

  if (sub === 'search') {
    const queryOpt = interaction.options.getString('query')
    const repoOpt = interaction.options.getString('repo') || ''
    if (queryOpt) {
      try {
        const query = queryOpt.toLowerCase()
        const where = {
          guildConfigId: cfg.id,
          OR: [
            { question: { contains: query, mode: 'insensitive' } },
            { answer: { contains: query, mode: 'insensitive' } },
          ],
        }
        if (repoOpt) {
          const repo = await db.repository.findFirst({
            where: { guildConfigId: cfg.id, name: repoOpt },
          })
          if (repo) where.repositoryId = repo.id
        }
        const faqs = await db.faq.findMany({ where, take: 10, orderBy: { createdAt: 'desc' }, include: { repository: true } })
        const list = faqs.map((f) => `• **Q:** ${f.question.slice(0, 80)}${f.answer ? ` — A: ${f.answer.slice(0, 60)}...` : ' — *unanswered*'} (${f.repository?.name || 'general'})`)
        const embed = new EmbedBuilder()
          .setTitle('FAQ search results')
          .setDescription(list.length ? list.join('\n') : `No FAQs found for "${query}".`)
          .setColor(0x5865f2)
        return interaction.editReply({ embeds: [embed] }).catch(() => {})
      } catch (e) {
        return interaction.editReply({ content: `Search failed: ${e?.message ?? String(e)}` }).catch(() => {})
      }
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('FAQs')
    .setDescription('**Step 1:** Ask a new question or search existing FAQs. Or use **/faq ask question:...** or **/faq search query:...**.')
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 1 of 2' })

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('faq_ask').setLabel('Ask a question').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('faq_search').setLabel('Search FAQs').setStyle(ButtonStyle.Secondary)
  )

  await interaction.editReply({ embeds: [embed], components: [row] })
}

export async function handleFaqAsk(interaction) {
  const modal = new ModalBuilder().setCustomId('faq_ask_modal').setTitle('Ask FAQ')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('question').setLabel('Your question').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('repo').setLabel('Repository name (optional)').setStyle(TextInputStyle.Short).setRequired(false)
    )
  )
  await interaction.showModal(modal)
}

export async function handleFaqSearch(interaction) {
  const modal = new ModalBuilder().setCustomId('faq_search_modal').setTitle('Search FAQs')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('query').setLabel('Search term').setStyle(TextInputStyle.Short).setPlaceholder('e.g. deployment').setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('repo').setLabel('Repository (optional)').setStyle(TextInputStyle.Short).setRequired(false)
    )
  )
  await interaction.showModal(modal)
}

export async function handleFaqAskModal(interaction) {
  const guild = interaction.guild
  if (!guild) return

  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    const question = interaction.fields.getTextInputValue('question')
    const repoName = interaction.fields.getTextInputValue('repo') || ''
    let repositoryId = null
    if (repoName) {
      const repo = await db.repository.findFirst({
        where: { guildConfigId: cfg.id, name: repoName },
      })
      repositoryId = repo?.id
    }

    await db.faq.create({
      data: {
        guildConfigId: cfg.id,
        repositoryId,
        question,
        askedBy: interaction.user.id,
        status: 'open',
      },
    })

    const embed = new EmbedBuilder()
      .setTitle('FAQ recorded')
      .setDescription(`Your question has been recorded.${repoName ? ` (Repo: ${repoName})` : ''}`)
      .setColor(0x57f287)

    await interaction.editReply({ embeds: [embed] }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Failed: ${e?.message ?? String(e)}` }).catch(() => {})
  }
}

export async function handleFaqSearchModal(interaction) {
  const guild = interaction.guild
  if (!guild) return

  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    const query = interaction.fields.getTextInputValue('query').toLowerCase()
    const repoName = interaction.fields.getTextInputValue('repo') || ''
    const where = {
      guildConfigId: cfg.id,
      OR: [
        { question: { contains: query, mode: 'insensitive' } },
        { answer: { contains: query, mode: 'insensitive' } },
      ],
    }
    if (repoName) {
      const repo = await db.repository.findFirst({
        where: { guildConfigId: cfg.id, name: repoName },
      })
      if (repo) where.repositoryId = repo.id
    }
    const faqs = await db.faq.findMany({ where, take: 10, orderBy: { createdAt: 'desc' }, include: { repository: true } })
    const list = faqs.map((f) => `• **Q:** ${f.question.slice(0, 80)}${f.answer ? ` — A: ${f.answer.slice(0, 60)}...` : ' — *unanswered*'} (${f.repository?.name || 'general'})`)
    const embed = new EmbedBuilder()
      .setTitle('FAQ search results')
      .setDescription(list.length ? list.join('\n') : `No FAQs found for "${query}".`)
      .setColor(0x5865f2)

    await interaction.editReply({ embeds: [embed] }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Search failed: ${e?.message ?? String(e)}` }).catch(() => {})
  }
}
