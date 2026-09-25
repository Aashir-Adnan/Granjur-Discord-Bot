# Attachments, embeds and reactions in every bot-made text channel — design

**Date:** 2026-09-25
**Trigger:** the owner reports "there is no option to send a document, video or any
image in channel". The bot has only ever granted three text bits — `ViewChannel`,
`SendMessages`, `ReadMessageHistory` — on everything it creates, so attachments
depend on the server's `@everyone` defaults. Clients in particular are meant to
attach documents to their request channels and cannot.

## 1. The one allow set

`bot/src/utils/textAllow.js` (leaf):

```js
export const TEXT_ALLOW = [ViewChannel, SendMessages, ReadMessageHistory, AttachFiles, EmbedLinks, AddReactions]
export const TEXT_ALLOW_OBJ = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true, AddReactions: true }
export const VOICE_EXTRA = [Connect, Speak, UseVAD, Stream]
/** True when `allow` (bigint | PermissionsBitField | number | string) can be read and lacks any TEXT_ALLOW bit. Unreadable → false. */
export function lacksTextAllow(allow)
```

Every place that writes a text allow uses it:

| Writer | Today | Now |
|---|---|---|
| `services/taskTicketChannel.js` `MEMBER_PERMS` / `PROJECT_ROLE_PERMS` | 3 bits | `TEXT_ALLOW` |
| `services/projectSection.js` `ROLE_ALLOW` | 3 + voice | `[...TEXT_ALLOW, ...VOICE_EXTRA]` |
| `services/clientAccess.js` `CLIENT_TEXT_ALLOW(_OBJ)`, `CLIENT_VOICE_ALLOW(_OBJ)` | 3 (+ voice) | `TEXT_ALLOW` / `TEXT_ALLOW_OBJ` (+ `VOICE_EXTRA`) |
| `commands/create-task.js`, `commands/bug.js`, `commands/feature.js` member entries | 3 bits inline | `TEXT_ALLOW` |
| `services/meetingAutoChannel.js`, `commands/create-channel.js` member/role allows on text channels | inline | `TEXT_ALLOW` (voice: `+ VOICE_EXTRA`) |
| `services/taskUpdateNotify.js` assignee grant (`permissionOverwrites.edit(id, {...})`) | 3 flags | `TEXT_ALLOW_OBJ` |
| `commands/project-members.js` client / client-manager grants | `CLIENT_TEXT_ALLOW_OBJ` | unchanged (follows the constant) |

The archive divider is untouched: its allow stays `ViewChannel + ReadMessageHistory`
and its deny already covers `SendMessages`, threads and `AddReactions`. The
`@everyone` deny on categories and channels is untouched. `init.js`'s
announcement-style channels (`@everyone` view/read only) are untouched.

## 2. Repair of existing channels

Every repair today is presence-only ("the overwrite exists → nothing to do"),
which is right for deny bits an admin removed on purpose but wrong for allow bits
the bot never wrote. Rule for this change: **an overwrite the bot owns whose allow
lacks a `TEXT_ALLOW` bit is repaired by OR-ing the missing allow bits in; its deny
is kept as is; nothing is ever removed.** Presence-only stays for everything else.

- `projectSection.js`
  - Observer: each section-channel and task entry gains
    `roleAllowIncomplete: boolean` (the gate role's overwrite is present and
    `lacksTextAllow(allow)`; false when absent, unreadable, or no role) and
    `membersIncomplete: boolean` (any `OverwriteType.Member` overwrite whose allow
    has `ViewChannel` and `lacksTextAllow`). The category entry gains
    `roleAllowIncomplete` too.
  - Planner: `needsAllow = lacksRoleAllow(...) || roleAllowIncomplete || membersIncomplete`
    (same `grant` / `opens` machinery, same wording — "opened to the project role"
    is still the truth: the role gains what it lacked).
  - Applier: `roleAllowMerged(channel, roleId)` returns a merge whenever the role
    entry is absent OR incomplete; the merge for the role id ORs allow bits into the
    existing entry and keeps its deny. It also upgrades every Member entry that
    `lacksTextAllow` (allow OR `TEXT_ALLOW`, deny kept). The category repair
    (`missingOverwrites`) becomes bit-aware for the role entry in the same way.
    `mergedOverwrites` therefore takes `required` entries and, for an id that
    already exists, emits `{ id, type, allow: existing | required, deny: existing }`.
  - Client access plan: a wanted client whose member overwrite exists but
    `lacksTextAllow` counts as `missing`, so `grantClients` re-edits it with
    `CLIENT_TEXT_ALLOW_OBJ` / `CLIENT_VOICE_ALLOW_OBJ` (`permissionOverwrites.edit`
    merges).
- `clientAccess.js` `repairOverwrites` (used by `/setup` for the global support
  pair): bit-aware for the Client role entry the same way.
- Voice channels: `voiceGaps` already repairs the voice bits; unchanged.

## 3. What does not change

Lock/unlock on finishing (`SendMessages` only — with it denied nothing can be
posted, attachments included), the divider, the sweep, the notice, project-role
membership, `/cleanup`.

## 4. Tests (fakes only; `DATABASE_URL=poisoned://no-production-access`)

- `utils/textAllow.test.js`: the sets; `lacksTextAllow` on bigint, `PermissionsBitField`,
  string, null.
- `taskTicketChannel.test.js`: created member and role entries carry the six bits.
- `projectSection.test.js`: a section channel whose role overwrite has the old three
  bits is planned `grant` and the edit carries `allow` with all six and the old
  `deny` intact; a task channel whose assignee entry has three bits gets it upgraded
  in the same edit as the role allow; a category with a three-bit role entry is
  repaired; a client entry with three bits is re-granted; a channel already carrying
  all six bits is `none`/`reuse` with no edit (idempotent).
- `clientAccess.test.js`: `repairOverwrites` upgrades a three-bit Client entry and
  leaves a six-bit one alone.
- Command/notify tests adjusted where they pin the three-bit set.

## 5. Rollout

Deploy, then `/setup` once (global support pair) and `/project-setup all:true`
(every section channel, ticket channel, category and client overwrite). New
channels carry the bits from creation.
