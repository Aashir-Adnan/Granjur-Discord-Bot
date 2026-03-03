import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import * as flowStore from '../flows/store.js'
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('faq-answer')
  .setDescription('View unanswered FAQs and answer them — select FAQ, then write or paste answer')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)

  const openFaqs = await db.faq.findMany({
    where: { guildConfigId: cfg.id, status: 'open' },
    include: { repository: true },
    orderBy: { createdAt: 'asc' },
    take: 25,
  })

  if (!openFaqs.length) {
    return interaction.editReply({ content: 'No unanswered FAQs.' })
  }

  const embed = new EmbedBuilder()
    .setTitle('Unanswered FAQs')
    .setDescription('**Step 1:** Select an FAQ to answer.')
    .setColor(0xfee75c)
    .setFooter({ text: 'Step 1 of 2' })

  const options = openFaqs.map((f) => ({
    label: f.question.slice(0, 100),
    value: f.id,
    description: `${f.repository?.name || 'general'} • ${f.createdAt.toISOString().slice(0, 10)}`,
  }))

  const select = new StringSelectMenuBuilder()
    .setCustomId('faq_answer_select')
    .setPlaceholder('Select FAQ')
    .addOptions(options)

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  })
}

export async function handleFaqSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const faqId = interaction.values?.[0]
  if (!faqId) return

  const cfg = await getOrCreateGuildConfig(guild.id)
  const faq = await db.faq.findFirst({
    where: { id: faqId, guildConfigId: cfg.id },
    include: { repository: true },
  })
  if (!faq) return interaction.editReply({ content: 'FAQ not found.', components: [], embeds: [] }).catch(() => {})

  flowStore.set(interaction.user.id, guild.id, 'faq_answer', { faqId, question: faq.question })

  const modal = new ModalBuilder().setCustomId('faq_answer_modal').setTitle('Answer FAQ')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('answer')
        .setLabel('Your answer (or paste from .md)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Write the answer...')
        .setRequired(true)
        .setMaxLength(4000)
    )
  )
  await interaction.showModal(modal)
}

export async function handleAnswerModal(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, 'faq_answer')
  if (!state?.faqId) return interaction.editReply({ content: 'Session expired. Run /faq-answer again.' }).catch(() => {})

  try {
    const answer = interaction.fields.getTextInputValue('answer').trim()
    await db.faq.update({
      where: { id: state.faqId },
      data: {
        answer,
        answeredBy: interaction.user.id,
        answeredAt: new Date(),
        status: 'answered',
      },
    })

    flowStore.clear(interaction.user.id, guild.id, 'faq_answer')

    const embed = new EmbedBuilder()
      .setTitle('FAQ answered')
      .setDescription(`**Q:** ${state.question.slice(0, 200)}...\n**A:** ${answer.slice(0, 300)}...`)
      .setColor(0x57f287)

    await interaction.editReply({ embeds: [embed] }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Failed: ${e?.message ?? String(e)}` }).catch(() => {})
  }
}
