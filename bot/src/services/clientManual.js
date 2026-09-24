// The pinned manual in #support: the only place a client is ever told how the
// bot works, because they see no other channel. A leaf module on purpose — no
// db import — so the commands and the sign-in path can both use it.
import { EmbedBuilder } from 'discord.js'

export const MANUAL_TITLE = 'How to work with us here'

/**
 * One entry per client command. The manual is built from this list, and a test
 * checks it against `clientCommands` in command-config.json, so a command added
 * to one and not the other fails the suite.
 */
export const CLIENT_COMMANDS = [
  {
    name: 'report-issue',
    syntax: '/report-issue title:<short title> details:<what happens>',
    summary: 'Report something that is broken.',
    example: '/report-issue title:Login fails on mobile details:After entering the code the page reloads and I am signed out.',
  },
  {
    name: 'request-feature',
    syntax: '/request-feature title:<short title> details:<what you need>',
    summary: 'Ask for something new.',
    example: '/request-feature title:Export bookings to CSV details:We need a monthly export for accounts.',
  },
  {
    name: 'my-requests',
    syntax: '/my-requests',
    summary: 'See everything you have raised and where it stands.',
    example: '/my-requests',
  },
  {
    name: 'request-report',
    syntax: '/request-report request:<start typing a title>',
    summary: 'A full report on one request: status, who has it, and its history.',
    example: '/request-report request:Login fails on mobile',
  },
]

export function clientManual() {
  const embed = new EmbedBuilder()
    .setTitle(MANUAL_TITLE)
    .setDescription(
      'You can see this support channel and the support channels of your projects, and nothing else — ' +
      'so everything you need is here.\n\n' +
      'Use the commands below anywhere you can type. Replies are only visible to you.',
    )
    .setColor(0x00b0f4)
  for (const c of CLIENT_COMMANDS) {
    const extra = c.name === 'report-issue' || c.name === 'request-feature'
      ? ' You can attach two screenshots and a document (`screenshot`, `screenshot2`, `document`). The other fields — platform, OS, steps and so on — are optional, but filling them saves a round of questions.'
      : ''
    embed.addFields({
      name: `/${c.name} — ${c.summary}`,
      value: `\`${c.syntax}\`${extra}\nExample: \`${c.example}\``,
    })
  }
  embed.addFields(
    {
      name: 'What happens after you raise a request',
      value: 'A private channel opens for it — only you and the team can see it. The team is told, and every status change is posted there and sent to you as a message. You can post more documents or screenshots in that request\'s channel at any time.',
    },
    {
      name: '"Waiting on you"',
      value: 'A request marked **Waiting on you** means the team needs something from you. Answer in that request\'s channel.',
    },
  )
  return embed
}
