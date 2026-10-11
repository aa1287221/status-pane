// The in-flight count: running subagents of this session against the limit of 6 (the 429 limit is account-wide).
import type { Dispatch, Res } from './state'

export const DISPATCH_LIMIT = 6
/** The tracker never prunes `running`, so an entry older than this is a missed SubagentStop, not a live agent. */
export const DISPATCH_STALE_MS = 30 * 60_000

const UNREADABLE = 'agents file unreadable'
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The count from the tracker text: `null` (no file yet) is 0; a file that is not a JSON object is unreadable. */
export const dispatchOf = (text: string | null, nowMs: number): Res<Dispatch> => {
  if (text === null) return { ok: true, v: { running: 0, stale: 0, limit: DISPATCH_LIMIT } }
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
  return { ok: true, v: { running, stale, limit: DISPATCH_LIMIT } }
}
