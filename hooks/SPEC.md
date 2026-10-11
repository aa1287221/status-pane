# status-pane — SPEC (2026-10-09, Claude Code 2.1.294)

Replaces the native `statusLine` (`node ~/.claude/statusline.js`, a cc-statusline fork) with a
function-hooks mod. Two display sites:

- **Pane** docked right (`$.ui.open({ id: 'status-pane' })`): the full dashboard as gauge cards, with
  every row `statusline.js` draws.
- **PromptHint `tail`**: one compact, always-visible line under the prompt (stays visible when
  `/diff` or another plugin's pane covers the dock).

No `AbovePrompt` band: tw-stock-mod already answers that site without calling `next` (its
`register.tsx:2347`), and the order of plugins in a chain is undocumented.

## Files

```
~/.claude/plugins/status-pane/
  .claude-plugin/plugin.json   { "name": "status-pane", "version": "0.1.0", "description": "...",
                                 "author": { "name": "aa1287221" }, "types": "./hooks/state.d.ts" }
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           wiring: events, timers, render hooks, and `ioOf($)`, the `Io` seam
  hooks/collect.ts             collectors (usage, git, /proc, side files, mcp, memory); they take `Io`, never `$`
  hooks/model.ts               pure functions: the tail; step(); aggMax(); countdown; cpu delta; meminfo;
                               patch line count; formatters; staleness; sid; the progress view (`progressOf`, `progressText`) and the in-flight view (`inflightOf`)
  hooks/pane.ts                pure view: snapshot -> `Layout` (cards as plain data) -> engine elements
                               (`paneLayout`, `layoutTree`); gauge and chart Raster encoders; text fitting
  hooks/state.d.ts             $.state contract and the snapshot types (a hooks/-located contract is accepted)
  hooks/sidefile.ts            pure reader of the side file contract (hub SCHEMA.md v1): bytes + clock in, a verdict out; `SideIo` is its seam
  hooks/sidefile.fixtures.ts   test-only: embedded copies of the hub's hand-written fixtures (hub commit 6098494)
  hooks/fixture.ts             test-only fake machine; register.tsx never imports it
  hooks/tree.ts                test-only: reads a drawn tree back as text and cards (shares nothing with pane.ts)
  hooks/*.test.ts              `claude plugin test` suites (`progress.test.ts`: the PROGRESS card and `/progress`; `inflight.test.ts`: its BG and PERM rows)
  hooks/SPEC.md                this file
```

**The `Io` seam.** `$` cannot cross an import: validate and the engine refuse `$ is passed to
"probe", imported from "./helper": $ is followed only into a function declared in this same file,
never across an import`, and a helper declared inside `register()` is refused too. So the helpers
that take `$` are top-level functions of `register.tsx` (`tick`, `kick`, `followUp`, `arm`, `watch`,
`noteEffort`, `ioOf`), `ioOf($)` builds an `Io` of closures that spell each `$.noun.method(...)` at
its call site (validate lists them "via ioOf"), and `collect.ts` takes `io`. A test answers every
`Io` call from one fake machine (`hooks/fixture.ts`) beneath the plugin. Per-load memory is one
`run` object passed in.

Of a plugin folder only `.claude-plugin/`, `commands/`, `skills/`, `agents/`, `hooks/` and `scripts/`
are synced across machines (full-backup.sh `USER_PLUGIN_KEEP_DIRS`), plus its top-level `config.json`,
`package.json`, `plugin.json` and `marketplace.json`; the mod keeps to `.claude-plugin/` and `hooks/`,
so nothing of it lives outside the synced set. Loading is via
`CLAUDE_CODE_PLUGIN_DIRS` (deployment is the main session's job, not the implementer's).

## Port source

`~/.claude/statusline.js` is the reference implementation. Port its semantics, not its ANSI
strings or box drawing. Line references below are to that file.

## sid

`sid = (await $.session.id()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)` — identical to the
tracker hooks and `statusline.js` L141. Observed: session
`c07353bf-22c4-47df-8296-6f2dd4b68497` -> `/tmp/claude-*-c07353bf22c447df82966f2d.*`.

## Data mapping, row by row

The side files below are in `$TMPDIR` (`$.env.get('TMPDIR')`, `/tmp` when unset), as `statusline.js`
and the tracker hooks have it through `os.tmpdir()`; the paths say `/tmp`.

| Row (toggle key) | statusline.js | Mod source | Parity |
|---|---|---|---|
| summary (`summary`) | L563-577 | `/tmp/claude-summary-<sid>.txt` first line (<=500 chars) -> the first `r==='u'` entry's `t` in `/tmp/claude-msgs-<sid>.json` (newlines->space, <=60; that entry decides even when empty, L572-576) -> `session <sid[0..8]>`; `n/a` when neither tracker that feeds it is wired (Dependencies) | exact, except: no `session_name` step (no source in the mod), and a message log over 4 MiB (`$.fs.read` rejects) falls back to `session <sid[0..8]>` |
| dir + branch (`dir`/`repo`) | L299-319, L469-472 | `$.session.cwd()`; `~` when under `$HOME` (`$.env.get('HOME')`), on a path boundary and case-sensitively: deliberately unlike L316-319, a case-insensitive prefix match that would shorten `/root2/x` under `/root` to `~2/x`; git via `$.process.run(['git', ...], { cwd, env: { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } })`: `rev-parse --abbrev-ref HEAD`, `status --porcelain`, `remote get-url origin` (`owner/repo`) else basename of `rev-parse --show-toplevel`. Each call has its own budget (status 4 s, the rest 2 s, each guard 0.5 s past that so the host's rejection wins) and waits only for the call it depends on: the `symbolic-ref` lookup and the `--show-toplevel` lookup run beside the status, so a slow status never holds the branch back, and the git row's own guard (5.5 s) fits two calls in a row at full budget. A non-zero exit from `rev-parse` or from `status` makes that part `git n/a (<first stderr line>)`, except "not a git repository" (no repo, drawn without git) and `ambiguous argument 'HEAD'` (a repository with no commits yet: no error, the branch is `git symbolic-ref --short -q HEAD`, or none when that fails too, since `rev-parse` prints `HEAD` on stdout there); a failing `status` keeps the branch; a failing `remote` is normal. The repo name is collected but, as in `statusline.js`, never drawn | exact |
| lines + git state (`dir`/`repo`) | L474-485 | lines ±: `tool.call` hook on `Edit` / `Write` (and any other tool whose result has `structuredPatch`): after `await next(e)`, count `structuredPatch[].lines` starting with `+` / `-`; a `Write` with `type: 'create'` and an empty patch counts every line of `content` as added; error/deny/staged results count 0; every loop's edits count, a subagent's included. Git: porcelain `??` untracked, code containing `A` added, else modified; `✓` when clean and on a branch | lines are ≈ (label `≈` in the pane) |
| model (`model`) | L507-508, L321-364 | `$.session.model()` returns the id: `claude-opus-5-5[1m]` -> `Opus 5.5 [1m]` (drop `claude-`, capitalise the family, join the numeric parts with `.`, drop an 8-digit date, keep a bracket suffix; the older `claude-3-5-sonnet-20241022` order parses too; anything that does not parse is shown as it came, less a leading `Claude `); `v` + `(await $.session.version()).version`; effort: newest `e.effort.level` seen on a main-loop `classic.PostToolUse` / `classic.Stop` input (`classic.PreToolUse`'s `e` is a tool envelope with no `effort`; an input with `agent_id` is a subagent's and is skipped) -> `$.env.get('CLAUDE_EFFORT')` (asked every refresh; a refused read is no answer; measured undefined in the engine) -> the effort the settings name, drawn dim -> left out. **Live** is the first two, in the colour of the level. **Configured** is read from `$.settings.read()` (the merge, then each source from `policy` down to `user`, the read the dependencies already make): the top-level `effortLevel`, else the `modelSettings` entry that has an `effortLevel` and whose key is the longest prefix of the model id (`claude-opus-5` for `claude-opus-5-5`; on a tie the higher source wins). `$.config.list()` has no effort row and no hook runs before the first prompt, so before it nothing live exists. Unknown is omitted with its separator, never drawn as `?`. There is no `effort-current.txt` fallback: the file is global and read `max` in a `medium` session. The hook's level belongs to the session id it was seen under. Colours: low dim, default/medium green, high yellow, xhigh orange, max red; configured: dim whatever the level | exact once a tool has run (before that the configured level, dim, or nothing) |
| cost (`cost`) | L143-172, L487-500, L509-516 | session cost = `cum.cost.total`, stepped from `(await $.session.usage()).cost?.usd` (no ledger: the counter is left alone); all sessions = Σ `cost.total` over `/tmp/claude-cum-*.json` (this session's new total plus the other files); duration = `cum.dur.total`, stepped from `now - usage().startedAt` (ms), shown with `fmtDur(minutes)` (L129-134) | exact |
| agents (`agents`) | L366-392, L535 | `/tmp/claude-agents-<sid>.json`, same grouping (name = `info.name || key`; running vs done; latest `finished`; top 3; `idle`; `n/a` when the tracker hook is not wired, see Dependencies) | exact |
| usage (`usage`) | L174-189, L518-522 | context: `usage().context` -> `percent` and `tokens` / `window` for `used/max`; **no percent, or no tokens yet (a fresh session), is unknown**: a dash and a bare track in the pane, left out of the tail (never 0%); tokens this session = `cum.tok.total`, stepped from `context.tokens + Σ output_tokens of the main loop's turn.complete usages` (a `turn.complete` with an `agentId` adds nothing); all sessions Σ `tok.total`; compactions: `/tmp/claude-compacts-<sid>.json` `.count` (`n/a` when the monitor hook is not wired, that segment only) | context percentage exact once there is one, `used/max` ≈ (it leaves out the last response's output tokens, which `statusline.js` adds); tokens ≈ (label `≈`); the tokens are the `tokens` row of the COST (TOKENS) matrix, governed by the `usage` toggle with their error count, the `$` row by `cost` |
| quota (`quota`) | L190-292, L523 | `usage().rateLimits` (`kind` five_hour / seven_day, `percentUsed`, `resetsAt` ISO 8601 -> epoch seconds) into the shared snapshot file (below), then `aggMax` exactly as L235-257 and the countdown of L282-291 (this session's own reset time). No live reading anywhere (no limits yet, an API-key account, or only entries whose reset has passed): **unknown**, a dash and a bare track (no countdown unless this session has a reset time, which wraps by the period), and the window is left out of the tail, where `statusline.js` draws `0%` (L246-248); a collector that fails (or a `usage()` that fails) still reads `quota n/a (<reason>)` | exact, except that no reading is unknown, not 0% |
| sys (`sys`) | L537-561 | CPU: `/proc/stat` aggregate `cpu` line (the five counters `os.cpus()` sums), delta against the previous refresh's sample kept in `$.state` (first refresh: a dim `—`); the readings are also kept as a ring of the last 16 (`cpuHist`, below); RAM: `/proc/meminfo` `MemTotal` and `MemAvailable` (used = total - available; Node's `os.freemem()` is `MemAvailable` on Linux, equal on this host), GB to one decimal | CPU window differs (refresh interval, not 100 ms) |
| memory + mcp (`memory_mcp`) | L415-451, L525-533 | same existence checks via `$.fs.exists` / `$.fs.list`; MCP from `~/.claude/mcp-status-cache.json` `.servers`; kick `node ~/.claude/hooks/mcp-status-refresh.js` via `$.process.run` at most every 5 min, never awaited by a render or the 30 s tick; the mcp row reads `n/a` when the script is gone | exact |
| edited (`edited`) | L697-719 | `/tmp/claude-files-<sid>.json` (array of names); names >25 chars -> `…` + last 24; joined ` → `, cut to the body width; `idle` when empty; `n/a` when the tracker hook is not wired | exact |

Row toggles: read the rows file each refresh, `~/.gemini/cc-statusline-rows.json` when it exists,
else `~/.claude/cc-statusline-rows.json` (L24-25; same keys; missing file or key = on). `enabled:
false` is the master switch and returns before anything is collected or written, as L31 does: no
git, no `/proc`, no `usage()`, no settings read, no cum or snapshot file, no MCP refresher; the pane says `disabled by
~/.claude/cc-statusline-rows.json` and the tail draws nothing of ours. Lines counted meanwhile stay
pending and are persisted once it is switched on again.
A file that exists but cannot be read or parsed keeps the toggles the pane had. The current file
has no `sys` key, so `sys` stays on (L20 defaults). Rows that are off are not collected (the cum
and snapshot files are written whatever the rows, as `statusline.js` does, but not under the master
switch). The
`agy-*` tmp-file prefix `statusline.js` tries first is not mirrored: a Claude session id has no
such files, and agy is out of scope.

## Progress (the PROGRESS card and `/progress`)

Source: the plugin's own `tool.call` hook, not a tracker file. A call of the main loop (`e.agentId`
absent; a subagent's tool is not what the session is doing, and a main-loop `Agent` call is the
truthful NOW while it runs) is written to `$.state` `status-pane.now` = `{ sid, calls: [{ id, tool,
startedAt }] }` before `next(e)` and removed in a `finally` after it, so a denied or throwing call
still ends. Only the tool name is kept (<= 80 chars), never its arguments. Calls are keyed by
`tool_use_id` (parallel calls sit side by side, at most 16 kept), the record belongs to a session id
like the other counters, and `session.start` and the main loop's `turn.complete` reset it to idle
(the net for an end that was never seen). The bookkeeping keeps counting under the master switch,
like the pending lines; the card is then not drawn.

The elapsed time runs from the start of `next(e)`, which includes the permission prompt (engine doc),
so a call waiting on approval counts as running: it is what the session is waiting on. A call with
no `tool_use_id` gets `<tool>@<ms>#<n>` so two of the same tool in one millisecond stay apart. The
kit's `$.tool.call` does carry `agentId`, so the subagent filter and the subagent `turn.complete`
guard are covered end to end (row 57).

**One view, two renderers.** `progressOf(tools, sid, nowMs)` returns `Res<{ running, more }>`: the
calls oldest first (three at most, the rest counted in `more`) with the elapsed time at the draw
clock (never negative). The card (`progressCard`) and `/progress` (`progressText`) both read it, so
they cannot disagree. Each missing source is its own n/a, never idle or 0: the record cannot be
read (`工具紀錄讀不到：...`), the session id cannot (`session id 讀不到：...`), nothing was recorded
since the plugin loaded (`本次載入後還沒有工具紀錄`), the record belongs to another session
(`紀錄屬於另一個 session`).

- **Card.** `PROGRESS`, a band of its own right after the header at every tier (full width), on
  by default (row key `progress`). Rows: `NOW` with `<tool> <elapsed>` against the right edge, one row per
  call (the label on the first), `+N more` past three; `NOW idle` when nothing runs; the reason in
  full as `n/a（原因）` under the title otherwise. A tool name too long for its row loses its head. The
  elapsed time reads `12s`, `1m05s`, `1h02m`. The card is the place #16 and #52 add their rows to.
  `paneLayout` draws it only when the caller hands over `view.progress`; the Pane hook always does.
- **Repaint.** While a call is in flight a `$.clock.every(2000)` repaint (`ui.invalidate`) moves the
  elapsed time; it is cancelled when the last call ends. The 2 s period is a choice, not a measurement.
- **`/progress`.** Registered in `session.start` with `immediate: true` (a `/progress` typed while a
  turn streams runs at once; #9 probe on 2.1.296: accepted, `command.describe` reads it, 0 model
  calls; the mid-turn timing could not be observed in `-p`, see Acceptance). The hook reads `snap`,
  the `now` record and the clock only: no `usage()`, no refresh, nothing of the turn's state. Its
  text is `progressText`: the card's rows as plain lines (`NOW  Bash 2m10s`, then `     Read 12s`...,
  `NOW  idle`, `NOW  n/a（原因）`); where the card is not drawn it says so (`progress n/a（等待第一次更新）`,
  `（status-pane 已停用）`, `（progress 列已在 rows 檔關閉）`). A throw is one `progress n/a（cannot draw: ...）` line.

### In-flight rows (BG and PERM, #16)

Below NOW the card, and `/progress`, show the background work the session is waiting on and how long it
has waited. What the engine gives (#9 probe, 2.1.296; source level per item):

| Item | Source | Level |
|---|---|---|
| background shell | `classic.Stop` `background_tasks` (`type: 'shell'`) | observed |
| cron (`CronCreate`) | `classic.Stop` `session_crons` | observed |
| `ScheduleWakeup`, `/loop` | `session_crons` (type file says so) | specified, not observed |
| subagent, monitor, workflow | `background_tasks` types `subagent` / `monitor` / `workflow` | specified, not observed |
| end of a task | a `UserMessage` row with `origin.kind: 'task-notification'` and `task.id` | specified, not observed |
| start keys | the `tool.call` result: `Bash` `backgroundTaskId`, `Agent` `agentId` of a `status: 'async_launched'` result, `CronCreate` `id` | specified (2.1.296 source), not observed; that an agent's id is its Stop item's id is inferred |
| permission dialog | not a `background_tasks` type; the type file has `classic.PermissionRequest` but it did not fire under `-p` (#9); the TUI dialog is not tried | **n/a**: the `PERM` row always reads `n/a（-p 下 PermissionRequest 未觸發，TUI 未驗）` |

There is no list call: `background_tasks` and `session_crons` exist only on the Stop input (a snapshot at
the end of a turn), so BG is that snapshot plus the plugin's own bookkeeping, never the engine's live list.
Mid-turn it shows the list of the last Stop; the `snapshot Ns ago` row says how old that is. Before the first
Stop it reads `BG n/a（還沒有回合結束的快照）`.

- **State.** `$.state` `status-pane.inflight` = `{ sid, seenAt, items, starts, dropped? }`. `classic.Stop` of the main loop
  (no `agent_id`) replaces `items` with the snapshot and clears `starts` and `dropped`; a Stop with neither field changes
  nothing, and a field that is absent (not `[]`) leaves that class (tasks / crons) as it was. A subagent's Stop
  is not the session's list.
- **Wait.** Every `tool.call` of `Bash`, `Agent`, `CronCreate` or `ScheduleWakeup`, the main loop's or a subagent's,
  is dated by the clock read before it runs. Once `next` returned without `deny` or `isError` it leaves at most one
  start (kind, time and id only; never the command or prompt): (a) a keyed start when its result names the task
  (`Bash` `backgroundTaskId`, which a ctrl-b move carries too; `Agent` `agentId` of an `async_launched` result;
  `CronCreate` `id`): an item with that id and kind is exact from that call whatever else is fresh, and an item first
  listed before its key arrived becomes exact at the next Stop that lists it; else (b) an unkeyed start, for the main
  loop's own `run_in_background: true` `Bash` or `Agent`, `CronCreate`, and `ScheduleWakeup` other than `stop: true`
  (that only cancels); else (c) a veto of its kind when the call may still own a task it cannot date: a subagent's
  background call, or an `Agent` without `run_in_background: false`, which runs in the background by default in 2.1.296.
  A subagent's task is in the main loop's Stop list (2.1.296 source: the registry is shared; not observed).
  The count rule, for a new item no key names: it is exact, dated by that call, only when it is the one such new item
  of its kind, exactly one unkeyed start of that kind exists, that start is not a veto, and the 64-start cap has evicted
  none since the last Stop (`dropped`). Otherwise it is dated by the Stop that first listed it and drawn `≥<wait>` (a
  lower bound). Residual: a task that no tool call made (started before the plugin loaded, a durable cron loaded at
  session start, or one the engine started itself) is taken for that call when its kind has exactly one unkeyed start open.
  A task the next Stop still lists keeps its date; one it no longer lists is gone. Labels come from the engine's type
  fields (`shell`, `agent <type>`, `monitor <server>:<tool>`, `workflow <name>`, `cron`, `wakeup`), cleaned of control
  and bidi characters and clipped to 48 cells on code point boundaries, `…` marking a cut; the command line and the cron
  prompt are never kept.
- **Notification.** A `UserMessage` row of a task notification hides its task at once (module memory of the session that drew it, ended by
  the next Stop, 64 ids at most): a render hook may not write `$.state` (the engine denies it), so the view subtracts the ids.
  Without it the task leaves with the next Stop, which the notification's own turn ends with.
- **Rows.** `BG shell 3m10s` oldest first, three at most and `+N more`, then `snapshot 3m00s ago`; `BG none` when the
  snapshot is empty; `BG n/a（原因）` when the record cannot be read, the session id cannot, nothing was seen yet, or
  the record belongs to another session. `inflightOf` is the one view: card and `/progress` read it.
- **Not known.** The permission wait; whether a workflow, monitor, `ScheduleWakeup` or `/loop` shows up as drawn
  here (never stimulated); whether a subagent's task is in the main loop's Stop list and whether the id a result
  names is the id the Stop lists (source only, never observed); a task that starts and ends inside one turn never
  appears (it is in no snapshot).

## Dependencies

The agents, edited, summary and compact data come from tracker hooks in the settings, the mcp data from a
refresher script. Deleted later as cc-statusline leftovers, they would leave a row reading `idle`, `0` or
the session id, so each refresh checks them and a missing one reads `n/a (<reason>)`, which counts toward
the errors like any n/a.

| Dependency | Present when | Feeds | When missing |
|---|---|---|---|
| `subagent-tracker.js` | wired on `SubagentStart` or `SubagentStop` | agents | `agents n/a (subagent-tracker.js hook not configured)`, in the ACTIVITY card |
| `file-tracker.js` | wired on `PostToolUse` | edited | `edited n/a (file-tracker.js hook not configured)`, in the same place |
| `summary-updater.js` | wired on `UserPromptSubmit` | summary | `n/a` only when `message-tracker.js` is missing too: `summary n/a (summary-updater.js and message-tracker.js hooks not configured)`, under the model in the header |
| `message-tracker.js` | wired on `UserPromptSubmit` or `Stop` | the summary fallback | as above |
| `compact-monitor.js` | wired on `PreCompact` | the compact count of CONTEXT | that segment only: `compact n/a (compact-monitor.js hook not configured)` under the figures, the gauge and the figures stay |
| `~/.claude/hooks/mcp-status-refresh.js` | the file exists | mcp | the mcp row of the SYSTEM card: `mcp n/a (mcp-status-refresh.js missing)` on rows of its own, the memory files stay and the refresher is not run |

- Wired means some `hooks.<Event>[].hooks[].command` contains the script's basename. Read each refresh with
  `$.settings.read()`: the merged settings and each source (`user`, `project`, `local`, `flag`, `policy`),
  a hook wired in any of them counts, because the merge takes `hooks` whole from the last source that has
  it and a project's own `hooks` would hide the user's trackers. Hooks a plugin brings are not settings
  and are not seen.
- The effort tracker is no dependency: the level comes from the hook inputs and `CLAUDE_EFFORT`, and before
  either the settings are asked for the configured level (the same read, the model row counts as a
  dependent row for it). A read that fails leaves the configured level out for that refresh.
- A row switched off in the rows file is not checked, and with no dependent row on (summary, agents, usage,
  edited, model) the settings are not read. Under the master switch nothing is read.
- A settings read that fails (any of its reads) keeps the verdicts of the refresh before, which the
  snapshot carries (`hooks`), as R22 does for the toggles; with none yet every hook counts as wired.
  The refresher check is a plain existence test and has no such memory.

## Side files (reader contract)

Producers hand data over as small JSON side files, specified in the hub repo's `contracts/side-file/SCHEMA.md`
(canonical there; this mod implements the reader and shares no code with the Python writer). `readSideFile(io, path,
nowMs)` and `readSideKind(io, kind, loc, name, nowMs)` judge a file by the eight steps of its section 4 and return
the data (`verdict: 'ok'`) or an n/a with the contract's text (`n/a（缺檔）`, `n/a（過期 4h）`, ...). They never throw: a
refused `exists` or read, a wrong type from the seam, an invalid clock or a hostile document is a classified n/a.

- Seam: `SideIo { exists, readBytes }`; `Io.readBytes` is `$.fs.stat` (a file over 64 KiB is refused unread) then
  `$.fs.read(path, { as: 'bytes' })` decoded by a pure base64 decoder that refuses a text longer than 64 KiB can
  encode. The `{ base64 }` shape is specified by the engine typings; it is not yet run on a live engine (the test
  kit's fake in `fixture.ts` is our own, so it proves self-consistency only). Reasons that do not come from the
  reader (a guard timeout, a failed dependency) are shown as `n/a（...）`, and bidi controls (U+061C, U+200E/F, U+202A-E, U+2066-9) are not drawn. The reader checks the 64 KiB limit on bytes, strict UTF-8, the raw literal of the top-level
  `schema_version` (`JSON.parse` cannot tell `1.0` from `1`), a real calendar for every stamp (no `Date.parse`:
  it rolls `2026-02-30` over), code points for `error.message`, and the 300 s clock-ahead tolerance, and for a kind with `intFields` (`fixture`: `count`) the raw literal of `data.<field>` (`3.0`, `3e0` are malformed; checked after staleness and failure, so an old file still reads stale).
- Verdicts beyond the contract's seven, decided before anything is opened: `bad_name` (file name outside the
  grammar), `unknown_kind` (not in the registry, section 9) and `no_clock`.
- Paths: `local` kinds under `$TMPDIR/claude-side/` (`/tmp` when unset or empty), `synced` under
  `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/-project/references/side-files/`. Only `local` is read by the pane
  today; there is no directory listing and no multi-host merge (section 7.1) yet.
- **FIXTURE card** (the proof of the path, kind `fixture`, `$TMPDIR/claude-side/fixture.json`, TTL 600 s): off
  unless the rows file has `"fixture": true`, the boolean only (`1`, `"yes"` leave it off; the only opt-in row: no producer exists on a normal machine). A band
  of its own, last, across the whole width at every tier. Title value and `count`, `age` (at the draw, so it keeps
  counting between refreshes) and `observed` (local clock); any other verdict is the reader's text, wrapped and read
  in full, with no data of the file. A failing fixture counts as one error like any row that is on.

## Files the mod writes (format contract)

Byte-compatible with `statusline.js`. After deployment `statusLine` is removed everywhere, so the
mod is the only writer; rollback removes the env var too. While both run, only context %, 5h %, 7d %
and cost agree: `tok` (the native steps cumulative in+out, the mod `context.tokens + Σ output`),
`dur` and `add`/`rm` (`base = total`) step different quantities and drift. Reviewed and accepted.

- `/tmp/claude-cum-<sid>.json`:
  `{"cost":{"total":n,"base":n},"dur":{...},"add":{...},"rm":{...},"tok":{...}}`.
  `step(key, cur)` (L165-170): `cur >= base` adds `cur - base` to `total` and sets `base`;
  otherwise only re-baselines. `add` / `rm` are totals the mod keeps itself (`base = total`).
  Read the existing file first: this session already has one written by `statusline.js`. A
  missing file is zero; one that is there but unreadable or corrupt is never overwritten, and
  cost, tokens and lines read `n/a` until it is removed.
  **The write is the commit point.** Every read that can fail (the file, the listing of `$TMPDIR`, the
  other sessions' files) comes before it; only a refresh that is still the current one writes. The
  pending lines are taken off the count just before the write, by the refresh that writes them, so
  no other refresh can persist them too: the count never goes below zero, and one found below zero
  is cleared. A write that fails, or a refresh found replaced once it holds the lines, gives them
  back. A collector that outlives its 5 s guard still completes this. A usage failure leaves the
  counters alone and does not blank lines.
- `~/.gemini/rate-limit-snapshots.json` when it exists, else `~/.claude/rate-limit-snapshots.json`
  (L200-201): `{ "<sid>": { "t": nowSec,
  "five_hour": { "used_percentage": n, "resets_at": epochSec } | null, "seven_day": ... } }`.
  CAS merge (L50-65, L211-219): read, set own entry, drop entries with `t` older than 300 s,
  write, re-read, retry (<=10) until own `t` is visible. Paths are absolute (resolve `~` with `HOME`).
- Both files are written through `<file>.<uuid8>.tmp` and `$.process.run(['mv', '-f', tmp, file])`,
  as `statusline.js` does with a rename, so a reader never sees half a file. If `mv` fails the data
  is written in place and the tmp removed, and the fallback counts as one error in the SYSTEM card.
- The pending line count, the output-token sum and the hook-seen effort live in `$.state` keyed by
  the session id they belong to (`{ sid, ... }`); a different id reads as zero, so a `/clear` needs
  no `session.end` hook, and a refresh that straddles it cannot take lines of the new session.
  Accepted (R20a): lines still pending when the session id changes, at most the edits since the last
  refresh (about 3 s after a turn), are dropped with the old id.

## Display

### Pane

- id `status-pane`, title `Status`. Opened unasked from `session.start` with `void
  $.ui.open(...)` (placed from 144 columns, 110 once the person has opened it by hand).
- `/status-pane` command (registered in `session.start`): opens the pane (asked: placed at any
  width) and answers `{ text }` saying whether it was placed and, if not, the reason.
- Drawn by `ui.render` on `{ component: 'Pane', requestId: 'status-pane' }`, sized to
  `e.props.bodyColumns` (observed: 89 docked at a 200-column terminal, 49 at 120, 96 inline at 100) and
  to `e.props.scroll.bodyRows`, the rows of the room (0 or absent: not known, the natural layout).
  Elements: `Box`, `Text`, and `Raster` on the terminal surface only (`e.surface === 'terminal'`; the
  other tables have no `Raster`, so there the same pane draws text gauges and a text sparkline).
- **Gauge cards.** The pane is `paneLayout(snap, view)`, plain data, turned into engine elements by
  `layoutTree(layout, els)`; no `$` call in either, so every path runs offline and the kit mounts the
  result on every surface. `view = { columns, rows?, nowMs, tzMin?, raster?, cpuHist? }`. `w = bodyColumns - 2`
  (the root's `paddingX: 1`; never below 20).
- **No field is dropped for want of width or height.** Every field the old pane had is on the pane at
  every breakpoint and in every room that can hold it: what does not fit beside its neighbour goes to a
  row under it, and a card takes as many rows as it needs. Only inside a card, and only as the last
  resort, a value is shortened: a path or a name too long for a row loses its head behind `…`, a summary
  of more than two rows ends in `…`, the edited files take three rows at most. **A number is never cut**:
  a value too wide for the row beside its label goes under the label, whole. A CJK character is 2 cells.
  A reason (`n/a (...)`) wraps over rows and is read in full; a word wider than the card is broken over
  rows, after a `/`, `-` or `_` when it has one, never cut.

| tier | w | cards |
|---|---|---|
| narrow | below 40 | header, PROGRESS, CONTEXT, 5H, 7D, COST, GIT, ACTIVITY, SYSTEM, one under another at full width |
| medium | 40 to 79 | header, PROGRESS and CONTEXT full width, 5H beside 7D, COST beside GIT (COST wider, see COST), then ACTIVITY and SYSTEM full width |
| wide | 80 and up | the header, PROGRESS across the whole width, then CONTEXT, 5H, 7D across, COST, GIT, ACTIVITY across, and SYSTEM across the whole width |

  Cards of a band share `w` with one cell between them (`columnGap: 1`), the left ones taking the odd
  cells: `splitWidths(87, 3)` is 29, 28, 28. A band with a card hidden gives its width to the others;
  a pair with one side hidden makes the other full width.

- **Always framed.** Every card has its round border at every width and every room, and the pane may be taller than
  its room: the engine scrolls it. There is no height-aware layout and nothing is clipped (the earlier dense tier
  and its `↓ more` marker are gone). In the narrow tier a blank row separates the cards, so they read one at a time.
  Because lower cards can be off the screen, the header carries what must not be missed: the error count (red) and
  `mcp ✗` (red, `△` yellow when a server needs auth) sit left of the liveness, on the model row when they fit and
  on a row of their own at the right edge when not.
- **Card element.** `Box { width, borderStyle: 'round', borderColor: 'gray', paddingX: 1,
  flexDirection: 'column' }`. Its first row is the title row `Box { width: inner, justifyContent: 'space-between' }`: the
  title **bold, in the accent colour (cyan)** at the left, the headline value in the colour of its
  threshold at the right (an Ink border cannot hold a title, so none is drawn into it).
- **Aligned table.** The rows under a title are a label/value grid. A **label** is dim and sits at the left
  edge; its **value** is bright and sits against the right edge (`Box { width: inner, justifyContent:
  'space-between' }` of the two), so the values of a card line up in one column. A value of several rows
  (the edited files, the mcp servers, the memory files, the agents) puts the label on the first row only
  and right-aligns every row. A pair that shares a row (CONTEXT's `used` and `compact`) is two label/value
  pairs, one at each edge. Where a pair or a matrix does not fit its row it is **stacked**: the label on a
  row and its value under it, right-aligned, or, for the COST matrix, one `label scope` row per figure. A
  `Text` that can overrun has `wrap: 'truncate-end'`. A word is never repeated for the same metric in
  another scope: scopes become column headers written once.
- **Colour discipline.** Cyan on the model name and on the titles (both bold). Semantic green / yellow /
  red only on gauges and their values, the effort (live), the liveness dot, the git state and `mcp` (and,
  as before, magenta on the branch and blue on `?u`). Labels, rules and everything secondary are dim,
  borders gray. No emoji; narrow glyphs only (`● ✓ ✗ ≈ −`, blocks).
- **Unknown is not zero.** A reading that is not there is a dim `—` and a bare track, never `0%`: the
  CONTEXT percentage before the first response (no percent from the engine, or no tokens yet), a rate-limit
  window nobody has a live reading of (the shared file has no live entry; a window whose reset has passed
  keeps a wrapped countdown but no percentage), a COST or TOKENS figure that failed, the CPU before it has a
  baseline. The PromptHint tail leaves such segments out. The two-column table keeps its row when a figure is
  unknown (`$` with two dashes) and says why under it.
- **Gauges** (CONTEXT, 5H, 7D). A bar filled to one eighth of a cell: `round(pct /
  100 * columns * 8)` eighths, at least 1 for a reading above 0, the leading partial cell one of `▏▎▍▌▋▊▉`.
  Tone: green below 50, yellow below 80, red from 80 (`cc()`, L128), the same for the value in the title.
  No reading: all track. On the terminal the bar is a `Raster { key: 'gauge-context' | 'gauge-5h' |
  'gauge-7d', columns, rows: 1, cells }` whose `cells` are standard padded base64 of little-endian u32
  triplets `[codePoint, 0xRRGGBB foreground, 0xRRGGBB background]`: a full cell `[█, tone, track]`, the
  partial one `[▉..▏, tone, track]`, a track cell `[█, track, track]` (green `#3fb950`, yellow `#d29922`, red
  `#f85149`, track `#30363d`). Elsewhere the bar is two `Text`s: the fill glyphs in the tone, the `░` track dim.
- **CPU history.** `cpuHist` in `$.state` (declared in `state.d.ts`) is the last 16 CPU readings in
  percent, oldest first. Each refresh appends the one it made, before it writes the snapshot; the first
  reading (no baseline) and a read that failed append nothing; a history that cannot be written or read
  costs the chart and nothing else. The SYSTEM card's `cpu` row is the chart: on the terminal a `Raster
  { key: 'cpu-chart', columns: 16, rows: 2 }` (a column per reading, the newest at the right, empty
  columns before when there are fewer than 16, fewer columns in a card too narrow for 16) between the
  label at the left and the value at the right, the label and the value on the lower of its two rows;
  elsewhere a text sparkline of one glyph per reading before the value. The axis is
  fixed at 0..100% (a flat load reads flat): the height of a reading is `round(pct / 100 * 16)` sixteenths,
  at least 1 above 0, the bottom row filling first; each column has the tone of its own reading. The
  `Raster` cells are `[LOWER, tone, track]`, an empty one `[█, track, track]`. No `$.ui.blit`: the chart
  changes once per refresh, and a redraw of this size is cheap.
- **Header** (no title row). Row 1: the model bold cyan, ` · `, the effort, ` · v<version>`, and the
  liveness at the right edge: a green `●` with the local `HH:MM`, past 90 s a yellow `● stale <n>s`, past
  300 s red. **The effort** is the level a hook reported, in its colour; before the first hook has run (a
  session that has had no prompt) it is the level the settings name, **dim** (the top-level `effortLevel`,
  else the `modelSettings` entry that has one whose key is the longest prefix of the model id); with
  neither it is left out together with its separator: `Opus 5.5 · v2.1.295`, never a `?`. A live `low` is
  dim as well, by the palette of `statusline.js`. **The liveness never takes a row for itself while a line
  has room**: it ends the last model row; when that row cannot hold it, the last summary row (`summary ·
  length`); only when neither can does it take a row of its own at the right edge. A model row too long for
  the card goes over two rows (the name, then the effort and the version). Then the summary, dim, and the session length
  (`1hr 20min`): `summary · length` on one row when it fits, else the summary over at most two rows with
  the length ending the last one, or on a row of its own. In wide, when the model, `summary · length` and
  the liveness fit one row they share it. A model or summary that failed says why in full (`model n/a
  (...)`, `summary n/a (...)`).
- **CONTEXT.** Value `N%` in the title (a dim `—` when unknown); the gauge (bare track when unknown); then
  one row of two pairs, `used 32.0K / 1.0M` at the left and `compact 2` at the right (a single space inside
  each pair; 29 cells inside hold it, and 31 hold `used 127.8K / 1.0M` with `compact 12`), over two
  label/value rows when they do not fit one. The figures are `— / 1.0M` before the first
  response, `32.0K / —` when the window is not known; the compact count is always told, `compact 0`
  included; a count that cannot be had is `compact n/a (reason)`, dim, under the figures, and the gauge and
  the figures stay. The tokens are not in this card.
- **5H and 7D.** Value `N%` (`—` when unknown); the gauge; then `resets`, dim, at the left and, against the right
  edge, the countdown, a dim ` · `, and the **clock the window resets at**, all bright: `2h10m · 04:51`. The
  countdown is `2h10m` below wide and `2h 10m` in wide. The clock is the drawn countdown run forward from the
  snapshot (`snap.at + resetSec`, so a window whose `resets_at` has passed and was wrapped by its period gets the
  wrapped time, and the two numbers cannot disagree), in the zone of the liveness `● HH:MM`: `HH:MM` when that is
  the day of the snapshot, `Fri 02:59` (English weekday) on another day; the 7-day window always names the weekday
  (`3d4h · Mon 06:41`). When `countdown · clock` does not fit beside the label with the 2-cell gap, the countdown
  stays on the `resets` row and the clock goes under it, against the right edge (so medium cards and most wide
  7D cards use two rows). No reset time (unknown): no `resets` row and no clock. The tail has no clock.
- **COST (or TOKENS).** One card holds a `$` row and a `tokens` row, the scopes as column headers:

  ```
  COST       session   total
  ──────────────────────────
  $             0.00  249.44
  tokens          0≈   2.0M≈
  ```

  The title row carries the headers (`session` bold, `total` dim), a dim hairline `─` runs under it, and
  each row has its dim label at the left and its two figures right-aligned in columns as wide as their
  longest figure; the `session` column is bold. The `$` row is the `cost` toggle's and the `tokens` row the
  `usage` toggle's, with their error counts; with only one on the title follows it, **COST** or
  **TOKENS**; with neither there is no card. The matrix needs `max(label, title) + 2 + session + 2 +
  total` cells inside (22 for the usual figures). The chain when the card has fewer: the full words
  (`session`, `total`, `tokens`), then `sess` and `tok` (20 cells inside for the usual figures),
  and only then stacked rows, a row per figure: `$ session`, `tok session`, `$ total`, `tok total` (a card
  with one row only: `session`, `total`). A figure is never cut, whichever step. **In a band of COST and
  GIT (medium) COST takes the cells its matrix needs from GIT**, the full words first and `sess` / `tok`
  second, as long as GIT keeps 16 cells inside (26 and 20 at w=47, 24 and 21 at w=46 with the short
  words); GIT stacks the value of `lines` or `state` under its label when it does not fit, whole. A figure
  that failed is a dim `—` in its cell, and
  `cost n/a (reason)` / `tokens n/a (reason)` follow under the rows, wrapped. The session length is in the
  header.
- **GIT.** `branch` (magenta), `dir` (a long path loses its head, `…iag/S8P`; kept to the room beside the
  label), `lines` (`+120 −45 ≈`: green, red, dim) and `state` (`✓ clean` green, or `✗` red followed by `+a`
  green, `~m` yellow, `?u` blue), one label/value row each; no branch row outside a repository, and no
  state row there. A part that failed (`git n/a (...)`, `lines n/a (...)`) says why in full where it
  would be; a reason of several rows keeps them, and what follows goes under them.
- **ACTIVITY.** A card at every breakpoint. `agents`: a row per group, right-aligned (running `○` yellow,
  finished `✓×n` green), the label on the first, the age of a finished group (`5m ago`) beside it when it
  fits and on a row under it when it does not; `idle`; `n/a (...)`. `edited`: the files joined by `→` over
  as many rows as they need (a break keeps the arrow at the end of the row), three rows at most, each
  right-aligned, the label on the first; a name over 25 cells keeps its last 24 behind `…`; `idle`; `n/a (...)`.
- **SYSTEM.** A card at every breakpoint, one label/value row each: `cpu` (the chart row, above; a dim `—`
  before there is a share, a plain `12%` with no history), `ram` (`45%  7.0/15.6G`, the figure stacked under
  the label in a card too narrow for both), `mcp` (`2 ✓` green, or `1/3` and every server that is down, `✗`
  red or `△` yellow when it needs auth, over rows when they do not fit one), `memory` (`global · project ·
  3 rules`, over rows at the separators when too long). A failed collector takes rows of its own and says
  why in full. The errors, `N error(s)` in red (failed rows that are on, and writes that fell back to a
  plain write), are the last row at the right edge. With the card off (`sys` and `memory_mcp` both) the
  errors stand alone in a row under the cards.
- **Toggles.** `summary` hides the summary in the header, `model` its model part, `cost` the `$` row of
  COST and the session length, `usage` CONTEXT and the `tokens` row, `quota` 5H and 7D, `dir` and
  `repo` GIT (both off), `agents` and `edited` their part of ACTIVITY (both off: no card), `sys` the CPU
  and RAM rows, `memory_mcp` the mcp and memory rows (both off: no SYSTEM card). A band that loses a card
  shares its width among the others.
- **One card instead of the cards.** Before the first refresh: `waiting for the first refresh`. Master
  switch off: `disabled by ~/.claude/cc-statusline-rows.json`. A snapshot this version cannot draw, or a
  refused clock or state read: one `Text` `status-pane n/a (cannot draw: ...)`. The history alone being
  unreadable is not one of these.
- A collector that throws or times out turns its card (or the part of it) into `n/a (<short reason>)`
  in its frame; the other cards draw normally. Failed rows that are on count in the errors.
- The liveness repaints without a refresh: after each snapshot write a `$.clock.after` at 90 s and
  one at 300 s (each plus 1 s) call `$.ui.invalidate('ui.render')`, and the next write cancels
  them. A refresh that cannot write its snapshot writes `checkedAt` to `$.state`, which both render
  hooks read, so the header is drawn again anyway. Timers die with the hooks worker; a worker that
  is lost shows no mark until the next event, and the `turn.complete` re-arm covers that.

Rendered as a terminal lays it out (the tree read back by `tree.ts`; the chart is the 16 readings
`2 5 9 14 22 35 50 70 100 60 30 12 6 4 8 12`; the clock is pinned to UTC, the snapshot is Fri 02:41). bodyColumns 38
(narrow, w=36, the user's 40-column dock):

```
╭──────────────────────────────────╮
│ Opus 5.5 · max · v2.1.294        │
│                   mcp ✗  ● 02:41 │
│ 遷移 statusline 到 mod pane      │
│ 的討論與實作 · 1hr 20min         │
╰──────────────────────────────────╯

╭──────────────────────────────────╮
│ CONTEXT                       3% │
│ █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ used 32.0K / 1.0M      compact 0 │
╰──────────────────────────────────╯

╭──────────────────────────────────╮
│ 5H                           23% │
│ ███████▍░░░░░░░░░░░░░░░░░░░░░░░░ │
│ resets             2h10m · 04:51 │
╰──────────────────────────────────╯

╭──────────────────────────────────╮
│ 7D                           61% │
│ ███████████████████▌░░░░░░░░░░░░ │
│ resets          3d4h · Mon 06:41 │
╰──────────────────────────────────╯

╭──────────────────────────────────╮
│ COST              session  total │
│ ──────────────────────────────── │
│ $                    3.20  12.34 │
│ tokens            230.0K≈  1.2M≈ │
╰──────────────────────────────────╯

╭──────────────────────────────────╮
│ GIT                              │
│ branch                      main │
│ dir                    ~/project │
│ lines                 +120 −45 ≈ │
│ state                 ✗ +1 ~3 ?2 │
╰──────────────────────────────────╯

╭──────────────────────────────────╮
│ ACTIVITY                         │
│ agents                           │
│ general-purp                   ○ │
│ Explore                   ✓×3 5m │
│ edited                           │
│                    settings.json │
│                          SPEC.md │
│                     register.tsx │
╰──────────────────────────────────╯

╭──────────────────────────────────╮
│ SYSTEM                           │
│             ░░░░░░░▃█▂░░░░░░     │
│ cpu         ▁▁▁▂▄▆████▅▂▁▁▁▂ 12% │
│ ram               45%  7.0/15.6G │
│ mcp                5/6  notion ✗ │
│ memory        global · project · │
│                          3 rules │
╰──────────────────────────────────╯
```

bodyColumns 49 (medium, w=47):

```
╭─────────────────────────────────────────────╮
│ Opus 5.5 · max · v2.1.294    mcp ✗  ● 02:41 │
│ 遷移 statusline 到 mod pane 的討論與實作    │
│ 1hr 20min                                   │
╰─────────────────────────────────────────────╯
╭─────────────────────────────────────────────╮
│ CONTEXT                                  3% │
│ █▎░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ used 32.0K / 1.0M                 compact 0 │
╰─────────────────────────────────────────────╯
╭─────────────────────╮ ╭─────────────────────╮
│ 5H              23% │ │ 7D              61% │
│ ████▍░░░░░░░░░░░░░░ │ │ ███████████▋░░░░░░░ │
│ resets        2h10m │ │ resets         3d4h │
│               04:51 │ │           Mon 06:41 │
╰─────────────────────╯ ╰─────────────────────╯
╭──────────────────────╮ ╭────────────────────╮
│ COST     sess  total │ │ GIT                │
│ ──────────────────── │ │ branch        main │
│ $        3.20  12.34 │ │ dir      ~/project │
│ tok   230.0K≈  1.2M≈ │ │ lines   +120 −45 ≈ │
│                      │ │ state   ✗ +1 ~3 ?2 │
╰──────────────────────╯ ╰────────────────────╯
╭─────────────────────────────────────────────╮
│ ACTIVITY                                    │
│ agents                       general-purp ○ │
│                          Explore ✓×3 5m ago │
│ edited             register.tsx → SPEC.md → │
│                               settings.json │
╰─────────────────────────────────────────────╯
╭─────────────────────────────────────────────╮
│ SYSTEM                                      │
│                        ░░░░░░░▃█▂░░░░░░     │
│ cpu                    ▁▁▁▂▄▆████▅▂▁▁▁▂ 12% │
│ ram                          45%  7.0/15.6G │
│ mcp                           5/6  notion ✗ │
│ memory           global · project · 3 rules │
╰─────────────────────────────────────────────╯
```

bodyColumns 89 (wide, w=87):

```
╭─────────────────────────────────────────────────────────────────────────────────────╮
│ Opus 5.5 · max · v2.1.294                                            mcp ✗  ● 02:41 │
│ 遷移 statusline 到 mod pane 的討論與實作 · 1hr 20min                                │
╰─────────────────────────────────────────────────────────────────────────────────────╯
╭───────────────────────────╮ ╭──────────────────────────╮ ╭──────────────────────────╮
│ CONTEXT                3% │ │ 5H                   23% │ │ 7D                   61% │
│ ▊░░░░░░░░░░░░░░░░░░░░░░░░ │ │ █████▌░░░░░░░░░░░░░░░░░░ │ │ ██████████████▋░░░░░░░░░ │
│ used         32.0K / 1.0M │ │ resets    2h 10m · 04:51 │ │ resets             3d 4h │
│ compact                 0 │ │                          │ │                Mon 06:41 │
╰───────────────────────────╯ ╰──────────────────────────╯ ╰──────────────────────────╯
╭───────────────────────────╮ ╭──────────────────────────╮ ╭──────────────────────────╮
│ COST       session  total │ │ GIT                      │ │ ACTIVITY                 │
│ ───────────────────────── │ │ branch              main │ │ agents    general-purp ○ │
│ $             3.20  12.34 │ │ dir            ~/project │ │              Explore ✓×3 │
│ tokens     230.0K≈  1.2M≈ │ │ lines         +120 −45 ≈ │ │                   5m ago │
│                           │ │ state         ✗ +1 ~3 ?2 │ │ edited    register.tsx → │
│                           │ │                          │ │                SPEC.md → │
│                           │ │                          │ │            settings.json │
╰───────────────────────────╯ ╰──────────────────────────╯ ╰──────────────────────────╯
╭─────────────────────────────────────────────────────────────────────────────────────╮
│ SYSTEM                                                                              │
│                                                                ░░░░░░░▃█▂░░░░░░     │
│ cpu                                                            ▁▁▁▂▄▆████▅▂▁▁▁▂ 12% │
│ ram                                                                  45%  7.0/15.6G │
│ mcp                                                                   5/6  notion ✗ │
│ memory                                                   global · project · 3 rules │
╰─────────────────────────────────────────────────────────────────────────────────────╯
```

The tree at each breakpoint (terminal; the text gauge replaces each `Raster` elsewhere):

```
Box column paddingX=1
  narrow   Card header · CONTEXT · 5H · 7D · COST · GIT · ACTIVITY · SYSTEM, one under another
  medium   Card header · CONTEXT · Box row gap=1 [5H, 7D] · Box row gap=1 [COST, GIT] · ACTIVITY · SYSTEM
  wide     Card header · Box row gap=1 [CONTEXT, 5H, 7D] · Box row gap=1 [COST, GIT, ACTIVITY] · SYSTEM
  (then, only when SYSTEM is off or the pane is clipped, and there are errors)  Box column [ Box paddingX=1 [Text "N errors"] ]
Card     Box width round gray paddingX=1 column               (Section: Box width column, no border)
           title row  Box width=inner space-between [Text bold cyan TITLE, Text value (tone)]
                      COST: Box [Text bold cyan TITLE, Text spaces, Text bold "session", Text "  ", Text dim "total"]
           gauge row  Raster key=gauge-… columns=inner rows=1      (terminal)   |   Box [Text fill (tone), Text track (dim)]
           label/value  Box width=inner space-between [Text label (dim), Text value]   (value Texts in one Box when several)
           COST rows  Text dim "─"×inner · Box [Text dim label, Text bold session, Text "  ", Text total]
           cpu row    Box width=inner space-between alignItems=flex-end [Text dim "cpu", Box gap=1 [Raster key=cpu-chart columns=16 rows=2, Text value]]
```

### PromptHint tail

- `ctx 3% · 5h 23% · 7d 61% · $3.20 · 02:41` (session cost; `HH:MM` of the last refresh,
  replaced by `stale` past 90 s). Segments without data are left out (an unknown context or window is
  without data, not `0%`), and so are the segments of a row the rows file switches off. At most 48
  characters: whole segments leave from the end.
- Hook `ui.render` on `{ component: 'PromptHint' }`. `tail` is a prop (`RenderPropsOf.PromptHint:
  { isDraft, isWorking, hint, tail?: string }`), not a field of `e`, so return
  `next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${ours}` : ours } })`.
  Never rewrite `hint`. No snapshot yet, or the rows file disables it -> `next(e)` unchanged.

## Refresh and liveness

- `session.start` stays light (it is awaited before the first prompt): register the command,
  `void $.ui.open(...)`, arm `$.clock.every(30_000, tick)`, kick `void tick()`. Return `next(e)`.
- Event-driven ticks, at most one per 5 s: `turn.complete`, and after an `Edit`/`Write`
  `tool.call` settles. Every `turn.complete` also schedules one follow-up tick 3 s later that
  ignores the 5 s gap (a newer `turn.complete` replaces it): the usage ledger lags the event, and
  live the context and cost stayed stale until the next 30 s tick.
- Timers die if the hooks worker is replaced: on `turn.complete`, when the last refresh is
  older than 90 s, arm the timer again.
- One refresh at a time. Each holds a number; only the holder may write, clear `running`, or
  commit a cum write. A watchdog frees a refresh stuck for 60 s; the next refresh takes a new
  number, which retires the old one: when that finishes late it neither clears the newer
  refresh's pointer nor writes over it. A finished refresh cancels its watchdog.
- Nothing may throw out of a timer or hook: every collector is wrapped (5 s, git calls on their
  own budgets); the render hooks never write state, and `paneLayout` / `tailText` never throw
  (a snapshot of an older shape draws one `status-pane n/a (cannot draw: ...)` line). The Pane
  hook also catches a refused `resolve`, state read or `now` and draws that same line, since a
  throw would leave the engine's own empty pane (the CPU history is the one read it can do
  without: no chart, nothing else lost); the PromptHint hook catches the same and returns
  `next(e)` unchanged, so an upstream tail survives.
- Values drawn from live in `$.state` (contract `hooks/state.d.ts`), written with `update()` from
  ticks and events, read with `read()` while drawing. Counters belong to a session id (above).

## Path matrix (TDD: write each test, see it fail for the right reason, then implement)

| # | Path | Expectation |
|---|---|---|
| 1 | sid from a dashed uuid | 24 alphanumerics, matches the tracker naming |
| 2 | `step` increase / drop | increase adds the delta; a drop re-baselines, total unchanged |
| 3 | `aggMax` / `aggMaxOrNull` | entries >300 s old dropped; resets >8 d ahead dropped; latest `resets_at` group's max wins; no live entry -> own fresh value; all rolled over -> 0 for `aggMax` (the parity function) and null (unknown) for `aggMaxOrNull`, which the pane uses |
| 4 | countdown after the reset passed | wraps by the period (L282-287) |
| 5 | patch line count | `+`/`-` counted; `Write` create with empty patch -> content lines; error result -> 0 |
| 6 | CPU delta | two `/proc/stat` samples -> percent; first sample -> no share, drawn as a dim `—` |
| 7 | meminfo | used / total / percent from `MemTotal` and `MemAvailable` |
| 8 | row toggles | `enabled:false`; a single key off removes only that card (or part of one) |
| 9 | tail | keeps an upstream `tail`; drops missing segments; <=48 chars; `stale` past 90 s |
| 10 | pane render through the kit, every surface, bodyColumns 36, 49 and 89 | the tree validates; the cards of the breakpoint are there, each with its title and value; a long edited list is cut to its card |
| 11 | `/status-pane` | calls `$.ui.open` with id `status-pane`; text reports placement |
| 12 | liveness | a green `● HH:MM` while fresh; 120 s old -> yellow `● stale 120s`; 400 s -> red |
| 13 | a collector rejects | its card (or part of it) reads `n/a (...)` in its frame, the rest intact |
| 14 | effort | read from a classic hook input's `effort.level`; falls back to `CLAUDE_EFFORT`, then to the effort the settings name (dim); with neither, the effort and its separator are left out, never a `?`; never `effort-current.txt`; a subagent's input and another session's level are not the session's |
| 15 | model label | `claude-opus-5-5[1m]` -> `Opus 5.5 [1m]`; an unparsed name verbatim |
| 16 | follow-up tick | a `turn.complete` inside the 5 s gap is still refreshed 3 s later, once |
| 17 | stale repaint | an open pane turns yellow at 90 s and red at 300 s with no refresh running; a failed snapshot write still redraws it |
| 18 | cum commit point | a failing listing writes nothing and keeps the pending lines; a late collector still persists what it took; a corrupt or unreadable cum file is never overwritten |
| 19 | session-keyed counters | a new session id starts tokens, lines and effort over; a straddling refresh flushes into its own session only |
| 20 | atomic writes | tmp + `mv` for the cum and snapshot files; a failed `mv` falls back and counts as an error |
| 21 | git | a failed `status` / `rev-parse` reads `git n/a`; no repository, a missing origin and a status timeout do not drop the branch; a repository with no commits draws the `symbolic-ref` branch (none if that fails) with no n/a and no error |
| 22 | `~/.gemini` first, toggles kept | the rows and snapshot files resolve like `statusline.js`; an unreadable rows file keeps the toggles |
| 23 | lines taken once | a refresh reading the pending count before an older one has taken it persists nothing twice; the count never goes below zero (one found below zero is cleared); a write that fails, or a refresh replaced once it holds the lines, gives them back |
| 24 | git budgets | a slow status with a missing origin, or with no commits yet, still draws the branch; two chained calls at full budget fit the row guard |
| 25 | a draw never throws | a refused clock or state read during the draw: the pane is one `n/a (cannot draw: ...)` line, the tail is `next(e)` unchanged |
| 26 | master switch | `enabled:false`: no `$.process.run`, no `$.fs.write`, no `usage()`; lines counted meanwhile are persisted when it is switched on |
| 27 | dependencies | a tracker hook the settings do not wire, or a refresher that is gone, reads `n/a (...)` in its own card, part or row and counts as one error, nothing else changes; the summary only when both its trackers are missing; a failed settings read keeps the previous verdicts; a row that is off is not checked |
| 28 | breakpoints | `w = bodyColumns - 2`: stacked below 40, a pair from 40, three across from 80; edges 39/40 and 79/80; the cards share `w` with a cell between, the left ones taking the odd cells; ACTIVITY and SYSTEM are cards at every breakpoint, SYSTEM across the whole width in wide |
| 29 | gauges | eighths of a cell, at least one above 0, the partial glyph; green below 50, yellow below 80, red from 80; the Raster `cells` decoded at 0, 49, 50, 79, 80 and 100% (fill length, colour, partial glyph, track); a text bar on every surface with no Raster |
| 30 | CPU history | one sample per refresh; the first reading and a read that failed add none; the ring keeps 16; a 16 by 2 Raster on the terminal, a sparkline elsewhere; a fixed 0..100% axis, all-equal samples flat, fewer than 16 at the right; a history that cannot be read or written costs only the chart |
| 31 | toggles to cards | each key hides its card or part; a pair with one side hidden is full width; three across become two or one; with everything off the header is what is left |
| 32 | n/a cards | every card in its n/a state keeps its frame and says why in full, at every breakpoint; a reason of several rows keeps its rows; a word wider than the card is broken, not cut |
| 33 | fit | no `Text` past its box at any `w` from 20 to 120, on the terminal and on desktop, with a healthy snapshot and with long text, CJK and failures; a CJK character counts 2 cells |
| 34 | header | the model bold cyan, the effort (live in its colour, configured dim, unknown left out with its separator), the version at every width; the liveness beside the model or under it; the summary whole over at most two rows with the session length after it; wide: one row when the middle fits; a failed model or summary stacked under the model |
| 35 | SYSTEM | `cpu` with its chart, `ram`, `mcp` with every server that is down and `memory`, one label/value row each, over rows when too long for one; the errors last at the right edge, alone under the cards when the card is off; a failed collector takes rows of its own |
| 36 | one card | before the first refresh `waiting for the first refresh`; master switch off the disabled text; a refused read the `cannot draw` line |
| 37 | completeness | for a full snapshot at w = 34, 47 and 87 every field is in the card that holds it: summary, dir, branch, lines, git state, model, effort, version, session and total cost, duration, tokens of every session and of this one, context %, used and window (a dash before the first response), `compact N` (0 included), 5h and 7d with their resets, CPU with a chart on the terminal, RAM with used and total, mcp with the servers that are down, the memory files, agents, edited, the liveness; through the kit on every surface |
| 38 | always framed | no width from 20 to 122 and no room from 5 to 60 rows draws a borderless section or a `↓ more`; the narrow tier has one blank row between cards, the others none; the header carries the errors and a server that is down, beside the liveness or on a row of its own, at every width |
| 39 | unknown is not zero | no context percent, or no tokens yet: title `—`, bare track (the Raster all track), `used  — / 1.0M`; the same for a window with no live reading and for a failed COST or TOKENS figure (a dim `—` in its cell, the reason under the rows); the tail leaves them out; a reading of 0 is still `0%` |
| 40 | aligned table | every title bold cyan; labels dim at the left, values against the right edge of the card (GIT, ACTIVITY, SYSTEM rows end at the card's edge at every breakpoint); a value too wide for its row goes under its label, whole; the pair `used` / `compact` shares a row from 29 cells inside (`used 127.8K / 1.0M` with `compact 12` from 31, so at w=36) |
| 41 | COST matrix | headers `session` (bold) and `total` on the title row with a dim hairline under it; the matrix from 22 cells inside for the usual figures, then `sess` / `tok` from 20, then stacked rows (`$ session`, `tok session`, `$ total`, `tok total`; one row only: `session`, `total`); a long figure (`1234.56`, `12.3M≈`) widens its column and walks the chain full, short, stacked as the card narrows, no number cut; in a COST/GIT band COST takes what its matrix needs from GIT down to 16 cells inside for GIT (w=47: 26 and 20; medium shows the matrix); the `$` row follows `cost`, the `tokens` row `usage`; the title is COST, or TOKENS with `cost` off; neither on: no card |
| 42 | configured effort | no hook yet: the top-level `effortLevel` (dim), else the `modelSettings` key that is the longest prefix of the model id, else nothing; a hook's level beats it and takes its colour; a level found only in one source (the merge hides `modelSettings`) is found; a settings read that fails leaves it out; the model row alone makes the settings be read |
| 43 | reset clock | 5H and 7D show the countdown and the clock it runs out at (`2h10m · 04:51`), the weekday on another date and always for 7D; the clock is `snap.at + resetSec` in the liveness's zone, wrapped countdowns included; midnight is the day boundary; the clock goes under the countdown, right-aligned, when the two do not fit beside the label with 2 cells; unknown has no clock |
| 44 | side file reader, the hub fixtures | `sidefile.test.ts`: the thirteen cases and six boundaries of `MANIFEST.json` (embedded, hub commit 6098494) give their verdict; each negative fails for its own named reason, not another; a hidden `count` never appears in a non-ok result |
| 45 | fixture drift | an embedded copy that no longer matches its manifest entry fails: byte length at the hub commit, `truncated` is the first 320 bytes of `valid`, each `hidden_count` is the `count` its copy holds, the C1 escape is still the visible six characters |
| 46 | section 2 rules | every key required; label, kind, stamp, code, status shapes; consistency 1-3; `error.message` 1 to 200 code points and the control set (U+0000-001F, 007F-009F, 2028, 2029) with its neighbours accepted; unknown keys ignored; the first violation is the one named |
| 47 | `schema_version` literal | `1.0`, `1e0`, `-0`, `0`, strings and bools are malformed, `2` is unsupported before any v1 rule; a decoy inside `data`, a duplicate key and an escaped key name are read as `JSON.parse` has them |
| 48 | time | calendar, not `Date.parse` (leap and century years, month lengths, hour 24, year 0000 and 0001/9999); age equal to the TTL is fresh, a millisecond more is stale; 300 s ahead is age 0, 301 s is malformed; `data.final` only as boolean `true` and only for a kind with a final TTL; step 6 before step 7 |
| 49 | reader never throws | refused or throwing `exists`/read, a non-bytes answer, a path or clock that is not valid, empty/blank/BOM, trailing content, NaN, a non-object, 60k-deep nesting, 64 KiB exactly vs one byte more (bytes, not characters), every kind of broken UTF-8, `__proto__` keys; a name outside the grammar or an unregistered kind is not opened |
| 50 | locations and names | the grammar both ways, `local` and `synced` paths with the TMPDIR / CLAUDE_CONFIG_DIR fallbacks, a name part that would not parse back gives null, the host of a synced name equals `producer.host` |
| 51 | FIXTURE card at the three layouts | bodyColumns 36 / 49 / 89 (1, 2, 3 across): a card across the whole width, `count`, `age`, `observed`, on every surface; every manifest case is the contract text with no count, age or clock rows and no overflow; a long reason is read to its end; the age follows the draw clock; off by default and switched off by the rows file: no card and the file is never read; a refused read is corrupt and the rest draws; TMPDIR honoured; one error when it fails, none when healthy; the master switch collects nothing |
| 52 | tool bookkeeping | `runOf`: a main-loop call becomes a run, a subagent's (`agentId`), a nameless one and a missing id are handled (two id-less calls of one tool in one millisecond do not collide), a name is cut at 80; `addRun` / `dropRun`: parallel calls side by side, an end seen twice or never changes nothing, another session id starts over and an end under it leaves the record alone, at most 16 kept |
| 53 | elapsed text | `0s`, `59s`, `1m00s`, `59m59s`, `1h00m`; negative and NaN read `0s` |
| 54 | the progress view | oldest first, elapsed at the draw clock, a clock behind the start reads 0s; more than three: three and a count; nothing running is `idle`, not n/a; each missing source (record, session id, never recorded, **another session's record**) is n/a with its own reason; mutation: removing the other-session check turns `progress: the view > records of another session are n/a, never shown as running` red (the view returns `running` for the other session's call) |
| 55 | PROGRESS card at the three layouts | bodyColumns 36 / 49 / 89: a band of its own after the header across the whole width; `NOW`, tool and elapsed; idle; every n/a keeps its frame and is read in full; four or five calls: three rows and `+N more`; a long name loses its head, the elapsed time stays; nothing overflows; no card without `view.progress` or with the `progress` row off |
| 56 | `/progress` is the card's view | the text's rows equal the card's rows at the three widths (running, parallel, idle); where the card is not drawn the text says why |
| 57 | through the engine | `/progress` registered with `immediate: true` (the other command without); a fresh session reads idle on every surface; a held `tool.call` shows with its elapsed time at 36 / 49 / 89 and goes when it ends; the same view answers `/progress` mid-call with no `usage()` call; overlapping calls end in either order; a denied call and a throwing `next(e)` still end; `turn.complete` clears an unseen end; a subagent's `tool.call` is not a run and a subagent's `turn.complete` leaves the main loop's run alone; mutations: `noteEnd` outside the `finally`, the `agentId` guard on `turn.complete` and the `agentId` filter in `runOf` each turn a named test red; the 2 s repaint runs while a call is in flight and stops with it; before the first refresh `/progress` says `等待第一次更新` |
| 58 | #26 follow-ups | `data.count` as `3.0` / `3e0` / `30e-1` is malformed with its own text and never shown (a string or other non-number count is now malformed at the reader, text `不是 JSON 整數字面量`, instead of the card's `不是整數`; SCHEMA §9), plain integers still read, an old file with a bad count is stale, a decoy `count` elsewhere does not stand in; an opt-in row turns on only for boolean true (`1`, `"yes"`, `"true"`, `[1]` leave it off) while a default-on row keeps the loose reading; U+061C in a reason is not drawn |
| 59 | background bookkeeping | `startOf`: Bash / Agent with `run_in_background === true`, `CronCreate`, `ScheduleWakeup` are starts, a string `"true"` and other tools are not, and `ScheduleWakeup` with `stop: true` is not (another `stop` value still is); `taskIdOf`: `Bash` `backgroundTaskId`, `Agent` `agentId` only of a `status: 'async_launched'` result, `CronCreate` `id`, each tool reads its own key, an empty or non-string id and any result shape (`null`, a string, no `result`) name nothing and never throw; `mayStartBg` knows the four tools by own name (`constructor` and `toString` are not tools); `bgStartOf`, one test per row: keyed for the main loop, a subagent and a shell moved to the background by hand (no flag), unkeyed for the main loop's own flagged call, a veto for a subagent's background call and for an `Agent` without `run_in_background: false`, nothing for a foreground subagent `Bash`, `Agent` `false`, `ScheduleWakeup` with `stop: true` and other tools; `addStart` caps at 64 (64 kept and unmarked, the 65th evicts the oldest and sets `dropped`, which stays until the Stop) and starts over, unmarked, for another session; `noteStop`: a task named by a keyed start of its own kind is exact with that start whatever else is fresh or unkeyed (a key of another kind, or of a task the Stop does not list, dates nothing; a keyed task is no rival of the others), the count rule is exact only for one unkeyed start, no veto of the kind, no `dropped` and one rival of the kind (a veto alone or beside the start, or `dropped`, makes it first-seen, not exact; a veto of another kind does not; new tasks of other kinds take nothing away), a key that arrives after the Stop that listed the task dates it at the next Stop but never moves an exact task or one of another kind, monitor / workflow / unknown types are never dated by a shell start, open or keyed, an unkeyed start dates its own kind only, no start or several is first-seen (not exact); a seen task keeps its date; the Stop clears `starts` and `dropped`; kinds are labelled from type fields only (no command, no prompt kept); labels are cleaned and clipped to 48 cells on code point boundaries (a CJK name, an emoji on the cut and one cell before it, 48 fit and 49 are cut, a space at the cut goes with it); an absent field keeps that class, neither field is no snapshot; `endTask` by id |
| 60 | the in-flight view | oldest first at the draw clock, three and a count, `ageSec` of the snapshot; empty list is `none`, not n/a; n/a for read failure, session id failure, no snapshot (also starts only) and another session's record |
| 61 | BG and PERM at the three layouts | bodyColumns 36 / 49 / 89: NOW, `BG` rows, `+N more`, `snapshot` row, then the PERM n/a read in full; none; every n/a keeps its frame; a long label loses its tail, the wait stays; nothing overflows; without `view.progress.inflight` the card is the NOW band alone; `/progress` lines are the card's rows |
| 62 | in-flight through the engine | a fresh session reads BG n/a; a background `Bash` call then a Stop shows the wait from the call at 36 / 49 / 89 and in `/progress`; the notification row hides it; crons and wakeups; a subagent's Stop and a Stop with neither field change nothing; `turn.complete` does not clear; a non-notification message or another id ends nothing; the three sequences of the #16 review, each without ids (a lower bound `≥`) and with them (the wait of the listed task's own call): a main shell that ended beside a shell a subagent started, a fired `ScheduleWakeup` beside a subagent's `CronCreate`, a flagged `Agent` that ended beside one without the flag; a shell moved to the background by hand is dated by its `backgroundTaskId`; `ScheduleWakeup` with `stop: true` leaves no start and one without it dates its cron; a task listed while its subagent call was still returning is dated by the key at the next Stop; 63 keyed starts after a veto push the veto out, and `dropped` stops the count rule; hidden ids: the 65th hides nothing and exactly one row is left, a notification of another session starts the set over; mutations, each turning a named test red: the notification hook, the `agent_id` guard, `noteBgStart`, the count rule, the other-session check, a keyed match without the kind check (fresh and late-key paths), `dropped` ignored, the veto check removed, keyed starts in the pool, `stop: true` counted as a start, the late key removed, `status` not checked, a subagent call as an unkeyed start, an `Agent` without the flag as nothing, monitor / workflow / other mapped to the shell kind, labels cut with `slice`, the hidden ids not cleared for another session, the hidden-id cap at 63 |

## Acceptance

- `claude plugin validate ~/.claude/plugins/status-pane`: no errors.
- `claude plugin test ~/.claude/plugins/status-pane`: every suite green, and each row of the
  path matrix has a test.
- Type-check passes (scratch `tsconfig.json` outside the plugin folder per the skill, or
  `tsc -p` once the engine has laid `.claude-plugin/types/`).
- Manual TUI check (main session; `-p` cannot tell mid-turn behaviour):
  1. `git -C ~/.claude/plugins/status-pane fetch origin && git -C ~/.claude/plugins/status-pane checkout t15-now-row-progress`, then start a new TUI session (hot reload may also pick it up).
  2. Run `/cost` and note it.
  3. Prompt `run Bash: sleep 60` and approve it.
  4. While it runs, type `/progress`. PASS: `NOW  Bash <n>s` appears at once and matches the PROGRESS card. FAIL: the answer arrives only after the turn and reads `NOW  idle`; then register it as a plain command and record the limit on #15.
  5. `/cost` again: unchanged apart from that turn's own cost (no model call for `/progress`). Watch the pane for flicker at the 2 s repaint; this also measures the extra `$` calls and state writes per tool call once.
  6. BG (#16, branch `t16-inflight-row`): prompt `run Bash in the background: sleep 120`, wait for the turn to end, then `/progress`. PASS: `BG   shell <n>s` with `snapshot` under it and the `PERM n/a（...）` line; when the shell ends the notification row hides it. Also try a `CronCreate` and, if it can be arranged, a workflow or monitor: those were never stimulated, record what `BG` shows on #16.
  7. `git -C ~/.claude/plugins/status-pane checkout main`.
- Live probe (main session): loaded through `CLAUDE_CODE_PLUGIN_DIRS`, with the real
  `statusline.js` beside it, the context %, 5h %, 7d % and session cost agree (tokens, duration
  and lines drift while both write the cum file: see above); pane and tail draw at 200 columns,
  the tail at 120.

## Out of scope (phase 1)

No band. Tracker hooks stay (the mod reads their side files). `statusline.js` is not deleted.
agy is unaffected (no agy config references `statusline.js`).
