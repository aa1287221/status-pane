// Contract of the values `status-pane` keeps in $.state, plus the plain-data types they hold.
// Everything here is JSON data: absent means `null`, never `undefined`.

/** One collector's outcome: its value, or a short reason the row reads `n/a (...)`. */
export type Res<T> = { ok: true; v: T } | { ok: false; why: string }

/** The in-flight count of this session's subagents (`dispatchOf` in dispatch.ts); `warn` is STATUS_PANE_INFLIGHT_WARN, null for none. */
export type Dispatch = { running: number; stale: number; warn: number | null }

export type RowKey =
  | 'summary'
  | 'dir'
  | 'repo'
  | 'model'
  | 'cost'
  | 'usage'
  | 'quota'
  | 'agents'
  | 'memory_mcp'
  | 'sys'
  | 'edited'
  | 'history'
  | 'progress'
  | 'sync'
  | 'fixture'
  | 'waiting'
  | 'hygiene'

/** `~/.claude/cc-statusline-rows.json`: master switch plus one flag per row (`fixture` is off unless the file turns it on with the boolean true). */
export type Toggles = { enabled: boolean; rows: Record<RowKey, boolean> }

export type GitCounts = { added: number; modified: number; untracked: number }

/** `status` has its own outcome, so a slow or failing `git status` keeps the branch. */
/** `notRepo` is set when the directory is in no repository, so a missing branch can be told from a repository with none. */
export type GitInfo = { branch: string; repo: string; status: Res<GitCounts>; notRepo?: boolean }

export type AgentGroup = { name: string; running: number; done: number; latest: number }

/** `pct` is null when no session has a live reading for the window: unknown, not 0. */
export type QuotaWindow = { pct: number | null; resetSec: number | null }

export type McpInfo = { total: number; healthy: number; bad: { name: string; isAuth: boolean }[] }

/** Whether each tracker hook the data files come from is wired in the settings (see HOOK_SCRIPTS in model.ts). */
export type HookVerdicts = { agents: boolean; edited: boolean; summary: boolean; messages: boolean; compact: boolean }

/** A tool call of the main loop that has started and not yet ended; `startedAt` is epoch ms. */
export type ToolRun = { id: string; tool: string; startedAt: number }

/** The calls in flight for one session, kept by the plugin's own `tool.call` hook (never from a tracker file). */
export type NowState = { sid: string; calls: ToolRun[] }

/** What a background task or schedule is, from the engine's own `type`; `cron` is a `session_crons` entry. */
export type BgKind = 'shell' | 'subagent' | 'monitor' | 'workflow' | 'other' | 'cron'

/** A background task or schedule the last Stop snapshot listed. `since` is epoch ms; `exact` is false when it is only the Stop that first listed it. */
export type BgItem = { id: string; kind: BgKind; label: string; since: number; exact: boolean }

/** A background call this session made since the last Stop; the snapshot lists what survived, these only date it. `id` is the task its result named; `veto` is a call that may own a listed item but cannot date it. */
export type BgStart = { kind: 'shell' | 'subagent' | 'cron'; at: number; id?: string; veto?: true }

/** Background work for one session: the last Stop snapshot (`seenAt`, null until one arrives) and the starts since. `dropped` is set when the cap evicted a start since the last Stop. */
export type InflightState = { sid: string; seenAt: number | null; items: BgItem[]; starts: BgStart[]; dropped?: true }

/** The CONTEXT hint's state: the threshold and mode read at the last measure, and what the box answered (`isShown` null when not asked). */
export type CompactState = {
  sid: string
  mode: 'observe' | 'suggest' | 'off'
  atPct: number
  armed: boolean
  last: { at: number; isShown: boolean | null; why?: string; would?: string } | null
}

/** What can compact a conversation (the engine's `session.compact` triggers). */
export type KeepTrigger = 'manual' | 'auto' | 'plugin' | 'precompute'

/** One compaction as the keep-list hook handled it. `would` is what mode `on` would have done; `text` is the block (at most 1500 characters). */
export type KeepLast = {
  at: number
  trigger: KeepTrigger
  action: 'pass' | 'rewrite' | 'skip'
  why: string
  would: 'rewrite' | 'skip' | null
  /** Items in the block, by section. */
  counts: { tasks: number; files: number; handoffs: number }
  /** Items left out of the block by the item and character caps; `gone` is recorded files no longer on disk. */
  dropped: number
  gone: number
  chars: number
  text: string
  /** What each section was read from, in words: path, entries read, why it is empty. */
  sources: { tasks: string; files: string; handoffs: string }
  /** What could not be read or understood; a directory that is not there is not one. */
  problems: string[]
}

/** The keep-list's state: the switches read at the last compaction, how many compactions of each trigger it saw, and the last decision. */
export type KeepState = {
  sid: string
  mode: 'observe' | 'on' | 'off'
  precompute: 'skip' | 'rewrite'
  seen: Record<KeepTrigger, number>
  last: KeepLast | null
}

/** Paths this session's tool calls produced, newest first: a compaction takes the calls out of the transcript, so they are kept here. */
export type KeptFiles = { sid: string; files: string[]; handoffs: string[] }

/** One open item on the WAITING board; `sinceSec` is epoch seconds, the age and due flag are drawn at the draw clock. */
export type WaitingItem = { id: string; host: string; what: string; sinceSec: number }

/** A host whose WAITING file cannot be used; `text` is the reader's `n/a（...）`. */
export type WaitingDown = { host: string; text: string }

/** The open items (since ascending, at most 100; `openTotal` counts them all), the unreadable hosts, and the files past the 16-file cap. */
export type WaitingData = { items: WaitingItem[]; openTotal: number; down: WaitingDown[]; skipped: number }

export type CpuSample = { idle: number; total: number }

export type MemInfo = { usedKb: number; totalKb: number; pct: number }

/** The SYNC card (SCHEMA.md kind `sync-status`, #29): ahead and behind of sync-data-v2 against its last fetch; stamps are epoch seconds or null. */
export type SyncData = { branch: string; upstream: string; ahead: number; behind: number; lastPushSec: number | null; lastFetchSec: number | null; observedAtSec: number }

/** The GIT HYGIENE card: the last warning the commit or push hook recorded (kind `git-hygiene`, #151). */
export type HygieneData = { event: string; repo: string; firstLine: string; lines: string[]; observedAtSec: number; ageSec: number }

/** Everything the pane and the tail draw from; written by one refresh. */
export type Snap = {
  at: number
  errors: number
  toggles: Toggles
  summary: Res<string>
  dir: Res<string>
  git: Res<GitInfo>
  lines: Res<{ add: number; rm: number }>
  /** `configured` is true when `effort` is the one the settings name, not a level a hook reported (drawn dim); a snapshot older than this field has none. */
  model: Res<{ name: string; version: string; effort: string | null; configured?: boolean }>
  cost: Res<{ all: number; session: number; durMin: number }>
  agents: Res<AgentGroup[]>
  /** `max` is the model's window. `autoCompact` is the window the engine compacts at when settings or the environment set one, else `max`; a snapshot older than this field has none. */
  context: Res<{ pct: number | null; used: number; max: number; compacts: Res<number>; autoCompact?: { window: number; source: 'env' | 'settings' | 'window' } }>
  tokens: Res<{ all: number; session: number }>
  quota: Res<{ five: QuotaWindow; seven: QuotaWindow }>
  cpu: Res<number | null>
  ram: Res<MemInfo>
  memory: Res<string[]>
  mcp: Res<McpInfo | null>
  edited: Res<string[]>
  /** The side file demo card (SCHEMA.md kind `fixture`); absent unless the `fixture` row is on. `observedAtSec` is epoch seconds. */
  fixture?: Res<{ count: number; observedAtSec: number }>
  /** The in-flight count from the agents tracker; absent when the agents row is off. Optional so older snapshots stay valid. */
  dispatch?: Res<Dispatch>
  /** The WAITING board (SCHEMA.md kind `waiting`); absent unless the `waiting` row is on. */
  waiting?: Res<WaitingData>
  /** The SYNC card and tail hint; absent unless the `sync` row is on. */
  sync?: Res<SyncData>
  /** The GIT HYGIENE card (kind `git-hygiene`, #151); absent unless the `hygiene` row is on. */
  hygiene?: Res<HygieneData>
  /** What the settings said of the tracker hooks at this refresh; kept when a later read fails. */
  hooks: HookVerdicts
}

declare module 'claude-code' {
  interface PluginState {
    'status-pane': {
      snap: Snap | null
      /** Newest `effort.level` a main-loop classic hook input carried, and the session it came from. */
      effort: { sid: string; level: string } | null
      /** Lines the tool hooks counted that no cum write has persisted yet, for one session. */
      pending: { sid: string; add: number; rm: number }
      /** Sum of `output_tokens` over the main loop's `turn.complete` usages, for one session. */
      outTokens: { sid: string; n: number }
      /** Previous `/proc/stat` sample, for the CPU delta. */
      cpu: CpuSample | null
      /** The last 16 CPU readings (percent, oldest first): one per refresh, none for a reading that was n/a. */
      cpuHist: number[]
      /** Main-loop tool calls in flight; null until a hook has written it since the plugin loaded. */
      now: NowState | null
      /** Background tasks and schedules from the Stop snapshot; null until a hook has written it since the plugin loaded. */
      inflight: InflightState | null
      /** The /compact suggestion for the context fill, written at each `session.measure` that moved context; null until one has. */
      compact: CompactState | null
      /** The session.compact keep-list: what the hook saw and decided at the last compaction; null until one has. */
      keep: KeepState | null
      /** Files this session wrote or edited and its handoff files, from the `tool.call` hook; read when a compaction is about to run. */
      kept: KeptFiles
      /** When a refresh last failed to write its snapshot; writing it makes the pane read the clock again. */
      checkedAt: number
    }
  }
}
