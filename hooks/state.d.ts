// Contract of the values `status-pane` keeps in $.state, plus the plain-data types they hold.
// Everything here is JSON data: absent means `null`, never `undefined`.

/** One collector's outcome: its value, or a short reason the row reads `n/a (...)`. */
export type Res<T> = { ok: true; v: T } | { ok: false; why: string }

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
  | 'fixture'

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

export type CpuSample = { idle: number; total: number }

export type MemInfo = { usedKb: number; totalKb: number; pct: number }

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
  context: Res<{ pct: number | null; used: number; max: number; compacts: Res<number> }>
  tokens: Res<{ all: number; session: number }>
  quota: Res<{ five: QuotaWindow; seven: QuotaWindow }>
  cpu: Res<number | null>
  ram: Res<MemInfo>
  memory: Res<string[]>
  mcp: Res<McpInfo | null>
  edited: Res<string[]>
  /** The side file demo card (SCHEMA.md kind `fixture`); absent unless the `fixture` row is on. `observedAtSec` is epoch seconds. */
  fixture?: Res<{ count: number; observedAtSec: number }>
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
      /** When a refresh last failed to write its snapshot; writing it makes the pane read the clock again. */
      checkedAt: number
    }
  }
}
