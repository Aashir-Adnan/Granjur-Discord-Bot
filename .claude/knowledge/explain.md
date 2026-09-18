# /explain — how it works and how to debug it

**What:** `/explain project:<picker> question:<text>` answers from a project's documentation.
One-shot; no session. Documentation only (no code) as of 2026-09-04.

**Where Claude runs:** on the VM, inside `/var/www/CSAAS/CSAAS_Backend/Repos/UBS-Doc/docs`,
via CSAAS `POST /api/meeting/workflow/explain` → `Services/SysScripts/AIScripts/explainAgent.js`
→ `claudeClient.chat` (Claude CLI as `azureuser`). The bot never talks to Claude directly.

**Scoping is the working directory.** A project with `project.docsPaths` runs in
`docs/<first docsPath>`; no project or no `docsPaths` runs in `docs/`. The footer says
`All documentation` whenever scoping did not happen — that is the first thing to check
when a project answer looks too broad.

**Tools:** the explain call runs WITHOUT `--dangerously-skip-permissions` — `claudeClient`
passes that flag on every call by default, but `explainAgent.js` opts out per-call with
`skipPermissions: false`. In `-p` mode, without that flag, a `Read`/`Grep`/`Glob` outside the
working directory needs a permission nobody can grant and is denied — this is what makes the
working directory an actual jail, not just a default starting point (with the flag present, an
absolute-path read escapes it regardless of `--allowedTools`/`--disallowedTools`). On top of that:
`--setting-sources user` so a `.claude/settings.json` committed inside the docs clone itself
cannot grant permissions back; `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch,Task`
via `claudeClient`'s `extraArgs` option as belt-and-braces on top of both. `/explain` also refuses
to run at all unless the server has `CLAUDE_BACKEND=cli` — `runExplain` asserts
`getBackend() === "cli"` before doing anything else and fails closed (throws) otherwise, since the
API backend cannot read the documentation clone.

**Docs freshness:** `git pull --ff-only` on the clone at most every 15 minutes, before a run.

**Debugging:**
- `pm2 logs csaas | grep '\[explain\]'` — one line per question: scope, reference count, ms.
- `pm2 logs csaas | grep claudeClient` — prompt length and CLI duration.
- Bot side: `[explain] CSAAS failed (status N)` in `pm2 logs granjur-bot`.
- Non-JSON from the model is retried once, then returned as plain text with no references.
  Not an error; if it happens often, the prompt in `explainAgent.js` needs tightening.

**Limits:** question ≤ 500 chars; references ≤ 8; answer trimmed at 4000; 120 s bot-side timeout.

**Tests:** `bot/src/services/explainRender.test.js`, `bot/src/commands/explain.test.js`,
`bot/src/services/csaasClient.test.js`; CSAAS `Services/SysScripts/TestScripts/meeting-test/explainAgent.test.js`.
