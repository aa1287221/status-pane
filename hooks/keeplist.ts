// Pure decisions and builders for the session.compact keep-list. No `$`, no clock, no env.
// STUB of #31: the final names and types with wrong answers, so the red run fails on assertions, not on imports.
import type { KeepLast, KeepState, KeepTrigger, KeptFiles } from './state'

export const KEEP_MARK = ''
export const KEEP_CAP = 0
export const KEEP_DEADLINE_MS = 0
export const TASKS_MAX = 0
export const FILES_KEPT = 0
export const FILES_LISTED = 0
export const HANDOFFS_MAX = 0
export const SUBJECT_MAX = 0
export const PATH_MAX = 0
export const TASK_FILES_MAX = 0
export const TASK_BYTES_MAX = 0

export type KeepMode = 'observe' | 'on' | 'off'
export type KeepConfig = { mode: KeepMode; precompute: 'skip' | 'rewrite' }
export type TaskItem = { id: string; subject: string; status: 'pending' | 'in_progress' }
/** A task file that is not kept; `problem` says whether that is worth telling (a finished task is not). */
export type TaskDrop = { drop: string; problem: boolean }
export type KeepSrc = { tasks: readonly TaskItem[]; moreTasks?: number; files: readonly string[]; handoffs: readonly string[] }
export type Built = { text: string; counts: { tasks: number; files: number; handoffs: number }; dropped: number }
export type Decision = { action: 'pass' | 'rewrite' | 'skip'; why: string; would: 'rewrite' | 'skip' | null }
export type DecideIn = { trigger: string; agentId: string | undefined; cfg: KeepConfig; hasMark: boolean; hasKeep: boolean }
export type TaskEnv = { CLAUDE_CONFIG_DIR?: string | undefined; HOME?: string | undefined; CLAUDE_CODE_TASK_LIST_ID?: string | undefined }

export const keepConfig = (_modeRaw: string | undefined, _precomputeRaw: string | undefined): KeepConfig => ({ mode: 'observe', precompute: 'skip' })
export const sanitize = (_text: string, _maxPoints: number): string => ''
export const parseTaskFile = (_text: string): TaskItem | TaskDrop => ({ drop: '', problem: false })
export const tasksOf = (_items: readonly TaskItem[]): { items: TaskItem[]; more: number } => ({ items: [], more: 0 })
export const callPath = (_tool: string, _input: Record<string, unknown>): unknown => undefined
export const outputKind = (_tool: string, _path: unknown): 'out' | 'handoff' | null => null
export const recordPath = (_prev: KeptFiles | null, _sid: string, _tool: string, _path: unknown): KeptFiles | null => null
export const buildKeep = (_src: KeepSrc): Built | null => null
export const withKeep = (_userInstr: string | null | undefined, _keepText: string): string => ''
export const decideCompact = (_i: DecideIn): Decision => ({ action: 'rewrite', why: '', would: null })
export const taskDirOf = (_env: TaskEnv, _sessionId: string): { dir: string } | { why: string } => ({ why: '' })
export const nextKeepState = (_prev: KeepState | null, _i: { sid: string; cfg: KeepConfig; trigger: KeepTrigger; last: KeepLast }): KeepState => ({
  sid: '',
  mode: 'off',
  precompute: 'rewrite',
  seen: { manual: 0, auto: 0, plugin: 0, precompute: 0 },
  last: null,
})
export const keepLabel = (_s: KeepState): string => ''
export const keepReport = (_s: KeepState | null, _cfg: KeepConfig): string => ''
