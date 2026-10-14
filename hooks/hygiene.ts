// The GIT HYGIENE card: the reader side of kind `git-hygiene` (SCHEMA.md section 9, ticket #151).
// Pure: no I/O, no clock. Imports nothing from model.ts or pane.ts, so both can import this file.

import type { HygieneData, Res } from './state'
import type { SideResult } from './sidefile'

/** The reader text for no file: the card says there is no record yet instead of showing it as a failure. */
export const HYGIENE_MISSING = 'n/a（缺檔）'

/** The card marks a record older than this as 舊; the reader itself never expires it (the kind has no TTL). */
export const HYGIENE_STALE_SEC = 1800

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

/** The card's data from a judged side file; a data rule violation is n/a with the first field named (the order of section 9). */
export const hygieneOf = (r: SideResult, nowSec: number): Res<HygieneData> => {
  if (r.verdict === 'missing') return { ok: false, why: HYGIENE_MISSING }
  if (r.verdict !== 'ok') return { ok: false, why: r.text }
  const d = r.data
  if (d.event !== 'commit' && d.event !== 'push') return { ok: false, why: 'n/a（格式錯誤：data.event 不是 commit 或 push）' }
  const repo = text(d.repo, 'repo', 1, 512)
  if (repo !== null) return { ok: false, why: `n/a（格式錯誤：${repo}）` }
  const first = text(d.first_line, 'first_line', 1, 200)
  if (first !== null) return { ok: false, why: `n/a（格式錯誤：${first}）` }
  if (!Array.isArray(d.lines) || d.lines.length < 1 || d.lines.length > 40) return { ok: false, why: 'n/a（格式錯誤：data.lines 不是 1 到 40 行的陣列）' }
  for (const [i, line] of d.lines.entries()) {
    const bad = text(line, `lines[${i}]`, 0, 300)
    if (bad !== null) return { ok: false, why: `n/a（格式錯誤：${bad}）` }
  }
  return {
    ok: true,
    v: {
      event: d.event,
      repo: d.repo as string,
      firstLine: d.first_line as string,
      lines: d.lines as string[],
      observedAtSec: r.observedAtSec,
      ageSec: Math.max(0, Math.floor(nowSec - r.observedAtSec)),
    },
  }
}
