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

/** `~/.claude/cc-statusline-rows.json`: master switch plus one flag per row. */
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
      /** When a refresh last failed to write its snapshot; writing it makes the pane read the clock again. */
      checkedAt: number
    }
  }
}
