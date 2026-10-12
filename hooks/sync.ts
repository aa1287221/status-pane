// The SYNC card and its tail hint: the reader side of the sync-status kind (SCHEMA.md section 9, ticket #29).
// Pure: no I/O, no clock. Imports nothing from model.ts or pane.ts, so both can import this file.

import type { Res, Snap, SyncData } from './state'
import { SKEW_SEC, parseStamp } from './sidefile'
import type { SideResult } from './sidefile'

/** A fetch older than this is drawn yellow: `behind` is only as new as the last fetch. */
export const SYNC_FETCH_OLD_SEC = 86_400
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/
const HINT_MAX = 999

const violation = (key: string): { ok: false; why: string } => ({ ok: false, why: `n/a（格式錯誤：data.${key} 缺少或格式不合）` })

/** The card's data from a judged side file; a data rule violation is n/a with the first field named. */
export const syncOf = (r: SideResult, nowSec: number): Res<SyncData> => {
  if (r.verdict !== 'ok') return { ok: false, why: r.text }
  const d = r.data
  for (const key of ['branch', 'upstream'] as const) {
    const v = d[key]
    if (typeof v !== 'string' || !NAME_RE.test(v)) return violation(key)
  }
  for (const key of ['ahead', 'behind'] as const) {
    const v = d[key]
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return violation(key)
  }
  // a stamp may not be later than the moment it was written, nor than now, plus the same skew the reader allows
  const bound = Math.min(nowSec, r.observedAtSec) + SKEW_SEC
  const stamp = (key: 'last_push_at' | 'last_fetch_at'): Res<number | null> => {
    const raw = d[key]
    if (raw === null) return { ok: true, v: null }
    const sec = parseStamp(raw)
    return sec === null || sec > bound ? violation(key) : { ok: true, v: sec }
  }
  const push = stamp('last_push_at')
  if (!push.ok) return push
  const fetch = stamp('last_fetch_at')
  if (!fetch.ok) return fetch
  return {
    ok: true,
    v: {
      branch: d.branch as string,
      upstream: d.upstream as string,
      ahead: d.ahead as number,
      behind: d.behind as number,
      lastPushSec: push.v,
      lastFetchSec: fetch.v,
      observedAtSec: r.observedAtSec,
    },
  }
}

/** The headline: a check when in sync, the one side that differs, or both counts when diverged. */
export const syncHead = (v: { ahead: number; behind: number }): { text: string; tone: 'green' | 'yellow' | 'red' } => {
  if (v.ahead === 0 && v.behind === 0) return { text: '✓', tone: 'green' }
  if (v.ahead === 0) return { text: `-${v.behind} PULL`, tone: 'yellow' }
  if (v.behind === 0) return { text: `+${v.ahead} PUSH`, tone: 'yellow' }
  return { text: `+${v.ahead} -${v.behind}`, tone: 'red' }
}

const shown = (n: number): string => (n > HINT_MAX ? `${HINT_MAX}+` : String(n))

/** The tail segment, only when there is something to do; null for in sync, n/a, a row switched off, or the master switch off. */
export const syncHint = (snap: Snap | null): string | null => {
  if (!snap || !snap.toggles.enabled || !snap.toggles.rows.sync) return null
  const s = snap.sync
  if (!s || !s.ok) return null
  const { ahead, behind } = s.v
  if (ahead === 0 && behind === 0) return null
  if (ahead > 0 && behind > 0) return `SYNC +${shown(ahead)} -${shown(behind)} PULL`
  if (behind > 0) return `SYNC -${shown(behind)} PULL`
  return `SYNC +${shown(ahead)} PUSH`
}
