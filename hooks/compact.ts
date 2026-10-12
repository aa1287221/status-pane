// Pure decisions for the CONTEXT hint and the /compact suggestion. No `$`, no clock, no env.
import type { CompactState } from './state'

/** Pre-filled into the box, never run: the person tabs it in and presses Enter. */
export const COMPACT_TEXT = '/compact focus on decisions, open tasks, changed files and where outputs are'

export const DEFAULT_AT = 60

export type Mode = 'observe' | 'suggest' | 'off'
export type CompactConfig = { atPct: number; mode: Mode }
export type Advice = { pct: number; atPct: number }

/** `tokens / window`, never the engine's `percent`: that one is an integer and reads 0 at small usage. */
export const fillOf = (c: { tokens?: number; window?: number }): number | null => {
  const { tokens, window } = c
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return null
  return tokens / window
}

/** Only whole numbers 1..99 set the threshold; `1` turns suggest on, `0` is the bypass. */
export const compactConfig = (atRaw: string | undefined, modeRaw: string | undefined): CompactConfig => {
  const n = atRaw !== undefined && /^\d{1,2}$/.test(atRaw) ? Number(atRaw) : NaN
  const atPct = n >= 1 && n <= 99 ? n : DEFAULT_AT
  const mode: Mode = modeRaw === '1' ? 'suggest' : modeRaw === '0' ? 'off' : 'observe'
  return { atPct, mode }
}

/** At or over the line (inclusive); `atPct / 100` is the same double as the ratio of the same tokens, so the edge is exact. */
export const adviceOf = (fill: number | null, cfg: { atPct: number }): Advice | null => {
  if (fill === null || fill < cfg.atPct / 100) return null
  return { pct: Math.round(fill * 100), atPct: cfg.atPct }
}

/** Fires once per crossing; a drop under the line re-arms it, as a /compact does. */
export const shouldSuggest = (prev: CompactState | null, sid: string, fill: number | null, cfg: CompactConfig): { fire: boolean; next: CompactState } => {
  const base: CompactState = prev && prev.sid === sid ? prev : { sid, mode: cfg.mode, atPct: cfg.atPct, armed: true, last: null }
  const next: CompactState = { ...base, mode: cfg.mode, atPct: cfg.atPct }
  if (fill === null || cfg.mode === 'off') return { fire: false, next }
  if (fill < cfg.atPct / 100) return { fire: false, next: { ...next, armed: true } }
  if (!next.armed) return { fire: false, next }
  return { fire: true, next: { ...next, armed: false } }
}

/** The mode line of the card: what the switch says, and what the box answered last. */
export const modeLabel = (c: CompactState): string => {
  if (c.mode === 'off') return 'off'
  if (c.mode === 'observe') return 'observe'
  if (c.last?.isShown === true) return 'on · shown'
  if (c.last?.isShown === false) return 'on · not shown'
  return 'on · pending'
}

/** The engine's bounds for an auto-compact window: a value outside them is dropped (100000 and 1000000 stand). */
export const WINDOW_MIN = 100_000
export const WINDOW_MAX = 1_000_000

export type WindowSource = 'env' | 'settings' | 'window'
export type EffectiveWindow = { window: number; source: WindowSource }

const recordOf = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

// The engine's reader for the variable: an exponent form, a thousands-marked form, else the leading integer.
const EXPONENT = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/
const MARKED = /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/
const MARKS = /[_,\u00A0\u202F ]/g

const engineInt = (text: string): number => {
  const s = text.trim()
  if (s.length <= 32) {
    if (EXPONENT.test(s)) {
      const n = Number(s)
      return Number.isInteger(n) ? n : Number.NaN
    }
    if (MARKED.test(s)) return parseInt(s.replace(MARKS, ''), 10)
  }
  return parseInt(s, 10)
}

/** `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as the engine reads it: unreadable or not above 0 is skipped, the rest is floored at 100000 and capped at 1000000. */
export const envWindow = (raw: string | undefined): number | null => {
  if (!raw) return null
  const n = engineInt(raw)
  if (Number.isNaN(n) || n <= 0) return null
  return Math.max(WINDOW_MIN, Math.min(WINDOW_MAX, n))
}

/** A model reduced to the name the settings key it by: dated, [1m], Vertex, Bedrock and any case all name one model; a prefix names another. */
export const canonModel = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/(\[[^\]]*\])+$/, '')
    .replace(/^(?:[a-z0-9-]+\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{8}$/, '')

const validWindow = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= WINDOW_MIN && v <= WINDOW_MAX ? v : null)

/** One file's say for the model `key`: its entry (a number, or "auto"), else the top-level number. */
const fileWindow = (file: unknown, key: string | null): number | 'auto' | null => {
  const rec = recordOf(file)
  if (rec === null) return null
  let first: number | 'auto' | null = null
  if (key !== null) {
    for (const [name, entry] of Object.entries(recordOf(rec.modelSettings) ?? {})) {
      if (canonModel(name) !== key) continue
      const v = recordOf(entry)?.autoCompactWindow
      const w = v === 'auto' ? 'auto' : validWindow(v)
      if (w === null) continue
      // the canonical spelling wins over any other, else the first
      if (name === key) return w
      first ??= w
    }
  }
  return first ?? validWindow(rec.autoCompactWindow)
}

/** The window the settings name for `model`; `sources` come highest precedence first and the first with a say decides. null when none has. */
export const settingsWindow = (sources: readonly unknown[], model: string | undefined): number | 'auto' | null => {
  const key = model === undefined || model.trim() === '' ? null : canonModel(model)
  for (const file of sources) {
    const w = fileWindow(file, key)
    if (w !== null) return w
  }
  return null
}

/** The highest source that names a boolean decides whether auto-compact is on. */
const autoCompactOn = (sources: readonly unknown[]): boolean => {
  for (const file of sources) {
    const v = recordOf(file)?.autoCompactEnabled
    if (typeof v === 'boolean') return v
  }
  return true
}

/**
 * The window the line is taken of: what the engine compacts at, never wider than the model's `window`. The variable comes
 * first, then the settings (only while auto-compact is on), then the model's own. null when the window itself is unknown.
 */
export const effectiveWindow = (a: { window: number | undefined; model: string | undefined; env: string | undefined; sources: readonly unknown[] }): EffectiveWindow | null => {
  const full = a.window
  if (typeof full !== 'number' || !Number.isFinite(full) || full <= 0) return null
  const env = envWindow(a.env)
  if (env !== null) return { window: Math.min(full, env), source: 'env' }
  if (autoCompactOn(a.sources)) {
    const set = settingsWindow(a.sources, a.model)
    if (typeof set === 'number') return { window: Math.min(full, set), source: 'settings' }
  }
  return { window: full, source: 'window' }
}
