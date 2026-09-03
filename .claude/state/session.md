# Current Session

**Date:** 2026-09-03

## Goal (done, pending live acceptance)
Phase 1 of project documentation: sync the UBS-Doc repository into MySQL and make it
browsable from Discord, organised by project. Read-only — writing back to UBS-Doc is
deliberately out of scope.

## State
Branch `feat/project-docs`, 21 commits, **not merged** (the human partner asked that it not
be merged; note that pushing `main` auto-deploys to the VM).

Spec: `docs/superpowers/specs/2026-09-03-project-docs-preview-design.md`
Plan: `docs/superpowers/plans/2026-09-03-project-docs-preview.md`
Knowledge written: `.claude/knowledge/project-docs.md`

## Verified
- 54 tests pass (`npm test`, first test suite in this repo).
- Migration 012 applied to production; 173 pages synced, 138 attributed to Badar HMS.
- All 173 documents render to 674 embed pages, longest 3800 of Discord's 4096, zero
  unbalanced code fences.
- All 102 levels of the browse tree walked: every document reachable exactly once, no level
  over the 25-option cap, no component value over 100 characters.
- The bot starts on this branch, registers 37 commands, and its sync cycle leaves the mirror
  intact.

## NOT yet verified
The interactive Discord acceptance checks in Task 10 of the plan — clicking through `/docs`,
`/projects`, `/edit-docs` and the `#documentation` channel in the server. Everything above is
automated verification.

## Live-testing procedure
The VM at 20.120.228.55 runs `main` under pm2 and shares this token and database, so it must
be stopped before running locally:

    ssh -i "C:/Users/Dell/Downloads/frame-work_key.pem" azureuser@20.120.228.55 "pm2 stop granjur-bot"
    node bot/src/index.js            # locally, from the repo root
    ssh ... "pm2 start granjur-bot"  # restore production afterwards

Starting locally re-registers 37 commands for the guild; restarting the VM bot puts the
36-command `main` set back. Watch for a stale `node bot/src/index.js` holding port 4070.

## Open follow-ups
See `backlog.md` — the deferred findings from the final review are recorded there.
