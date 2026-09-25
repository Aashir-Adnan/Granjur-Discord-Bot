# Current Session

**Date:** 2026-09-25

## Goal
Every text channel the bot creates or repairs grants Attach Files, Embed Links and Add
Reactions beside View/Send/History; existing channels are upgraded by `/setup` and
`/project-setup`. Owner report: "there is no option to send a document, video or any
image in channel."

## Outcome: BUILT on `feat/attach-files`, not merged, not deployed
Design `docs/superpowers/specs/2026-09-25-attach-files-design.md` (commit `93bb7ce`), then:

- `47fe215` feat(perms): one six-bit text allow for every channel the bot creates
- `34f2e4b` feat(project-setup): bit-aware repair of the text allow the bot owns
- `6599c39` feat(setup): /setup upgrades the support pair's allow entries to the six bits
- the docs commit (this file, `completed.md`, `backlog.md`, knowledge)

Full suite 1216 pass / 0 fail, always with `DATABASE_URL=poisoned://no-production-access`.
Report: `.superpowers/sdd/attach-files-report.md`.

Knowledge in use: `.claude/knowledge/project-sections.md` (new "Text permissions"
section), `.claude/knowledge/client-role.md` (one paragraph), `.claude/knowledge/ticket-archive.md`
(the divider stays read-only). Rule in force: `.claude/rules/tests-never-touch-production.md`.

## One deliberate reading of the design
`lacksTextAllow(allow, deny)` takes the deny too: a bit the overwrite DENIES is never
"missing". Without it, every ticket locked on finishing (SendMessages moved to deny) would
be planned `grant` and get SendMessages OR-ed back into its allow, which beats the deny
inside one overwrite: `/project-setup all:true` would re-open every finished ticket. The
design says lock/unlock is unchanged and deny is kept; this is what makes both true.

## Next session
Merge `feat/attach-files`, deploy, `/setup` once, `/project-setup project:<X> preview:true`
then for real (or `all:true`). Check that a client can attach a file in a request channel.
