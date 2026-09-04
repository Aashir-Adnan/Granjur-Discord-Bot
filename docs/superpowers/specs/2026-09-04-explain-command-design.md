# `/explain` — ask a question of a project's documentation

**Date:** 2026-09-04
**Status:** approved in discussion; awaiting spec review
**Related:** `docs/superpowers/specs/2026-09-03-project-docs-preview-design.md` (the docs
mirror this reads), `docs/superpowers/specs/2026-09-01-meeting-to-tasks-integration-design.md`
(the CSAAS client and endpoint conventions this reuses)

## 1. What it is

A Discord slash command, `/explain`, that lets a verified member pick a project (or "no
project") and ask a free-text question. Claude answers from that project's documentation
and cites the pages it used. Each reference is a link to the live docs site.

One-shot: a question gets one answer. There is no session, no thread, no follow-up
context. Asking a follow-up is running `/explain` again.

Documentation only, for now. The design leaves room for the project's code repository
to be added as a second source, but v1 does not read code. (The Badar HMS clone on the VM
is stale; a fresh clone will be wired in separately.)

## 2. Where Claude runs

Claude runs **on the VM, inside the `UBS-Doc` clone**, through the existing CSAAS
`claudeClient` (`Services/SysScripts/AgentScripts/claudeClient.js`), which invokes the
Claude CLI (`claude -p`) as `azureuser`. The bot has no Claude access of its own and does
not gain any; it calls a CSAAS endpoint, the same way the meeting pipeline does.

Rationale, recorded so it is not re-litigated: the VM already holds the clones and an
authenticated CLI; the CLI can search the documents itself and cite what it actually
read, whereas a prompt-stuffing approach can only cite what happened to fit.

## 3. Scoping by working directory

Isolation is the **working directory**, not the prompt.

| Picker choice | `cwd` for the CLI | Footer label |
|---|---|---|
| A project with `docsPaths` (e.g. Badar HMS → `["hms-documentation"]`) | `Repos/UBS-Doc/docs/<first docsPath>` | the project name |
| A project with no `docsPaths` (Framework, CSAAS today) | `Repos/UBS-Doc/docs` | *All documentation* |
| "No project — all documentation" | `Repos/UBS-Doc/docs` | *All documentation* |

Claude cannot cite a file it cannot see, so a project-scoped answer cannot leak another
project's pages. A project with several `docsPaths` uses the first; multi-root scoping is
out of scope for v1 and only one project has `docsPaths` at all today.

The footer label makes it visible when scoping did **not** happen, so a project with no
`docsPaths` does not silently answer from everything while looking scoped.

## 4. The CSAAS endpoint

`POST /api/meeting/workflow/explain` — added to the hand-written `MeetingWorkflow` map
in `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js`, next to `/assign`.

- `requestMetaData.requestMethod` is the array `["POST", "GET"]`, as fixed for the
  other four hand-written meeting endpoints on 2026-09-04 (the map never goes through
  `ApiObjectsGenerator`, so a string here 405s every method).
- `permission: "view_meetings"` — the existing read-only meeting permission. URDD 6
  already holds it. No new permission for v1.
- `encryption: false` — plain JSON over the VM's loopback, like the other meeting
  endpoints.

**Request body**

```json
{
  "question": "How does the cancellation window work for bookings?",
  "project": { "name": "Badar HMS", "docsPaths": ["hms-documentation"] }
}
```

`project` is `null` for "no project". `question` is required, 1–500 characters.

**Behaviour**

1. Resolve `cwd` per §3. If the resolved directory does not exist, fall back to the docs
   root and label *All documentation*; log the miss.
2. **Refresh the clone** with `git -C Repos/UBS-Doc pull --ff-only` if the last pull was
   more than 15 minutes ago (module-level timestamp). The 15 minutes matches the bot's
   docs sync interval so `/docs` and `/explain` see the same content. A failed pull is
   logged and the run continues on the existing clone.
3. Call `claudeClient.chat(messages, { cwd, system, extraArgs, model })` where:
   - `messages` is one user turn: the question.
   - `system` is the explainer prompt (§5).
   - `extraArgs` is
     `["--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch,Task"]`.
     `claudeClient` passes `--dangerously-skip-permissions` on every call (verified
     2026-09-04 — meeting analysis runs with every tool enabled), and under that flag an
     `--allowedTools` allowlist does not restrict anything. `--disallowedTools` removes
     the tools from the session outright, which holds regardless of permission mode.
     Read, Grep and Glob remain — all the explainer needs.
     `extraArgs` is a **new** option on `claudeClient.chat` / `chatViaLocalCli`:
     appended to the CLI argv after the existing output flags. Today the only way to
     add CLI flags is the global `CLAUDE_CLI_ARGS_JSON` env var; a per-call option is
     needed so this endpoint's tool restriction does not leak into meeting analysis.
   - `claudeClient` already passes `--output-format text`; the endpoint does **not**
     add `--output-format json`. The model's reply arrives as plain text and is expected
     to be the JSON object from §5.
   - `model` is `process.env.EXPLAIN_MODEL || undefined` (falls through to the CLI's
     default), so the explainer can be pinned independently of meeting analysis.
4. Parse the result (§6).
5. Respond `{ answer, references, scope, model, durationMs }`.

**Response body**

```json
{
  "answer": "Bookings can be cancelled without charge up to …",
  "references": [
    { "path": "major-implementations/booking-rules/booking-rules-requirements.md",
      "heading": "Cancellation window",
      "quote": "A booking may be cancelled …" }
  ],
  "scope": "Badar HMS",
  "model": "claude-sonnet-4-6",
  "durationMs": 41250
}
```

`path` is **relative to the `cwd` Claude ran in**. The endpoint rewrites it to be
relative to the docs root (prefixing the docsPath) before responding, so the bot never
needs to know which directory Claude was in. A question the documents do not cover
returns a normal 200 with an answer saying so and `references: []`.

## 5. The explainer prompt

System prompt, verbatim:

> You are answering a question about a software project using only the documentation in
> the current directory. Search it with the tools you have; read the pages that are
> relevant; then answer.
>
> Rules:
> - Answer only from what these documents say. If they do not cover the question, say so
>   plainly and do not guess. Do not use knowledge from outside these files.
> - Keep the answer under 1500 characters. Prefer a direct answer followed by the
>   essential detail. Use Markdown that Discord renders: bold, inline code, bullet lists.
>   No headings, no tables.
> - Cite every page you relied on. A reference is the file's path relative to the
>   current directory, plus the nearest heading if there is one, plus a short verbatim
>   quote (under 200 characters) that supports the answer.
> - Respond with a single JSON object and nothing else:
>   `{"answer": "...", "references": [{"path": "...", "heading": "...", "quote": "..."}]}`
>   `heading` and `quote` may be empty strings. `references` may be empty.

## 6. Parsing, with a fallback

The model's reply is plain text (`--output-format text`) expected to be the JSON object
from §5. The parser:

1. Try `JSON.parse` on the trimmed text. If that fails, try the first balanced `{…}`
   block found in it (models sometimes wrap JSON in a code fence or add a sentence).
2. If still not JSON: **retry once** with the user turn suffixed by
   `"Respond with the JSON object only — no prose, no code fence."`
3. If the retry is also not JSON: return the raw text as `answer` with
   `references: []`. A readable answer beats an error.

`references` entries missing `path` are dropped; `heading` and `quote` default to `""`;
the list is capped at **8** server-side.

## 7. The bot command

`bot/src/commands/explain.js`:

```
/explain project:<autocomplete> question:<string, 1–500>
```

- **`project`** autocomplete: the fixed entry **"No project — all documentation"**
  (value `none`) first, then the guild's rows from the `project` table by name, matching
  on the typed text. Value is the project id.
- **`question`**: required, `setMaxLength(500)`.
- Role: `Verified` (`commandRoles` in `command-config.json`), like `/docs`.
- `dedicatedChannels.explain: true` so `/init` creates a `#explain` channel; the command
  still works in any channel.
- `commandDescriptions.explain` written for `/help`.

**Flow**

1. `deferReply()` — **public**, not ephemeral. An answer in a channel helps the next
   person who would have asked the same thing.
2. Resolve the project row (or `null` for `none`). Build the request body from its
   `name` and `docsPaths`.
3. `csaasClient.explain(body)` — a new export in `bot/src/services/csaasClient.js`
   beside `assign`/`approve`. `postJson` gains an optional `{ timeoutMs }` third
   argument (today the timeout is only the global `CSAAS_REQUEST_TIMEOUT_MS`, default
   300 s); `explain` passes **120 000 ms**. The CLI runs 30–90 s; the interaction token
   lasts 15 minutes.
4. Render (§8) and `editReply`.

## 8. Rendering

One embed, built by a **pure** function `buildExplainEmbed(result, lookupTitle)` in
`bot/src/services/explainRender.js` so it is unit-testable without Discord.

- **Title**: the question, trimmed to 256.
- **Description**: `answer`, capped at **4000**. If longer, cut at the last paragraph
  break before 3900 and append `\n\n_…answer trimmed_`.
- **Field "References"**: one line per reference, at most 8:

  ```
  📄 [Booking Rules Requirements](https://ubs-doc.vercel.app/docs/hms-documentation/major-implementations/booking-rules/booking-rules-requirements) › Cancellation window
  📄 [init](https://ubs-doc.vercel.app/docs/init)
  ```

  - The link is `docUrl(siteUrl, docId)` from `bot/src/utils/docRender.js`, where
    `docId` is the reference `path` with its `.md`/`.mdx` extension removed
    (`toDocId` in `docPath.js` already does this).
  - The link text is the page's `title` from `docpage` when the path is mirrored there;
    otherwise the last path segment. `lookupTitle(docId) → string | null` is injected.
  - `› heading` is appended only when non-empty. `quote` is **not** rendered — it is for
    the log and for a later "show quotes" affordance, not for the embed.
  - Zero references renders the field value `_No specific pages cited._`
- **Footer**: `<scope> · <seconds>s` — e.g. `Badar HMS · 41s` or `All documentation · 12s`.
- **Colour**: `0x5865f2`, consistent with `/docs`.
- No components. One-shot means no "follow up" button that would imply a session.

## 9. Failure handling

| Case | Behaviour |
|---|---|
| CSAAS unreachable, 5xx, or timeout | `editReply("Couldn't reach the explainer — try again in a minute.")`; log status and body. |
| CSAAS 4xx (permission, validation) | Same user message; log at `error` because it is a configuration fault, not a transient. |
| Model returns non-JSON twice | Raw text as `answer`, empty references (§6). Not an error. |
| Docs do not cover the question | Normal answer saying so. Not an error. |
| `git pull` fails | Logged; run proceeds on the current clone. |
| Resolved `cwd` missing | Fall back to docs root; footer shows *All documentation*; logged. |
| Project has no `docsPaths` | Docs root; footer shows *All documentation*. |
| Question over 500 chars | Discord enforces the option limit. |

Deliberately **not** in v1: per-user rate limiting (each question is one CLI session; the
natural cost is the limit until it proves otherwise), answer caching, code-repository
sources, threads/follow-ups.

## 10. Configuration

Bot `.env` (already present for the meeting pipeline): `CSAAS_API_URL`,
`CSAAS_ACTOR_URDD`. Nothing new.

CSAAS `.env`: optional `EXPLAIN_MODEL`. Nothing else new.

## 11. Testing

**Bot — `node:test`, alongside the source as the rest of the repo does**

- `explainRender.test.js`: title trim; description cap and paragraph-boundary trim;
  reference line with and without heading; `docpage` title vs filename fallback;
  8-cap; empty-references text; footer scope and seconds.
- `explain.test.js` (autocomplete): "No project" first; projects filtered by typed text;
  values are ids; ≤ 25 choices.
- `csaasClient.test.js`: `explain()` posts the expected body and passes the timeout.

**CSAAS — Jest, in `Services/SysScripts/TestScripts/`, as `/assign` was tested**

- `explainPrompt.test.js`: `cwd` resolution per §3 including the missing-directory
  fallback; docsPath prefixing of reference paths.
- `explainParse.test.js`: envelope unwrap; direct JSON; fenced JSON; retry path;
  raw-text fallback; 8-cap; dropped entries without `path`.
- `claudeClient.extraArgs.test.js`: `extraArgs` appear in the spawned argv after the
  output flags, and only for calls that pass them; `--disallowedTools` is present for
  an explain call and absent for a meeting-analysis call.

**Live, after deploy, through the real endpoint**

1. Badar HMS, a question the docs answer (e.g. booking cancellation) — references
   resolve to real `ubs-doc.vercel.app` pages under `hms-documentation`.
2. No project, a question answered by `init.md` or `intro/` — reference outside
   `hms-documentation` proves the root scope.
3. Badar HMS, a question the docs do not cover — the answer says so, zero references,
   no error.

## 12. Files

| Side | File | Change |
|---|---|---|
| CSAAS | `Services/SysScripts/AgentScripts/claudeClient.js` | `options.extraArgs` passthrough in `chatViaLocalCli` and `chat` |
| Bot | `bot/src/services/csaasClient.js` | `postJson(path, body, { timeoutMs })` |
| CSAAS | `Services/SysScripts/AIScripts/explainAgent.js` | **new**: `resolveScope`, `buildExplainPrompt`, `parseExplainResult`, `runExplain` |
| CSAAS | `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js` | `/explain` entry |
| CSAAS | `Services/SysScripts/TestScripts/meeting-test/explain*.test.js` | tests |
| Bot | `bot/src/services/csaasClient.js` | `explain()` |
| Bot | `bot/src/services/explainRender.js` (+ test) | **new**: `buildExplainEmbed` |
| Bot | `bot/src/commands/explain.js` (+ test) | **new**: command, autocomplete |
| Bot | `bot/src/commands/index.js` | register |
| Bot | `bot/src/config/command-config.json` | roles, dedicated channel, description |
| Bot | `.claude/knowledge/` | a page on how `/explain` scopes and where it runs |

## 13. Out of scope, recorded for later

- **Code as a source.** Add the project's repository clone as a second `cwd` root (or
  run with `--add-dir`) once the fresh HMS clone lives on the VM. The response shape
  already allows non-doc references; rendering would need a `file:line` form.
- **Threads.** A follow-up mode keeping the CLI session (`--resume`) per Discord thread,
  with an idle timeout.
- **Multiple `docsPaths` per project.**
- **Rate limiting and caching.**
