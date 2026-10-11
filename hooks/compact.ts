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

// Stubs that keep the model's window; the resolver replaces them.
export const envWindow = (_raw: string | undefined): number | null => null
export const canonModel = (name: string): string => name
export const settingsWindow = (_sources: readonly unknown[], _model: string | undefined): number | 'auto' | null => null
export const effectiveWindow = (a: { window: number | undefined; model: string | undefined; env: string | undefined; sources: readonly unknown[] }): EffectiveWindow | null =>
  typeof a.window === 'number' && Number.isFinite(a.window) && a.window > 0 ? { window: a.window, source: 'window' } : null
