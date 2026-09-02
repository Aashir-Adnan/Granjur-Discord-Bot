# Backlog

Outstanding work, highest priority first. Move items to `completed.md` (dated) when done.

---

## `/meetings` — manager filter is name-based
`isManager()` matches role names `CEO` / `Server Manager` (plus owner / ManageGuild).
If those role names ever change, managers silently lose the all-meetings view. Consider
reusing `guildConfig` role-id lists instead.

## Mixed meeting playback track
`/playback` still plays one speaker's file at a time. No step mixes the per-speaker
`.ogg` files into a single meeting track. Would need ffmpeg `amix` / `amerge`.

## `/schedule` — still open
- Per-user timezone override (deliberately skipped — per-guild only for now).
- Voice-channel picker step (currently `voiceChannelId` is always null).

---

## Dead vendored `bot/src/Database/*` files — remove or repair
15 files under `bot/src/Database/` fail to import (missing `../../SysFunctions/*`,
extension-less relative imports, and a duplicate `getColumnNameFromMapper` declaration
in `executeQueryWithPagination.js` that is a hard SyntaxError). Nothing on the live
path imports them — the real DB layer is only `connection.js`, `helpers.js`,
`index.js`. Decide: delete, or fix if the abstraction is wanted.
