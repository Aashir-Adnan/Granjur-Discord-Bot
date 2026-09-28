# Current Session

**Date:** 2026-09-29

## Outcome
BUILT: Identity link and access scoping (roadmap sub-project 1 of 7). Owner request
delivered end-to-end across three repos (bot, CSAAS, UBS-Doc site) on branch
`feat/identity-link`. Eleven tasks via subagent-driven development, all reviewed clean
(most on the first pass). Knowledge and state written this session (Task 11); nothing
merged or deployed.

## What was built
See `.claude/knowledge/identity-link.md` for the full mechanics and
`.claude/state/completed.md`'s 2026-09-29 entry for the commit list per repo. In short:
a stored `discord_identity_link` table in CSAAS maps a UBS-Doc account to a Discord
member per guild, made automatically by exact verified-email match or by a `/link`
code from Discord; `resolveIdentity` computes `isAdmin`/`seesAll`; `visibility.js`
narrows the tasks read, the stats endpoint, and every write handler to "my project"
(explicit member or task holder); the site shows a link card when unlinked, a
signed-in line, hidden-ref stubs for tasks outside the caller's view, and an
admin-only links panel on People.

## Rollout status: OPEN
See `backlog.md` roadmap item 1 ("built, not deployed") for the full rollout order
(bot → site → CSAAS by hand) and first live checks. Nothing has been deployed anywhere.
The site ships before CSAAS because the new site works against the old CSAAS (no `viewer` in the payload, so no link card and nothing changes), while the old site against the new CSAAS would leave unlinked users on an empty page with no way to link.

## Deferred, not part of this rollout
- Bot: fix `verifiedAt` surviving an invite-rejoin email overwrite (root cause of the
  admin-unlink-blocks-email-relink rule).
- Bot: activity log should record blocker/subtask ids, not titles (CSAAS currently
  scrubs hidden refs by title match, which is heuristic, not exact).
- Visual check of the link card and admin links panel was never done (no portal
  sign-in available during the build) — needed before calling this fully verified.

## Knowledge/skill files used this session
- `.claude/knowledge/identity-link.md` (new, written this session)
- `.claude/knowledge/project-tasks-site.md` (pointer added)
- `.claude/knowledge/README.md` (index entry added)
- Read for context: spec `docs/superpowers/specs/2026-09-28-identity-link-access-scoping-design.md`,
  ledger `.superpowers/sdd/2026-09-28-identity-link-access-scoping/progress.md`, and the
  actual code in all three repos (bot `commands/link.js`, `services/internalTaskRoute.js`;
  CSAAS `identity.js`, `visibility.js`, `discordIdentity.js`, `discordTasks.js`,
  `discordTasksWrite.js`; site `payloadLogic.ts`, `LinkCard.tsx`, `IdentityLinks.tsx`,
  `identityLogic.ts`, `TeamLayout.tsx`).

## Open questions
None — Task 11 (this session) was the last of the eleven planned tasks. The next step
is the owner's call on when to run the rollout.
