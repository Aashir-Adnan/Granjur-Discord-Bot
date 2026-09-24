# Current Session

**Date:** 2026-09-24

## Goal
A `Client` role in the Discord bot only: invitation-only entry, approval without `Verified`, a
global and a per-project support pair, client-raised issues/feature requests as tasks, tracking and
reports, and a deny-by-default command gate.

## Outcome — MERGED, PUSHED AND DEPLOYED (4297b2e; follow-up 3b3c130)
Brainstorm → spec → plan → subagent-driven development (9 tasks, each with a fresh implementer
and reviewer) → whole-branch review (opus) → one fix wave → scoped re-review. 19 commits
`4683821..285f0bc`, merged `--no-ff` as `4297b2e`; 1079 tests green on the merged result with
`DATABASE_URL=poisoned://no-production-access`. Branch deleted, pushed, deploy run green. A follow-up pinned the client manual in every
project support channel (`3b3c130`). The owner has the acceptance-test script and is testing
on the live server.

Knowledge in use: `.claude/knowledge/client-role.md`, `.claude/knowledge/project-sections.md`.
Rule in force: `.claude/rules/tests-never-touch-production.md`.

## Decisions worth not re-litigating
- **A client never receives `Verified`.** Everything staff see is granted to `Verified`, so a
  client without it sees nothing by construction; what they can see is granted explicitly.
- **Deny-by-default for clients, including autocomplete.** An empty `commandRoles` list means
  "anyone" for staff, never for a client; `autocompleteAllowed` closes the one interaction type
  the command gate did not cover.
- **`clientIds: null` fails closed.** `observeProjectSection` plans no client access unless the
  caller read the roster; `[]` means "read it, no clients". The first live `/project-setup` on
  the nine existing sections creates two channels each, grants nobody, revokes nothing.
- **Stale member overwrites on the support pair are revoked by design** — the twin of the role
  sync stripping non-row holders — but only when the roster was actually read in full.
- **The pinned members panel shows clients; only the role sync is staff-only.**
- **`/project-members add role:client` revokes the project role unconditionally** — a failed
  prior roster read must never leave a client holding it.
- **Blocker warnings and unblock notices never reach a `requestedBy` channel** — another task's
  title is internal.
- **`/set-roles` refuses clients**; converting client ↔ staff is by hand.

## Rollout, once merged and deployed
1. `/setup` (creates the Client role and `🛟 Support`, pins the manual, denies clients the public
   channels). 2. `/project-setup project:<X> preview:true` then for real, per project with clients.
3. `/invite emails:<…> client:true` → the client verifies → `/approve`.
4. `/project-members add member:@client project:<X> role:client`.

## Live-test findings so far
- Client saw `#time-reports` → fixed by deriving the deny from `@everyone` visibility (`de5c893`).
  The owner must run `/setup` once more to apply it to the other public channels for the
  existing client; `#time-reports` itself self-heals on the bot's first tick after the deploy.

- Owner asked for structured fields on the two raising commands → shipped (optional fields,
  screenshots, full-details follow-up when the embed would cut the text).

- Casual chat per project for clients → shipped (`fe8979d` + test fix `0a3b992`). Existing
  sections need one `/project-setup` run each to get the channel; their clients are granted in
  the same run.

- Client Manager role → shipped (`62669e9`). Assign with `/project-members add … role:Client
  Manager` to someone already approved as a client.

- `/request-task` for support tasks → shipped (`16b5528`).

## Open items
See `backlog.md` → "Client role — deferred follow-ups". The one worth raising first: both gates
fail open when the member cannot be resolved (read `interaction.member`).
