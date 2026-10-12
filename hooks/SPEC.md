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
  hooks/compact.ts             pure: the CONTEXT threshold hint and the /compact suggestion (fill, config, the compaction window the line is taken of, once per crossing, mode label)
  hooks/compact.observed.ts    test-only: what the engine answered for the compaction window in 94 probe runs (Claude Code 2.1.296)
  hooks/keeplist.ts            pure: the session.compact keep-list (switches, task files, recorded paths, the block and its budget, the decision, the task directory, the card value and the `/keeplist` text)
  hooks/dispatch.ts            pure: the in-flight count from the agents tracker (`dispatchOf`) and the optional threshold from STATUS_PANE_INFLIGHT_WARN (`parseInflightWarn`); stale cutoff 30 min
  hooks/state.d.ts             $.state contract and the snapshot types (a hooks/-located contract is accepted)
  hooks/sidefile.ts            pure reader of the side file contract (hub SCHEMA.md v1): bytes + clock in, a verdict out; `SideIo` is its seam
  hooks/sidefile.fixtures.ts   test-only: embedded copies of the hub's hand-written fixtures (hub commit 6098494)
  hooks/fixture.ts             test-only fake machine; register.tsx never imports it
  hooks/waiting.ts             WAITING board: name grammar, item rules, merge (7.1), collector, view, tail segment; imports only sidefile and state types
  hooks/waiting.fixtures.ts    test-only: hub waiting-merge copies (pinned commit, sha256) and the captured producer bytes
  hooks/sync.ts                SYNC card and tail hint: the reader side of kind `sync-status` (#29)
  hooks/sync.test.ts, sync.fixtures.ts  tests and embedded copies of the hub's fixtures/sync-status (hub commit 8018801, checked by sha256) for the SYNC card (test-only)
  hooks/tree.ts                test-only: reads a drawn tree back as text and cards (shares nothing with pane.ts)
  hooks/*.test.ts              `claude plugin test` suites (`progress.test.ts`: the PROGRESS card and `/progress`; `inflight.test.ts`: its BG and PERM rows; `keeplist.test.ts`: the keep-list, its engine rows and its card row)
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

### CONTEXT hint and /compact suggestion (#30)

The CONTEXT card always carries the threshold hint; at or over the threshold it turns into an alert in the fill's
tone, and `session.measure` can pre-fill `/compact` in the box. Source levels (#9 correction applied; observed =
a run of 2.1.296, specified = the type file or the settings schema, inferred = read from the source or reasoned):

- **The window the line is taken of** is not `usage().context.window`. That is the model's own window (observed:
  1000000 for the probed 1M models and 200000 for the 200K ones, whatever the settings say, in `usage()` and in
  `session.measure`; specified: "the context window of the session's model"). The engine compacts at a window that can
  be smaller, and `$.session.usage({ breakdown: 'summary' })` reports it as `rawMaxTokens` (observed: 400000 with
  `modelSettings.claude-opus-5-5.autoCompactWindow` = 400000, auto-compact threshold 367000). A line of 60% of the
  model's window would sit at 600K, past the point where the engine compacts. So the plugin works out the window from the
  inputs the engine reads, in the engine's order (`effectiveWindow`; the table `compact.observed.ts` is the engine's answer to
  94 combinations and the tests replay it):
  1. `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, read as the engine reads it (observed: a leading integer, `4e5`, `300_000`;
     `400k` reads 400 and is floored to 100000; `abc`, `0`, `-300000`, `0x30d40` and empty are skipped; floor 100000, cap
     1000000; `300,000` with a comma is inferred). It comes before the settings, not after them (observed: `250000`
     over a per-model `400000` gives `250000`).
  2. The settings, source by source from the highest (`policy`, `flag`, `local`, `project`, `user`; the rank of
     `policy` is inferred, the other four observed): the first source with a say decides. In one source the entry of
     the model (`modelSettings.<name>.autoCompactWindow`) beats the top-level `autoCompactWindow`, and a top-level
     value in a higher source replaces a lower source's entry (observed). `"auto"` for the model stands for the model's
     window and ends the search (observed). An integer outside 100000..1000000, a float, a string or a top-level
     `"auto"` is dropped as if absent, and does not reset what is below it (observed). Settings count only while
     `autoCompactEnabled` is not false in the highest source that names it; the variable counts either way (observed).
  3. The model's own window.

  The result never exceeds the model's window (observed). The model is matched by its whole canonical name: dated,
  `[1m]`, Vertex, Bedrock with a region prefix, upper case and spaces all spell one model, and a prefix such as
  `claude-opus-5` is another (observed; Bedrock without a region prefix inferred). If the window itself is unknown
  there is no line (null, never 0).
- **Not mirrored**, each pinned as a known gap by its probe row: an alias key (`opus`, `sonnet`, `haiku`: the engine
  resolves it to the current default model, observed), `DISABLE_COMPACT` and `DISABLE_AUTO_COMPACT` (the engine
  turns auto-compact off, observed), a non-boolean `autoCompactEnabled` that voids the whole settings file in the
  engine (observed), and the account, experiment and model-default sources, which a plugin cannot see (none moved the
  window on the probed models). The card then takes the configured window. `breakdown.rawMaxTokens` is the engine's own
  answer to all of it; the calls took 6 to 310 ms in the probe (observed, small sessions), so it is not polled here.
- **Fill** = `tokens / base`, where `base` is that window and `tokens` is from the `session.measure` payload (observed:
  `tokens` = the last response's input + cache read + cache creation, #9). `percent` is never used: an integer by
  inference only (one sample, value 0). The card takes the same ratio of `snap.context.v.used` and
  `snap.context.v.autoCompact.window`; a snapshot without that field is read against `max` as before. The title's
  percentage and the gauge stay a share of the model's window, as in `statusline.js`; when the base is smaller, the
  hint tells the line in tokens (`(240.0K)`) so the two are not confused.
- **Threshold** 60% of the base, inclusive (specified: the figure in `~/.claude/commands/壓縮建議.md`), i.e. 240K of 400K
  on this machine and 600K of 1M when nothing sets a window. `STATUS_PANE_CTX_AT=<1..99>` (whole numbers only; anything
  else is 60). The card names the default 60 until the first measure has written the state.
- **Where the base is worked out**: `refresh()` stores it on the snapshot (`context.autoCompact`, from the settings it has
  just read, the variable and the session's model) for the card; the measure works it out afresh (five settings reads, the
  variable, the model) so that a `/model` or a settings edit since the last refresh is not missed. Any input that cannot
  be had leaves the model's window.
- **Trigger**: `session.measure` fires once per main-loop turn (observed, #9); acts only when `changed`
  includes `context`. Usage is re-read per response (inferred only, #9 correction).
- **Mode** from `STATUS_PANE_CTX_SUGGEST` (specified): unset or other = `observe` (computes, records
  `last.would`, draws the card, calls nothing); `1` = `suggest` (`$.prompt.suggest({ text: COMPACT_TEXT })`
  once per crossing, never run); `0` = `off` (the card hint stays). Read at every measure.
- **Once per crossing**: fires when the fill rises over the line; a drop under it re-arms (what a /compact
  does); a new session id starts over. An answer of `isShown: false`, or a refusal, re-arms too, so the
  next measure tries again. One call in flight; a 3 s guard releases the flag if the box never settles.
- **`isShown`** (partially-supported, #9): the call is accepted (observed, headless); whether the grey text
  shows in a live TUI is NOT observed. The card prints it: `on · shown`, `on · not shown`, `on · pending`.
- **Gates**: rows file `enabled:false`, the `usage` row off, or no snapshot: nothing is computed or written.
  Every error inside the hook is swallowed; the hook returns `next(e)` untouched (fail-open).

The hint is a row of the CONTEXT card at every moment, under `used` and `compact`: `達 60% 建議 /compact` in dim
under the line (also before the first response, and with `(240.0K)` after the percentage when the base is smaller than
the model's window), `△ 已達 60% · 建議 /compact` in the fill's tone at or over it (never both), and then
`suggest <mode>` when a state exists. A card that says why it has no usage (`n/a (...)`) carries no hint. The
card mockups and the CONTEXT paragraph above this section predate the hint and show the card without its row.

### Keep-list on session.compact (#31)

A `session.compact` hook appends what the session still owes (its open tasks, its handoff files, the files it wrote or
edited) to the instructions the summarizer is told, so the summary names them. It observes by default;
`STATUS_PANE_KEEP=1` makes it write. Source levels (observed = a run of 2.1.296, specified = the type files,
inferred = read from the bundle or reasoned):

- **Observed, hub #10** (headless `-p`, a loopback stub that records the summarizer request, every verdict against a
  no-mod control and against a run whose list file is missing): a `session.compact` hook that appends text to
  `instructions` reaches the summarizer on `trigger=manual` and on `trigger=auto`; on manual the person's `/compact`
  text and the hook's text are both there; on auto `e.instructions` is **null**, so the list can be the only text;
  `$.fs.read` works inside the hook; a message appended to the result's `messages` shows in the next request (not
  used here, see the gaps).
- **Observed here** (the test kit, 2026-10-12): `$.session.compact(...)` on the kit's `$` raises the event with
  `trigger`, `agentId` and `instructions` as given; an empty `messages` is refused ("a compaction leaves at least
  one"); `instructions: undefined` arrives as a key that is present and undefined, an omitted one is absent, so the
  gate is `typeof e.instructions === 'string'` and never `'instructions' in e`; a plugin hook that throws is skipped
  and the call goes on to what is beneath it (tried with a hook that throws at once: the engine below was reached with
  the event as it came), while a handler at the bottom that throws leaves the caller `no implementation for
  session.compact`; a `{ skip }` answer reaches the caller.
- **Observed here** (this machine, 2026-10-12): a session's task list is `<config dir>/tasks/<full session id, dashes
  kept>/<n>.json` beside `.lock` and `.highwatermark`; a file holds `{ id, subject, description, activeForm, status,
  blocks, blockedBy }`, `id` and `subject` as text, `status` one of `pending`, `in_progress`, `completed`.
- **Observed here** (the end-to-end probe under Acceptance, 2.1.296): the hook runs on a real compaction with `agentId`
  absent for the main conversation (manual and auto: the block reached the summarizer, which it could not have if the
  event carried one); `e.file_path` is on a `Write` and a `Read` event as the typings say; `$.state` was not restored
  into a later process: `/keeplist` after a `/compact` in the same process prints the record, and in a later
  `claude -p --continue` process of the same session id it says `no compaction seen`.
- **Specified** (`index.d.ts`, 2.1.296): `precompute` is the one dispatch that installs nothing: its result is kept for
  the next compaction if the conversation still holds what it ran over, and `{ skip }` there computes and keeps
  nothing; `agentId` is absent for the main conversation and present for a subagent's or a fork's; a plugin's own
  `$.session.compact()` skips the calling plugin's hook; the input key of Write, Edit and Read is `file_path` and
  NotebookEdit's is `notebook_path` (`claude-code-tools/index.d.ts`).
- **Inferred** (read from the 2.1.296 bundle, not run): the task list is named by `CLAUDE_CODE_TASK_LIST_ID`, else a
  team's name, else a persisted leader team name, else the session id, every character outside `[A-Za-z0-9_-]`
  becoming `-`. The plugin knows the first and the last; a team's or a resumed list is a directory it does not look in
  (the state names the directory it did look in).
- **Not proven**: any behaviour in a live TUI; whether a precompute is ever dispatched there (`seen.precompute`
  counts them); whether a real summarizer keeps what it is told (the stub answers a canned summary). The manual TUI
  check under Acceptance covers the last two.

What it does:

- **Switches**, read at every compaction: `STATUS_PANE_KEEP` unset or anything but `1` and `0` is `observe` (works out
  what it would send, records it, changes nothing); `1` is `on`; `0` is the bypass of the compaction (no file read, no
  `keep` written, the event passed on as it came). `STATUS_PANE_KEEP_PRECOMPUTE=rewrite` gives a precompute the list
  like any other trigger; anything else answers it `{ skip }` under `on` (observe only records `would: skip`). The rows
  file with `enabled:false` silences the hook the same way; no snapshot yet is not that switch. Neither switch reaches
  the `tool.call` capture of written files and read handoffs (below), which records `kept` under both (31-37): they
  stop the compaction work, not the capture.
- **Decision** (`decideCompact`, pure), in this order: bypass, a trigger it does not know, `agentId` set (a subagent's
  or a fork's own compaction) and instructions that already carry the block's first line (a second copy of the mod, the
  same event passing twice) are left as they came; the rows file off is the same; then a precompute under the skip
  policy: mode `on` answers `{ skip: 'status-pane keep-list: a precomputed summary would freeze the list' }` without
  calling `next` and without reading any source, mode `observe` records `would: skip`; then the sources are read and
  nothing to keep is left as it came (`empty`); else mode `on` calls `next` with the new instructions and mode
  `observe` records `would: rewrite`. `next` is called once on every path but the skip, with the event as it came plus
  `instructions`, so `trigger`, `agentId` and `messages` are the engine's. A failure of `next` is the engine's: it is
  passed on and never retried.
- **Precompute** (the ticket's acceptance item) is skipped by default: the engine keeps a precomputed summary for the
  next compaction, and with instructions-only injection a summary made now would carry no list, or one that is stale
  by the time it is used. The cost is the summarizer's whole latency at the real compaction (not measured; none if a
  TUI never dispatches a precompute). `rewrite` trades that for a stale window from the precompute to the compaction
  that uses it. Observe never changes a precompute. Specified, not observed: it never dispatched in `-p`.
- **The text**, English, at most 1500 UTF-16 units, whole lines: `Keep these through the summary (copied from the
  session):`, then `Open tasks:` (`- #<id> [<status>] <subject>`), `Handoff files to re-read:` (`- <path>`) and
  `Files written or edited (newest first):` (`- <path>`). A section with nothing in it has no title and nothing at all
  is no text (never a header alone). What does not fit goes from the end, files first, then handoffs, then tasks, and
  a last line `(+N more)` counts it; the order is by value, not the ticket's order of mention, so the cap costs the
  least. A handoff that was also written is named once. With the person's text: theirs first and byte for byte, a blank
  line, the block. Without (auto): the block alone, no leading newline.
- **Open tasks**: `<config dir>/tasks/<list id>/<id>.json`, the config dir being `CLAUDE_CONFIG_DIR`, else
  `$HOME/.claude`. Only `<id>.json` (the engine's spelling) is read, never `.lock`, `.highwatermark`, a dotfile or a
  backup; the newest 200 ids at most, 25 at a time, none over 64 KiB. `pending` and `in_progress` are kept (in progress
  first, then by id, 15 at most, the rest counted); the subject becomes one line of at most 100 code points (hidden
  characters, line and paragraph separators, bidi controls and the tag plane become a space); nothing else of the file
  is used. A directory that is not there is no task and not a problem (a session that never made one). A directory that
  cannot be listed is a problem; so is a file that cannot be read, is not JSON, is over 64 KiB, has an unknown status
  or no usable id or subject (told by its name), and so is the cut at 200.
- **Files and handoffs** come from the plugin's own `tool.call` hook, not from the transcript: a compaction takes the
  calls out of it, and it does not hold a subagent's. A Write, Edit or NotebookEdit call that went through (no `deny`,
  no `isError`, the test the BG row uses), a subagent's included, records its absolute path in `$.state` (`kept`; 20
  at most, newest first, once each, under the session id; a path with a control or bidi character, over 400
  characters, or inside `node_modules` or `.git` is not recorded). A `handoff-<name>.md` that was written or **read**
  is also a handoff (5 at most). Only this session's. The capture is not behind `STATUS_PANE_KEEP` or the rows file: it
  records under `0`, under `enabled:false`, in observe and on alike (31-37, 31-27, 31-28). At a compaction the newest 10
  files and the handoffs are checked with `$.fs.exists`: gone is left out and counted, a check that is refused keeps
  the path (unknown is not absent). Files made by `Bash` (a redirect, a script) are not listed.
- **Fail-open**: the switches, the decision, the reads and the state write are one piece of work held to **4 s** with
  `$.clock.after` (the engine's 10 s hook budget does not count the time of a `$` call, so a hung call would stall the
  compaction). A throw, a refusal or the deadline hands `next` the event as it came, once; an answer that arrives
  after the deadline is dropped and writes nothing; if the timer cannot be armed the compaction goes on as it came.
  The engine itself skips a hook that throws (observed in the test kit); this does not rely on that.
- **State and readout**: `keep` (`KeepState`: session, switches, `seen` per trigger, and `last`: time, trigger,
  action, why, `would`, counts, cut, gone, characters, the text, what each source was read from in words, problems)
  is written once per compaction that is not silent, before `next`. Silent are the bypass, a trigger it does not
  know, a subagent, the block already there and the rows file off. The CONTEXT card gets one `keep` row under the
  hint: the mode, the trigger and what was found or done, whole at every width (under its word, wrapped, where it does
  not fit one row), this session's state only, none with the mode off. `/keeplist` (immediate; state only: no model
  call, no file read) prints the switches, the sightings, the last decision, each source in words and the text, or
  `keeplist n/a (reason)` when the state cannot be read. Only task subjects, paths and counts are stored.
- **Rollout and rollback**: the default is observe, so a merge changes the `keep` row, `/keeplist` and state writes and
  nothing the engine is told. The switch to `on` is the owner's, per machine, after the manual check under Acceptance:
  `STATUS_PANE_KEEP=1` in `~/.claude/settings.json` `env` (new sessions). Rollback, fastest first: `STATUS_PANE_KEEP=0`
  (the compaction is left alone: no file read, no `keep` written; the capture goes on recording `kept` in `$.state`);
  the rows file `enabled:false` (the same); revert the merge and pull, or take the folder out of
  `CLAUDE_CODE_PLUGIN_DIRS` (either stops the capture too). The `keep` and `kept` keys are inert once the code is gone.
  After a Claude Code upgrade: the hub's `session_compact_rewrite` probe and `claude plugin test .` again; the mod API
  is early access.
- **Gaps recorded**: the task list of a team or a resumed list; a restarted or resumed session (a new process) starts with no
  record of the files it wrote or the handoffs it read before (`$.state` was not restored into a later process in the probe); files made by `Bash`; append-to-messages (observed to
  work in `-p`, hub #10) is not in v1, it is the fallback if the TUI check shows the summarizer ignoring the
  instructions; task subjects are the person's own words and reach the summarizer as one cleaned line, not redacted;
  the engine skips a hook that throws (observed in the test kit), so the catch in this one is a choice, not a need.

### Dispatch count (in-flight, #32)

ACTIVITY's first row counts this session's subagents still running. Its source is the agents tracker file, the one
the agents row reads (one read, both rows). A `running` entry started within 30 min (`DISPATCH_STALE_MS`, inclusive)
counts; an older or undated one is shown as `N stale`, never hidden, because the tracker never prunes `running` (a
missed SubagentStop leaves one forever). There is no fixed limit: the row shows the plain count. The optional
threshold is the environment variable `STATUS_PANE_INFLIGHT_WARN` (`$.env.get`, read on every refresh while the
agents row is on): a positive safe integer turns the warning on, and a count above it reads `N over T` in red bold.
It is a display state only: no hook, no deny, no toast. Unset, empty, zero, negative, non-integer (`+3`, `2.5`, `1e3`)
or past the safe integer range is no warning (`parseInflightWarn`); a refused read is no warning too; a count equal
to the threshold is plain. Scope: this session's file, while the 429 limit is account-wide, so the number is a
per-session lower bound. The group row (`○×N`) still counts stale entries, so on a dirty file the two can disagree;
that is the agents row's own parity, left alone. Refresh rides the 30 s tick and `turn.complete`. A missing file
reads `in-flight n/a（agents file missing）` and is not counted as an error: the tracker writes only on a SubagentStart
or SubagentStop (read from `subagent-tracker.js`, inferred), so a session that has dispatched nothing has no file by
design, as with the SYNC file (#29), and the agents row reads `idle` as it does on main. A file that is there but
cannot be read (permissions, ownership) reads `in-flight n/a（agents file unreadable）` and the agents row reads n/a
too, not idle; one that is read but is not a JSON object (cut off, empty, `[]`) reads the same on the in-flight row
alone, the agents row staying `idle`. A fault counts one error: that unreadable read, a corrupt file, an existence
check that is refused, an unwired hook (the agents row counts the failed read, the check and the hook, and the
in-flight row does not add a second; the in-flight row alone counts a corrupt file). Tail: no in-flight segment.

## Dependencies

The agents, edited, summary and compact data come from tracker hooks in the settings, the mcp data from a
refresher script. Deleted later as cc-statusline leftovers, they would leave a row reading `idle`, `0` or
the session id, so each refresh checks them and a missing one reads `n/a (<reason>)`, which counts toward
the errors like any n/a (the exceptions: the SYNC card's missing and stale file, and the in-flight row's missing
tracker file; see their sections).

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
  here: `local` kinds by their cards; the `waiting` kind by the WAITING card (below), the only directory listing and multi-host merge.
- **FIXTURE card** (the proof of the path, kind `fixture`, `$TMPDIR/claude-side/fixture.json`, TTL 600 s): off
  unless the rows file has `"fixture": true`, the boolean only (`1`, `"yes"` leave it off; the only opt-in row: no producer exists on a normal machine). A band
  of its own, last, across the whole width at every tier. Title value and `count`, `age` (at the draw, so it keeps
  counting between refreshes) and `observed` (local clock); any other verdict is the reader's text, wrapped and read
  in full, with no data of the file. A failing fixture counts as one error like any row that is on.

- **SYNC card** (kind `sync-status`, #29, `$TMPDIR/claude-side/sync-status.json`, TTL 900 s): the state of `claude-memory` on `sync-data-v2` against `origin/sync-data-v2`, as the producer `~/.claude/scripts/hooks/sync-status.py` read it from local refs and FETCH_HEAD (no network). On by default; the rows file's `"sync": false` switches it off, and only a falsy value does, as for every default-on row. No producer on a machine until the hook has run there: until then the card reads `n/a（缺檔）`. Headline `✓` in sync, `-N PULL` / `+N PUSH` for one side, `+A -B` (red) when diverged. `behind` is only as new as the last fetch: the card shows `fetched <age>` and draws it yellow after 24 h. A failed or n/a file shows the reader's text in full with no counts; a count outside the §9 integer rules is `n/a（格式錯誤：data.<field> …）`. The tail leads with `SYNC -N PULL`, `SYNC +N PUSH` or `SYNC +A -B PULL` (`999+` above 999) and is left out when in sync or n/a. A n/a SYNC counts as one error when the row is on, except where it is by design: no file (`missing`: no producer on this machine yet) and a stale one (`stale`, also when its last collection failed, which was counted while the file was fresh). Until #91 adds a 5-minute refresh only the hooks rewrite the file, so after a 15-minute idle it is stale until the next hook run (roughly half of the prompts, by the hub #87 recount quoted in the review of PR #4), and counting that would bury the real errors. Every other n/a counts as one: `failed`, `malformed`, `corrupt`, `unsupported_version`, `bad_name`, `unknown_kind`, `no_clock`, a data-rule violation (`n/a（格式錯誤：data.<field> …）`) and a row that failed to collect (a guard timeout or a throw). It is decided on the reader's verdict, before `syncOf` turns it into text; the card shows the reader's text and the tail leaves the SYNC segment out whichever way it counts. The FIXTURE card is unchanged and counts every n/a. Owner decision of 2026-10-12. The producer runs all its git calls inside one 8 s deadline (3 s per call; the hook entry allows 10 s); a slower repository writes a failed file with `git_timeout`, which the card shows as the reader's text.

### WAITING card (kind `waiting`, synced, #28)

On unless the rows file has `"waiting": false` (a falsy value does the same; not in `OPT_IN`, so an empty board shows
`0` and 沒有登記). Off means the directory is never listed. Reads `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/-project/references/side-files/` after `exists`,
then `list`: names matching `^waiting\.([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json$` only, sorted, 16 read at most (the rest
counted as `skipped`). Each file goes through `readSideFile` (envelope rules and the host-vs-producer check), then the
SCHEMA 9 item rules; a violation makes that host `n/a（格式錯誤：第 n 筆 …）`. Merge (7.1): closed beats open, then the
later `updated_at`, then the larger host. Open winners only, since ascending then id, 100 kept, the true total counted.
Age and due are drawn at the draw clock, never stored: `<1h`, `Nh`, `Nd`; due when strictly more than 604800 s.
Title: `N`, `N · D due`, `≥N` when a host is unreadable beside items, `0` for a verified-empty board, `—` when nothing is
readable. Empty and verified-empty draw `沒有登記`; an unreadable host never draws it. 8 items drawn then `+N more`;
at most 3 unreadable-host rows then `+N hosts n/a`. A refused `list` makes the card one `n/a（目錄無法列出：…）` and
counts one error. The tail gets `WAIT N`, `WAIT N (D due)` or `WAIT ≥N` in front of the ctx, quota, cost and clock
segments, and none at 0 open items. When the SYNC segment (#29) shows it sits in front of WAIT:
`SYNC -3 PULL · WAIT 1 · ctx 3% · 5h 23% · 7d 61%`. The 48-character trim drops from the end, so WAIT outlasts every
segment but SYNC.
Stale own copies (SCHEMA 5.3 point 6) are not repaired here: the card shows what the synced files say.

Known limit, the 16-file cap is silent: `skipped` is computed by `collectWaiting` but nothing draws it, not the
title, not a row, not the tail. With more than 16 matching names the ones that sort last by name are never read, so
their open items are missing from the card and the tail, and the card can read `0` with 沒有登記 while an unread
host has open items. Observed through the engine (89 columns, 17 valid host files, one open item): the item in the
17th file gives the title `0`, the body 沒有登記 and a tail with no `WAIT`; the same item in the 16th file gives `1`
and `WAIT 1`, as it does with 16 files in all. Not decided: whether to draw the skipped count or to raise the cap.

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
- The keep-list's `keep` (the last compaction) and `kept` (the files this session wrote, the handoffs it read) live in `$.state` under the
  session id they belong to, like the counters above; a process that starts later reads none of them (observed, #31).

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
  why in full. The errors, `N error(s)` in red (failed rows that are on, except a missing or a stale SYNC
  file and a missing in-flight tracker file, and writes that fell back to a plain write), are the last row at
  the right edge. With the card off (`sys` and `memory_mcp` both) the errors stand alone in a row under the cards.
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
  in its frame; the other cards draw normally. Failed rows that are on count in the errors (a missing or
  a stale SYNC file and a missing in-flight tracker file excepted).
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
| 30-1 | fill is tokens / window | `{tokens 600000, window 1e6, percent 0}` gives 0.6; `percent` never decides, whichever way it disagrees |
| 30-2 | unknown is not zero | tokens missing, 0, negative or NaN, window missing, 0, negative or Infinity: null, no advice, no suggest, no NaN in text |
| 30-3 | threshold inclusive | 0.5999 no advice; 0.6 advice; 0.801 in the red tone (the gauge's boundaries) |
| 30-4 | config parse | threshold: whole numbers 1..99, else 60; mode `1` suggest, `0` off, anything else observe; no throw |
| 30-5 | once per crossing | fills 0.55, 0.60, 0.63, 0.70, 0.61, 0.55, 0.62 fire at 0.60 and 0.62 only; another session id starts over |
| 30-6 | suggestion text | exactly the fixed `COMPACT_TEXT`: `/compact ` prefix, one line, at most 120 cells, no session data |
| 30-7 | below the line | the quiet hint `達 60% 建議 /compact`, dim, one row at 36, 49 and 89 columns, no alert and no mode line; also with no usage yet; a taller CONTEXT card in every golden, pinned body and fixture that has one (the owner's words on #30) |
| 30-8 | at the line | the alert with `60%` and `/compact` at 36, 49 and 89 columns, in place of the quiet hint and never beside it; under the used row; no new card |
| 30-9 | mode line | observe, `on · shown`, `on · not shown`, `on · pending`, off; no line without a state |
| 30-10 | fit | no overflow at 22 to 120 columns, 200K and 1M windows, with a long reason (22: the MIN_W clamp below it predates the card) |
| 30-11 | engine: observe | default: no `prompt.suggest` call; `last.would` holds the text |
| 30-12 | engine: suggest | one call with the fixed text; a repeat is silent; a compact then a new crossing sends again; `isShown` recorded |
| 30-13 | engine: isShown false | recorded as false; the next measure tries again |
| 30-14 | engine: refused suggest | the measure resolves; the reason is recorded |
| 30-15 | engine: silent | a measure without `context` in `changed` writes no state and reads no env |
| 30-16 | engine: bypass, master switch | env `0`: no call, mode off; rows file `enabled:false` or the `usage` row off: no state write, no call |
| 30-17 | engine: burst | three measures at once: one call |
| 30-18 | engine: fail-open | env read refused, then state write refused: both resolve, no call |
| 30-19 | engine: other session | a state of another session is overwritten; its armed flag does not suppress (the other state is served by the fixture's `state.get`, not written beside it) |
| 30-20 | the engine's answers | the 94 probe runs of `compact.observed.ts` (2.1.296) replayed through `effectiveWindow`: window and source equal the engine's `rawMaxTokens` and `autocompactSource` (env, settings, else the model's window); five rows are known gaps and pin what the plugin answers; a control that most rows shrink the window and that every source the engine named occurs |
| 30-21 | the variable | unset, empty, spaces, a sign, exponent, thousands marks, a leading integer, `400k` floored, hex and negatives skipped, floor 100000, cap 1000000 |
| 30-22 | the model's name | dated, `[1m]`, Vertex, Bedrock, upper case and spaces name one model; `claude-opus-5` is not `claude-opus-5-5` |
| 30-23 | the settings' rules | in one file the entry beats the top-level value, whatever way its key is spelled; a higher top-level value replaces a lower entry; a higher entry beats a lower top-level value; another model's entry is none; `"auto"` ends the search; bounds, floats and strings; two spellings in one file; policy to user in order; junk sources and entries without a throw; an unnamed model takes no entry |
| 30-24 | the answer | no window is null; never wider than the window; the variable before every source of settings, and a bad variable skipped; `autoCompactEnabled: false` puts the settings aside, the variable stays, the highest source that names it decides; nothing set is the model's window |
| 30-25 | the card's base | 239,999 of a 400K window is under the line and 240,000 at it, at 36, 49 and 89 columns; the line's figure `(240.0K)` shows only for a smaller window (used reads 250.0K so the figure is the line's own); no override or a snapshot without the field reads as before |
| 30-26 | the quiet hint | dim, one row (`達 60% 建議 /compact`), alert at the line and never both; with no usage yet; the figure in both forms; an n/a card carries none; the mode line stays with the alert; no overflow from 22 to 120 columns under the line; the threshold of the state (75 reads 75) |
| 30-27 | engine: the snapshot's window | the settings name 400K; the variable first; nothing set; settings refused with and without the variable; a project's top-level value replaces the user's entry |
| 30-28 | engine: the measure's window | 250K of 400K sends where 250K of 1M does not; 239,999 one token under, 240,000 at it; observe mode records at the same line; the variable moves the line (150,000 of 250,000); a measure window below the setting is the window (130K of 200K); settings refused falls back to 60% of the model's; the variable refused leaves the settings; another model's entry is not taken; ranked at the measure too |
| 30-29 | mutations of 30-7 and 30-20 to 30-28 | 34 mutants, each turning a named test red. The window: the settings read before the variable, the model matched by prefix, the top-level value read before the entry (with a non-canonical key), `autoCompactEnabled` ignored, no clamp for the settings, no clamp for the variable, `"auto"` as no entry, no bounds, sources walked lowest first, no floor, `Number()` for the variable, dated names kept, the canonical spelling not winning, an unnamed model taking entries, the window not stored on the snapshot, the measure ignoring the window, the card on the model's window, the variable not read, sources in read order, no settings at the measure, no settings at the refresh, the figure never told, the figure always told, the figure being the window. The hint: none under the line, in a reading colour, beside the alert, naming the default threshold (quiet and alert), with the mode line, without the figure, on an n/a card, worded as reached, wrapped at 12 cells |
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
| 63 | SYNC card, the hub chain | `sync.test.ts`: the thirty cases and five boundaries of the hub's `fixtures/sync-status/EXPECTED.json` (embedded, hub commit 8018801, each copy checked by sha256) give their verdict, values and named field through `readSideFile` and `syncOf`; the eight producer-written files draw as `-3 PULL`, `+2 -3`, `✓` and the producer's failure text; a stale file with a float count is stale, a fresh one malformed |
| 64 | SYNC card on by default, and its opt-out | `sync.test.ts`, the engine describe: with no rows file and the producer's file the card reads `-3 PULL` as the last card, the tail leads with `SYNC -3 PULL` and no error is counted; with no file it reads `n/a（缺檔）`, no tail segment and no error (row 66); `"sync": false` hides the card, the tail and the error and the file is never read; the reading of the rows key: no key and `1` are on, `false` and `0` are off |
| 65 | SYNC card at every width | `sync.test.ts`, bodyColumns 22 to 122 (the three tiers and the seams between them), on the layout alone: four readings (behind 3 with both stamps, ahead 2 with stamps months old, diverged by four-digit counts, in sync and never pushed or fetched) and four n/a reasons (no file, the producer's timeout text, one unbroken word of 217 cells, wide characters only). At each width nothing in the pane is wider than its room, by the tree and by the rendered text; every card's frame is whole; the SYNC card is there and as wide as the pane (a missing card fails the sweep, it does not pass it); the headline and the six rows come in order; the n/a reason is read to its end. Mutation, on a scratch copy, one change at a time, the rest of the suite staying green: the n/a reason unwrapped, the n/a reason cut with an ellipsis, `last push` as one row with no fallback under its label, the card left out on the narrowest panes, the card one cell narrower than its room, the headline left out below 20 cells inside, the `observed` row left out below 18 cells inside: each turns the sweep red and nothing else |
| 66 | SYNC n/a and the error count | `sync.test.ts`, the engine describe `which n/a counts as a SYSTEM error` (owner decision of 2026-10-12): the card shows every n/a and the tail leaves the SYNC segment out, but only a fault is the one SYSTEM error. Not counted: no file (`n/a（缺檔）`), a stale file (`n/a（過期 30m）`), and a stale file whose last collection failed (the hub's `failed` bytes read 20 minutes later: `n/a（過期 20m，最後一筆收集失敗：…）`; the same bytes read fresh count one). Counted, one each: a fresh `failed` file, a `2.0` count (reader verdict `malformed`), a branch name with a space (a data rule of `syncOf`; the reader says `ok`), a truncated file (`corrupt`), and a row that failed to collect (the read outlasts the 5 s guard: `n/a（timeout）`, held with `stallNext`). `"sync": false` still counts nothing, and `fixturecard.test.ts` pins that a missing and a stale fixture still count. Red before the change: the three not-counted tests; the other five are regression guards that the mutations pin. Mutation, on a scratch copy, one change at a time, the rest of the suite staying green: count every SYNC n/a again turns red exactly the three not-counted tests; count none, exactly the five counted ones; drop `stale` from the exclusion, exactly the two stale tests; drop `missing`, exactly the no-file test; treat a failed collection as by design, exactly the timeout test; also exclude `failed`, `malformed`, a data-rule violation or `corrupt`, exactly the test of that case; give the FIXTURE row the same exclusion, exactly its two error tests |
| 67 | dispatch count | `dispatchOf`: a missing file is n/a（agents file missing）; running within 30 min counts and the boundary is inclusive; older or undated running entries are stale; other statuses count nowhere; an unreadable file is n/a（agents file unreadable）, through the engine too: a file that exists but whose read is refused reads unreadable, not missing, at the three widths, with the agents row n/a and one error; no fixed limit: the plain count, and `N over T` in red bold only past a threshold, where `parseInflightWarn` takes a positive safe integer and anything else (unset, empty, zero, negative, `+3`, `2.5`, `1e3`, untrimmed junk, out of range) is no warning; a count equal to the threshold is plain; the engine reads STATUS_PANE_INFLIGHT_WARN each refresh and a refused read is no warning; through the engine it follows the 30 s tick; a failed read counts one error and a missing file none (row 68); mutations, each turning a named test red: the missing file as 0, the unreadable file as 0, the refused read labelled missing or treated as absent or empty, the `>=` boundary, the `+` / float / trim / safe-integer checks, the ASCII parens, the threshold not passed to `dispatchOf` |
| 68 | dispatch n/a and the error count | `dispatch.test.ts`, the describe `which tracker n/a counts as a SYSTEM error` (review round 1 of PR #8; the same class as the SYNC file of row 66): the in-flight row shows every n/a, but only a fault is the one SYSTEM error. Not counted: no file (the hook is wired, nothing has been dispatched): `in-flight n/a（agents file missing）` beside `agents idle`, no chip. Counted, one each: a file cut off mid-write and valid JSON that is not an object (`n/a（agents file unreadable）`, `agents idle`; the in-flight row alone counts it), a file whose read is refused (`n/a（agents file unreadable）` on both rows; the agents row counts it), an existence check that is refused (`n/a（EACCES…）` on both rows, once), the hook not wired (`n/a（subagent-tracker.js hook not configured）` on both rows, once and not twice). A healthy file reads `in-flight 3` and counts none. `dispatchByDesign` in `collect.ts` is the file being absent (no text read), not the reason text, as `syncByDesign` is the reader's verdict. Source levels: the displays and the counts are observed (the suite, and a probe of the same states through the engine at 36 and 89 columns on main c571633, on a875971 and on the fix); that the producer creates the file only on a SubagentStart or SubagentStop is inferred (read from `~/.claude/scripts/hooks/subagent-tracker.js` on WKY, 2026-10-13, not run live); that a missing file is by design and still shown as n/a（原因） is specified (the review of round 1, and the ticket's 「資料缺失顯示 n/a（原因）」). Against main, observed: no file, a cut-off, empty or non-object file and a refused read were `agents idle` with 0 errors (the in-flight row was not there); a refused existence check and an unwired hook were already 1 error. Red before the change: the missing test of row 67 (its `1 error` flipped to 0) and the missing row here; the other six rows are regression guards that the mutations pin. Mutation, on a scratch copy of the fixed tree, one change at a time, the rest of the suite staying green (control 1218 pass): count the missing file again (the exclusion removed) turns red exactly the missing test of row 67 and the missing row here; never count an in-flight failure, or let any good read of the agents row excuse it, exactly the corrupt-tracker test of row 67 and the two corrupt rows here; a refused read taken for no file, the three width tests of row 67, its agents-row test and the refused-read row here; a refused read taken for an empty file, exactly the agents-row test of row 67 and the refused-read row; an unwired hook not counted, the four tests of row 27 that count it, the corrupt-tracker test of row 67 (its second half unwires the hook) and the unwired row here; a refused existence check taken for no file, exactly its row here; the missing file read as 0, the unit test and the engine test of row 67, the missing row here and `with no tracker files they read idle` in `refresh.test.ts`. The first pass of the last two also timed out three layout sweeps at 5000 ms (load average 25 on the machine); they passed on the rerun and are not those mutants' doing |
| 31-1 | config | `STATUS_PANE_KEEP`: `1` on, `0` off, anything else (unset, empty, `x`, `2`, `true`, ` 1 `, `01`) observe; the precompute policy is rewrite only for `rewrite`; a value that is not text is the default, no throw |
| 31-2 | task file | `pending` and `in_progress` kept, the id as text (a number too); `completed` and `deleted` dropped quietly; an unknown or missing status, no subject, a subject of hidden characters only, an id that is not text or not a safe name, bad JSON, `[]`, `null`, `42`, `"str"` and a `__proto__` key are dropped with a reason that is a problem; the subject is cleaned on the way in |
| 31-3 | one clean line | `\n`, `\r`, `\t`, U+2028, U+202E, U+0000, U+0085, U+007F, U+200B, U+FEFF, U+2066 each become one space, runs and ends collapse; the cap counts code points (an emoji is never cut); both edges of each of the 14 hidden ranges (listed in the test itself, not read from the code) fold into one space in a subject and refuse a recorded path, and the code point just outside each stays (the joiners U+200C and U+200D among them; a blank beside a range folds in a subject and is accepted in a path); `tasksOf`: in progress before pending, by number (9 before 10), a name that is not a number last, 15 at most with the rest counted, the input untouched |
| 31-4 | recorded paths | Write, Edit and NotebookEdit: absolute, newest first, once each (a re-edit moves to the front), 20 at most; a relative path, an empty one, one with a newline, U+202E or U+0000, 401 characters (400 is kept), inside `node_modules` or `.git`, not text, and every other tool record nothing (`.gitignore`, `node_modules_old`, `my.git`, `.github` are not those directories); another session id starts over and leaves the old record as it was |
| 31-5 | handoffs | `handoff-<name>.md` only (`handoff-notes.txt`, `my-handoff-x.md`, `handoff-.md`, `handoff.md`, `handoff-x.md.bak`, `handoff/foo.md` are not); written: a handoff and a file; read: a handoff only; a Read of anything else records nothing; 5 at most, newest first, once each; `callPath`: `file_path` for Write, Edit and Read, `notebook_path` for NotebookEdit, nothing for another tool |
| 31-6 | the instructions | `withKeep`: the person's text first and byte for byte, a blank line, the block; none, blank or not text is the block alone with no leading newline and no `undefined`; instructions that already carry the first line come back as they are; at most the text, the block and two characters |
| 31-7 | the block | `buildKeep`: tasks, handoffs, files under their titles; nothing is null (never a header alone); a section with nothing has no title; a handoff that was also written is named once; tasks the caller could not fit are counted on the last line; over 1500 units whole items go from the end (files, then handoffs, then tasks), the last line counts them, no line is cut; exactly 1500 fits and one more does not; the sweep of 1 to 40 tasks keeps the most that fit |
| 31-8 | the decision | `decideCompact`: off, a subagent, a block already there and a trigger of the future pass (`off`, `subagent`, `marked`, `trigger`); on: manual, auto and plugin rewrite, nothing to keep is `empty`; a precompute is a skip with a one-line reason under the skip policy and a rewrite under `rewrite`; observe passes and says `would`; all 3 x 2 x 5 x 2 x 2 x 2 combinations: a rewrite needs mode on, the main loop, no block yet and something to keep, a skip is only a precompute under mode on and policy skip, `would` is only for observe |
| 31-9 | engine: manual | the person's text, a blank line, the block; the messages and the trigger as they came; the engine's answer back as it is |
| 31-10 | engine: auto | instructions absent, `undefined` or `null`: the block alone, no `undefined`, no `null`, no leading newline |
| 31-11 | engine: #30's text | the text #30 pre-fills (`COMPACT_TEXT` without `/compact `) survives in front of the block; a plugin's own compaction is told like a manual one |
| 31-12 | engine: precompute skip | mode on, default policy: `{ skip }` with a reason, no file read, the listing never tried (a refused one would have been told as a problem), the engine below never reached, `seen.precompute` 1 |
| 31-13 | engine: precompute rewrite | policy `rewrite`: the block goes in |
| 31-14 | engine: precompute observe | reached with the instructions as they came; the state says `would: skip` |
| 31-15 | engine: precompute bypass | `STATUS_PANE_KEEP=0`: reached untouched, the compaction reads no file and writes no `keep` |
| 31-16 | engine: observe | the default: the engine below gets the instructions as they came; the state holds the block that would be sent, its counts and size |
| 31-17 | engine: bypass | `STATUS_PANE_KEEP=0`: the compaction reads no file and writes no `keep`, instructions as they came (the capture still records: 31-37) |
| 31-18 | engine: rows file | `enabled:false`: the compaction reads no file and writes no `keep`, as it came (the capture still records: 31-37); no snapshot yet is not that switch |
| 31-19 | engine: subagent | `agentId` set: as it came, nothing read, nothing written (specified-only: the end-to-end check covers the main loop) |
| 31-20 | engine: empty | mode on with nothing to keep: as it came (also for auto), the state says `empty`, no header-only text |
| 31-21 | engine: twice | instructions that carry the block's first line are not given it again; the same event passing twice, and the line inside other text; the calls that find it read no file and write no `keep` |
| 31-22 | engine: where the tasks are | `CLAUDE_CONFIG_DIR` over `HOME`; `CLAUDE_CODE_TASK_LIST_ID` over the session id, `my list/1` read as `my-list-1`; the full id with its dashes, not the 24 character one (a decoy list under each wrong name) |
| 31-23 | engine: the directory | `.lock`, `.highwatermark`, `.hidden.json`, `notes.txt`, `x.json.bak` ignored and finished tasks left out; 250 files are 200 reads, the newest, and the cut is told; an unreadable file and one that is not JSON are problems by name and the rest is kept; a missing directory is no task and no problem and the state names where it looked; one that cannot be listed is a problem and the other sources still go in; a hostile subject reaches the summarizer as one clean line |
| 31-24 | engine: fail-open | the switch unreadable, the state unwritable, the state unreadable, the clock unreadable: the engine below gets the event as it came, once, and the call resolves |
| 31-25 | engine: deadline | a file read, or the rows-file state read, that never answers: after 4000 ms of mock time the call resolves as it came (nothing sooner), and releasing the read afterwards changes nothing and writes no state |
| 31-26 | engine: one call | off, observe, on, on with nothing, a subagent, a block already there, a precompute observed and rewritten reach the engine below once, a skipped precompute never; its answer comes back unchanged; its failure is passed on and not tried again |
| 31-27 | engine: the record | Write, Edit and NotebookEdit that went through, a subagent's too, are recorded under the session id; a denied, failed or throwing call is not; a Read of a handoff is a handoff, any other Read writes nothing; a relative path, `node_modules` and `Bash` write nothing |
| 31-28 | engine: the record at a compaction | it outlives the compaction and grows (A, B, then C: C, B, A); another session id starts over; a file that is gone is left out and counted, one whose check is refused stays; the newest 10 are listed; handoffs come before files, once, and are checked like them |
| 31-29 | the card | the `keep` row after the hint at 36, 49 and 89 columns, whole (`keep observe · manual · 3 tasks 4 files 1 handoff`, `keep on · auto · injected 412 chars`, `keep on · precompute skipped`), its word dim and its value not; no state, the mode off or an n/a card: no row; no overflow from 22 to 120 columns; through the engine the pane shows it after a compaction and not before, and not for another session's state |
| 31-30 | `/keeplist` | registered after the others with `immediate: true`; before any compaction it says so and names the switches; after one it prints the switches, the sightings, the decision, each source and the block; another session's state is none; a refused state read is `keeplist n/a (reason)`; no file read, no listing, no `usage()` |
| 31-31 | guard: the old suites | `claude plugin test .` on `t30-context-card` at 00e6870 (it holds main 14487a7 with the SYNC card): 1045 pass, 0 fail, 13 files. Here 1299 pass, 0 fail, 17 files (1045 + 129 new rows in `keeplist.test.ts`: 54 pure, 63 engine, 12 card, + 44 in `dispatch.test.ts`, #32, + 81 for the WAITING card, #28: `waiting.test.ts` 45, `waitingcard.test.ts` 35, `model.test.ts` 1); every old one is unchanged and green except the two lists of registered commands (`pane.test.ts` `session.start`, `progress.test.ts` `/progress is registered`), which now end with `keeplist`. `claude plugin validate .` passes |
| 31-32 | guard: secrets | no added line looks like a credential, and no fixture builds one |
| 31-33 | which task files | `pickTaskFiles`: only `<id>.json`; the newest ids first (10 before 9), a name that is not a number last; 200 at most with the rest counted; the listing untouched |
| 31-34 | the task directory | `taskDirOf`: `CLAUDE_CONFIG_DIR` over `HOME`, trailing slashes dropped, the full session id with its dashes, `CLAUDE_CODE_TASK_LIST_ID` over it with every character outside `[A-Za-z0-9_-]` a dash (`../../etc` is `------etc`, an emoji is two), empty values fall through, no base or no id is a reason |
| 31-35 | the state | `nextKeepState`: counted under its trigger, another session starts over; `keepLabel`: the three card values, singular and plural, a count of problems, the mode alone with no decision; `keepReport`: switches, sightings, the decision, counts, each source, every problem, the block; no state is `no compaction seen`; through the engine the sightings count by trigger and start over for another session |
| 31-36 | mutations | 54 changes made one at a time to a copy of the plugin, each turning at least one named row red and none surviving. The plan's ten: the block check dropped (31-6 and 31-21), a precompute passed through under mode on (31-8 and 31-12), the person's text dropped (31-6, 31-9, 31-11), `undefined` or `null` through a template string (31-6 and 31-10), observe also rewriting (31-16, that row alone), the deadline doing nothing when it falls due (31-25, both stalled-call rows), `next` called twice (31-26, and every row that counts the calls below), the 24 character id naming the task list (31-22, and every row that seeds tasks), `agentId` ignored (31-8 and 31-19) and a Read of every file recorded (31-5 and 31-27). The rest: the observe check inverted in the decision, one newline in place of a blank line, the handoff section under the files title, `>=` and 1501 at the budget, hidden characters kept, a finished task as a problem, pending before in progress, a path listed twice, `HOME` before `CLAUDE_CONFIG_DIR`, a refused existence check dropping the path, a late answer writing the state, the rows file ignored, `0` not a bypass, the sources read before a skip, denied and failed calls recorded, a subagent's write dropped, the count not starting over for another session, the card drawing another session's state or the row with the mode off, 20 files listed, handoffs unchecked, a missing directory as a problem, the oldest 200 task files read, a rejection not turned into a pass (the call never answers), a hook that never rewrites, every tool call writing the record, null instructions unguarded, a blank person's text kept, a 3 s and a 5 s deadline, 21 files, 6 handoffs, 16 tasks, 101 code points, a 401 character path, 201 task files, a 65,535 and a 65,537 byte limit, no size guard, tasks neither ordered nor capped, a relative path recorded, `node_modules` and `.git` recorded, and `handoff-.md` a handoff. The first pass left the 101 code point subject alive (the pure row cut with its own number, not the parser's); `the subject is cut to 100 code points on the way in` closes it. The old layout row `never borderless at any width from 20 to 122` (1.3 to 2.3 s alone) timed out in several mutants run three suites at a time; it is not those mutants' doing and passes alone. A later review found nine more alive: `hasMark: false` in `keepWork` (the instructions come back the same through `withKeep`, so only the file reads and the `keep` write told it), and the removal of each of the U+00AD, U+061C, U+180E, U+200E-F, U+2060-64, U+FFF9-B, U+E0100-E01EF and U+FEFF ranges from the hidden table (no row used those characters). 31-21 now counts the reads and `keep` writes of the calls that carry the block, and the edge row of 31-3 closes the ranges. Each of the nine turns its own row red and no other (`hasMark: false` 31-21, the eight ranges the edge row of 31-3). A task subject cannot tell U+FEFF (`\s` folds the BOM): only the path check can. Moving an edge by one code point (U+200C, U+200D, U+2065 and U+E0080 hidden; U+001F, U+007F, U+206F and U+FFF9 not) turns the edge row red too. Stopping the capture under `STATUS_PANE_KEEP=0`, or under the rows file switched off, turns its own row of 31-37 red and not the other |
| 31-37 | engine: the capture under the switches | `STATUS_PANE_KEEP=0` and the rows file `enabled:false`, one row each: a Write and a Read of a handoff are still recorded under the session, while a compaction is left as it came and writes no `keep` |
| 28-1 | merge, hub EXPECTED | `waiting.test.ts`: the hub `merged` set and winners at the reference now; closed wins, the larger host wins a tie, due is strictly over 604800 s, 0002 takes the newer text |
| 28-2 | hub copies | `waiting.test.ts`: each embedded copy matches its pinned sha256 (commit 7b88598); a one-byte edit changes the hash |
| 28-3 | item rules | `waiting.test.ts`: one case per SCHEMA 9 violation, each n/a with its reason; 200 emoji accepted; unknown keys ignored |
| 28-4 | name filter and cap | `waiting.test.ts`: `waiting.json`, two-part names and `.tmp` leftovers never opened; 16 read, the rest skipped (`skipped` is not drawn: a known limit, see the WAITING card section) |
| 28-5 | AC1 empty states | `waiting.test.ts`: absent dir (list throws ENOENT, still 0), non-matching names, all closed, a truncated host beside an empty one reads `—`, not 0 |
| 28-6 | card layout and rows | `waitingcard.test.ts`: band of one at 36/49/89 after ACTIVITY, before SYSTEM; DUE at the right edge; `+N more`; `≥N`; `—`; 沒有登記 never beside an unreadable host |
| 28-7 | tail | `waitingcard.test.ts`: `WAIT N`, `(D due)`, `≥N`; none at 0 or unreadable; first segment, or second behind the SYNC segment when that shows (`SYNC -3 PULL · WAIT 1 · ctx 3%`; each alone leads; the 48-character trim drops the segments behind WAIT first, then WAIT, SYNC last); row off or master off gives none |
| 28-8 | engine, captured bytes | `waitingcard.test.ts`: the producer capture drawn through `boot`; flipping the closer to open brings X back; rows file off reads no side file; CLAUDE_CONFIG_DIR honoured |
| 28-9 | default on and the opt-out | `model.test.ts`: `waiting` is on for no file, `{}`, a file without the key and `1`; `false` and `0` switch it off. `waitingcard.test.ts`: no rows file and an empty synced dir read `0` with 沒有登記; a rows file without the key keeps the card and the `WAIT 2` segment. Its mutations are in 28-10 |
| 28-10 | mutations (run once each, restored) | closed-wins, tie-break, `>=` due, name grammar, host check, exists-first, 16-file cap, control-char rule, link count, row-off gate (collector and tail), 沒有登記 beside down hosts: each turns exactly its named rows red. For 28-9, one change each, restored: (a) `'waiting'` put back into `OPT_IN` in `model.ts` (the row off until the file says boolean `true`) turns 8 tests red, no others: the `model.test.ts` test `waiting is on by default and off only for a falsy value in the rows file`, the two `on by default` engine tests, and the five `#8 row toggles file` tests built on `off()`, which expects every row but `fixture` on; (b) a strict `!== false` reading for `waiting` in `parseTogglesStrict` (so `0` no longer switches it off) turns that test red and no other; (c) the rows file's `waiting` key not read (so `false` cannot switch it off) turns 54 tests red: that test, the rows-file-off engine test and the pane tests that keep the card off with `"waiting":false`, in the world's seed or in their own rows file |

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
- Manual TUI check for #30 (owner only: the grey text shows in a live TUI, and `-p` has no input box; #9 item (b)): start a TUI session
  with `STATUS_PANE_CTX_SUGGEST=1 STATUS_PANE_CTX_AT=1`, run one short turn, leave the box empty and idle.
  PASS: after the turn the box shows the grey `/compact focus on ...`, Tab takes it into the box, and the card's
  `suggest` line reads `on · shown`. `on · not shown` or no grey text: record the result on #30 and #9/#31; the
  feature stays hint-text-only and the default stays observe. With `modelSettings.claude-opus-5-5.autoCompactWindow`
  = 400000 the CONTEXT card also reads `達 60% (240.0K) 建議 /compact` under the line and `△ 已達 60% (240.0K) · 建議
  /compact` from 240K tokens on, while its title percentage stays a share of the model's 1.0M.
- Probe of the #30 line through the real engine (2.1.296; a scratch config dir, a loopback stub API that answers with
  chosen usage figures, this branch loaded beside a recorder of `prompt.suggest`; not part of the suite). With
  `STATUS_PANE_CTX_SUGGEST=1` the suggestion goes out of `session.measure` exactly at the line and not a token before:
  a per-model 400000 sends at 240000 and not at 239999 (and sends at 250000, where no setting does not); the variable
  250000 sends at 150000 and not at 149999; a project's top-level 300000 over the user's per-model 400000 sends at 180000
  and not at 179999; no setting sends at 650000 and not at 599999. Every call carried `origin = { kind: "plugin",
  name: "status-pane" }` and was answered `isShown: false`, as headless has no box.
- Manual TUI check for #31 (owner only: `-p` has no live summarizer and no TUI, and what the summarizer does with the
  instructions is the open question; the flip to `on` is the owner's, per machine):
  1. TUI-1, `STATUS_PANE_KEEP` unset: create two tasks, edit a file, run `/compact`. PASS: the CONTEXT card's `keep` row
     reads `observe · manual · 2 tasks 1 file 0 handoffs`, `/keeplist` prints the block that would have been sent and the
     conversation after the compaction is what a plain `/compact` leaves.
  2. TUI-2, `STATUS_PANE_KEEP=1` in a new session: the same setup, `/compact`, then ask "which tasks are open and where
     did you write files?". PASS: the answer names both; compare with `STATUS_PANE_KEEP=0`. FAIL (the summarizer ignores
     the instructions): record it on #31 and open the append-to-messages follow-up (observed to work in `-p`, hub #10);
     the default stays observe.
  3. TUI-3: leave a long session in observe and read `seen.precompute` in `/keeplist`. 0 after real auto-compactions means
     a precompute is never dispatched there and the skip default costs nothing; more than 0 says how often, and the
     latency of the compaction that follows is what the skip costs.
  The owner flips `STATUS_PANE_KEEP=1` (new sessions) after TUI-1 and TUI-2 pass and a few real compactions in observe
  showed a sensible would-be text with no problems; `STATUS_PANE_KEEP_PRECOMPUTE=rewrite` only if TUI-3 shows a precompute
  and the skip costs too much.
- Probe of the #31 hook through the real engine (E2E-1; 2.1.296; the hub's loopback summarizer stub and its helpers, a
  scratch config dir and home, this branch loaded with `--plugin-dir`, `CLAUDE_CODE_TASK_LIST_ID=e2e-list` over a list
  of one pending and one completed task; not part of the suite; the hashes of the real settings files before and after
  are equal). The evidence is the text of the summarizer request the stub received:

  | run | summarizer requests | with the block | with the person's text |
  |---|---|---|---|
  | `STATUS_PANE_KEEP=1`, `say hi` then `/compact E2E-CMD-TEXT-7712` | 1 | 1 (the pending task, not the finished one) | 1, ahead of the block |
  | `STATUS_PANE_KEEP=1`, an auto loop of 4 tool turns | 3 | 3 | none to carry |
  | `STATUS_PANE_KEEP=0`, the manual run | 1 | 0 | 1 |
  | unset (observe), the manual run | 1 | 0 | 1 |
  | unset (observe), the auto loop | 3 | 0 | none to carry |
  | `STATUS_PANE_KEEP=1`, no task directory | 1 | 0 | 1 |

  In one process (stream-json input) `/compact E2E-CMD-TEXT-7712` then `/keeplist`: observe printed `manual → pass
  (observe, would rewrite)`, `1 task · 0 files · 0 handoffs · 0 cut · 0 gone · 106 chars`, the directory it read and the
  block; `=1` printed `manual → rewrite (keep)` and the summarizer request carried the block. The capture: a stub turn
  that wrote a file with `Write`, one that `Read` a `handoff-e2e.md`, then an auto compaction under `STATUS_PANE_KEEP=1`:
  both of its summarizer requests carry `Handoff files to re-read: - <dir>/notes/handoff-e2e.md` and `Files written or
  edited (newest first): - <dir>/out/result.txt`; unset, neither. A precompute cannot be driven in `-p`; the hook
  answers it in the engine rows only (31-12 to 31-15).
- Live probe (main session): loaded through `CLAUDE_CODE_PLUGIN_DIRS`, with the real
  `statusline.js` beside it, the context %, 5h %, 7d % and session cost agree (tokens, duration
  and lines drift while both write the cum file: see above); pane and tail draw at 200 columns,
  the tail at 120.

## Out of scope (phase 1)

No band. Tracker hooks stay (the mod reads their side files). `statusline.js` is not deleted.
agy is unaffected (no agy config references `statusline.js`).
