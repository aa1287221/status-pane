// The in-flight count: running subagents of this session. No fixed limit; an optional threshold from the environment warns above it.
import type { Dispatch, Res } from './state'

/** The tracker never prunes `running`, so an entry older than this is a missed SubagentStop, not a live agent. */
export const DISPATCH_STALE_MS = 30 * 60_000

const MISSING = 'agents file missing'
const UNREADABLE = 'agents file unreadable'
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** STATUS_PANE_INFLIGHT_WARN: a positive safe integer turns the warning on; anything else (unset, empty, zero, junk) leaves it off. */
export const parseInflightWarn = (raw: string | undefined): number | null => {
  const t = (raw ?? '').trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return n > 0 && Number.isSafeInteger(n) ? n : null
}

/** The count from the tracker text: `null` (no file) and a file that is not a JSON object are both n/a, never 0. */
export const dispatchOf = (text: string | null, nowMs: number, warn: number | null = null): Res<Dispatch> => {
  if (text === null) return { ok: false, why: MISSING }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, why: UNREADABLE }
  }
  if (!isRecord(raw)) return { ok: false, why: UNREADABLE }
  let running = 0
  let stale = 0
  for (const info of Object.values(raw)) {
    if (!isRecord(info) || info.status !== 'running') continue
    const started = info.started
    if (typeof started === 'number' && !Number.isNaN(started) && nowMs - started <= DISPATCH_STALE_MS) running += 1
    else stale += 1
  }
  return { ok: true, v: { running, stale, warn } }
}
