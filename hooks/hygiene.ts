// The GIT HYGIENE card: the reader side of kind `git-hygiene` (SCHEMA.md section 9, ticket #151, data v2).
// Pure: no I/O, no clock. Imports nothing from model.ts or pane.ts, so both can import this file.

import type { HygieneData, Res } from './state'
import { parseStamp } from './sidefile'
import type { SideResult } from './sidefile'

/** The reader text for no file: the card says there is no record yet instead of showing it as a failure. */
export const HYGIENE_MISSING = 'n/a（缺檔）'

/** The card marks an entry older than this as 舊; the reader itself never expires it (the kind has no TTL). */
export const HYGIENE_STALE_SEC = 1800

/** The most entries a record holds (the producer keeps five). */
const MAX_ENTRIES = 5
const MAX_LINES = 12

const isControl = (cp: number): boolean => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029

const points = (s: string): number => Array.from(s).length

/** A string of `min` to `max` code points with no control character, else the violation text. */
const text = (v: unknown, key: string, min: number, max: number): string | null => {
  if (typeof v !== 'string') return `data.${key} 不是字串`
  const n = points(v)
  if (n < min || n > max) return `data.${key} 長度不在 ${min} 到 ${max} 個 code point`
  if (Array.from(v).some(c => isControl(c.codePointAt(0)!))) return `data.${key} 含控制字元`
  return null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The first violation of one entry, in the order of section 9 (event, repo, first_line, lines, at, source); null when it holds. */
const entryViolation = (e: unknown, i: number, observedSec: number, prevSec: number | null): string | null => {
  const at = `entries[${i}]`
  if (!isObject(e)) return `data.${at} 不是物件`
  if (e.event !== 'commit' && e.event !== 'push') return `data.${at}.event 不是 commit 或 push`
  const repo = text(e.repo, `${at}.repo`, 1, 512)
  if (repo !== null) return repo
  const first = text(e.first_line, `${at}.first_line`, 1, 200)
  if (first !== null) return first
  if (!Array.isArray(e.lines) || e.lines.length < 1 || e.lines.length > MAX_LINES) return `data.${at}.lines 不是 1 到 ${MAX_LINES} 行的陣列`
  for (const [j, line] of e.lines.entries()) {
    const bad = text(line, `${at}.lines[${j}]`, 0, 200)
    if (bad !== null) return bad
  }
  const atSec = parseStamp(e.at)
  if (atSec === null) return `data.${at}.at 不是真實存在的 UTC 時刻`
  if (i === 0 && atSec !== observedSec) return `data.${at}.at 必須等於 observed_at`
  if (prevSec !== null && atSec > prevSec) return `data.${at}.at 晚於前一筆`
  if (e.source !== 'main' && e.source !== 'subtask') return `data.${at}.source 不是 main 或 subtask`
  return null
}

/** The card's data from a judged side file; a data rule violation is n/a with the first field named (the order of section 9). */
export const hygieneOf = (r: SideResult, nowSec: number): Res<HygieneData> => {
  if (r.verdict === 'missing') return { ok: false, why: HYGIENE_MISSING }
  if (r.verdict !== 'ok') return { ok: false, why: r.text }
  const list = r.data.entries
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ENTRIES) return { ok: false, why: 'n/a（格式錯誤：data.entries 不是 1 到 5 筆的陣列）' }
  const entries: HygieneData['entries'] = []
  let prevSec: number | null = null
  for (const [i, e] of list.entries()) {
    const bad = entryViolation(e, i, r.observedAtSec, prevSec)
    if (bad !== null) return { ok: false, why: `n/a（格式錯誤：${bad}）` }
    const obj = e as Record<string, unknown>
    const atSec = parseStamp(obj.at)!
    prevSec = atSec
    entries.push({
      event: obj.event as string,
      repo: obj.repo as string,
      firstLine: obj.first_line as string,
      lines: obj.lines as string[],
      atSec,
      ageSec: Math.max(0, Math.floor(nowSec - atSec)),
      source: obj.source as 'main' | 'subtask',
    })
  }
  return { ok: true, v: { entries } }
}
