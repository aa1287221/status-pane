// The WAITING board (SCHEMA.md kind `waiting`, sections 7.1 and 9): reads every host's synced file and merges
// them. Pure except for the injected Io; imports only the reader and the state types, so model.ts and pane.ts can use it.

import { parseStamp as parseStampOf, readSideFile, sideFilePath } from './sidefile'
import type { SideIo, SideLoc, SideOk } from './sidefile'
import type { Res, Snap, WaitingData, WaitingDown } from './state'

/** `waiting.<host>.json` with exactly one part (SCHEMA 5.1); other names are never opened, as in waiting.py. */
export const WAITING_NAME_RE = /^waiting\.([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json$/

const MAX_FILES = 16
const MAX_ITEMS = 100
/** A `since` strictly more than this many seconds ago is due (SCHEMA 9). */
export const DUE_SEC = 604_800

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}-[0-9a-f]{8}$/
const URL_RE = /^https?:\/\/[^\s/?#@]+([/?#]\S*)?$/
const ITEM_KEYS = ['id', 'state', 'updated_at', 'since', 'what', 'links', 'closed_at', 'closed_by'] as const

export type WaitingIo = SideIo & { list: (path: string) => Promise<{ name: string }[]> }
export type RawItem = { id: string; state: 'open' | 'closed'; updatedSec: number; sinceSec: number; what: string; closedBy: string | null }
export type Merged = { id: string; state: 'open' | 'closed'; host: string; updatedSec: number; sinceSec: number; what: string }
export type WaitingRow = { id: string; host: string; age: string; date: string; due: boolean; what: string }
export type WaitingView = { rows: WaitingRow[]; total: number; due: number; down: WaitingDown[]; skipped: number }

const isControl = (cp: number): boolean => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029
const has = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The first SCHEMA 9 violation of one item (`第 n 筆 …`), or the item. */
const itemOf = (raw: unknown, n: number): RawItem | string => {
  const at = (key: string) => `第 ${n} 筆 ${key}`
  if (!isObject(raw)) return `第 ${n} 筆不是物件`
  for (const key of ITEM_KEYS) if (!has(raw, key)) return `第 ${n} 筆缺少 ${key}`
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return at('id 格式不合')
  if (raw.state !== 'open' && raw.state !== 'closed') return at('state 不是 open 或 closed')
  const updatedSec = parseStampOf(raw.updated_at)
  if (updatedSec === null) return at('updated_at 不是真實存在的時刻')
  const sinceSec = parseStampOf(raw.since)
  if (sinceSec === null) return at('since 不是真實存在的時刻')
  if (typeof raw.what !== 'string') return at('what 不是字串')
  const points = Array.from(raw.what)
  if (points.length < 1 || points.length > 200) return at('what 不是 1 到 200 個字元')
  if (points.some(c => isControl(c.codePointAt(0)!))) return at('what 含控制字元')
  if (raw.what.trim() === '') return at('what 只有空白')
  if (!Array.isArray(raw.links)) return at('links 不是陣列')
  if (raw.links.length > 5) return at('links 超過 5 個')
  for (const [i, link] of raw.links.entries()) {
    if (typeof link !== 'string') return at(`links[${i}] 不是字串`)
    if (Array.from(link).length > 300) return at(`links[${i}] 超過 300 個字元`)
    if (!URL_RE.test(link)) return at(`links[${i}] 不是 http(s) URL`)
  }
  if (raw.closed_at !== null && parseStampOf(raw.closed_at) === null) return at('closed_at 不是時刻或 null')
  if (raw.state === 'closed' && raw.closed_at === null) return at('closed 項目缺 closed_at')
  if (raw.closed_by !== null && typeof raw.closed_by !== 'string') return at('closed_by 不是字串或 null')
  return { id: raw.id, state: raw.state, updatedSec, sinceSec, what: raw.what, closedBy: raw.closed_by as string | null }
}

/** The items of an `ok` file (its `data.items`), or the first violation as `格式錯誤：…`. */
export const itemsOf = (r: SideOk): Res<RawItem[]> => {
  const list = r.data.items
  if (!Array.isArray(list)) return { ok: false, why: '格式錯誤：data.items 不是陣列' }
  const out: RawItem[] = []
  const ids = new Set<string>()
  for (const [i, raw] of list.entries()) {
    const it = itemOf(raw, i + 1)
    if (typeof it === 'string') return { ok: false, why: `格式錯誤：${it}` }
    if (ids.has(it.id)) return { ok: false, why: `格式錯誤：第 ${i + 1} 筆 id 與前面重複` }
    ids.add(it.id)
    out.push(it)
  }
  return { ok: true, v: out }
}

/** Which version of an item wins (SCHEMA 7.1): closed beats open; else the later updated_at; a tie goes to the larger host. */
const beats = (a: Merged, b: Merged): boolean => {
  if ((a.state === 'closed') !== (b.state === 'closed')) return a.state === 'closed'
  if (a.updatedSec !== b.updatedSec) return a.updatedSec > b.updatedSec
  return a.host > b.host
}

/** One winner per id across the hosts; open and closed winners both come back, the caller keeps the open ones. */
export const mergeBoard = (perHost: { host: string; items: RawItem[] }[]): Merged[] => {
  const best = new Map<string, Merged>()
  for (const { host, items } of perHost) {
    for (const it of items) {
      const cand: Merged = { id: it.id, state: it.state, host, updatedSec: it.updatedSec, sinceSec: it.sinceSec, what: it.what }
      const cur = best.get(it.id)
      if (!cur || beats(cand, cur)) best.set(it.id, cand)
    }
  }
  return [...best.values()]
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 60)

/** The synced directory: the place of the `waiting` kind, taken from sideFilePath so the two cannot drift. */
const dirOf = (loc: SideLoc): string | null => {
  const file = sideFilePath('waiting', loc, { host: 'probe' })
  return file === null ? null : file.slice(0, file.lastIndexOf('/'))
}

/** One host's file through the reader and the item rules: its items, or the `n/a（...）` text the card shows. */
const readHost = async (io: WaitingIo, path: string, host: string, nowMs: number): Promise<{ host: string; res: Res<RawItem[]> }> => {
  const r = await readSideFile(io, path, nowMs)
  if (r.verdict !== 'ok') return { host, res: { ok: false, why: r.text } }
  const its = itemsOf(r)
  return { host: r.producer.host, res: its.ok ? its : { ok: false, why: `n/a（${its.why}）` } }
}

/** The board as the card reads it: exists first (an absent dir is an empty board), list, the named files, read, merge. */
export const collectWaiting = async (io: WaitingIo, loc: SideLoc, nowMs: number): Promise<WaitingData> => {
  const dir = dirOf(loc)
  if (dir === null) throw new Error('無法取得設定目錄')
  if (!(await io.exists(dir))) return { items: [], openTotal: 0, down: [], skipped: 0 }
  let entries: { name: string }[]
  try {
    entries = await io.list(dir)
  } catch (err) {
    throw new Error(`目錄無法列出：${reasonOf(err)}`)
  }
  const names = entries.map(e => e.name).filter(n => WAITING_NAME_RE.test(n)).sort()
  const reads = await Promise.all(
    names.slice(0, MAX_FILES).map(name => readHost(io, `${dir}/${name}`, WAITING_NAME_RE.exec(name)![1]!, nowMs)),
  )
  const down: WaitingDown[] = []
  const perHost: { host: string; items: RawItem[] }[] = []
  for (const { host, res } of reads) {
    if (res.ok) perHost.push({ host, items: res.v })
    else down.push({ host, text: res.why })
  }
  const open = mergeBoard(perHost)
    .filter(m => m.state === 'open')
    .sort((a, b) => a.sinceSec - b.sinceSec || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    items: open.slice(0, MAX_ITEMS).map(m => ({ id: m.id, host: m.host, what: m.what, sinceSec: m.sinceSec })),
    openTotal: open.length,
    down,
    skipped: Math.max(0, names.length - MAX_FILES),
  }
}

/** The start date in the given zone, `YYYY-MM-DD`. */
const dateOf = (sec: number, tzMin: number): string => new Date((sec + tzMin * 60) * 1000).toISOString().slice(0, 10)

/** Age as the card shows it: `<1h` under an hour, `Nh` under a day, `Nd` from 24 h; a future `since` clamps to `<1h`. */
const ageOf = (ageSec: number): string => (ageSec < 3600 ? '<1h' : ageSec < 86_400 ? `${Math.floor(ageSec / 3600)}h` : `${Math.floor(ageSec / 86_400)}d`)

/** The rows and counts at the draw clock: age and due are computed here, never stored. */
export const waitingView = (data: WaitingData, nowMs: number, tzMin = 0): WaitingView => {
  const nowSec = Math.floor(nowMs / 1000)
  const rows = data.items.map((it): WaitingRow => {
    const ageSec = nowSec - it.sinceSec
    return { id: it.id, host: it.host, age: ageOf(Math.max(0, ageSec)), date: dateOf(it.sinceSec, tzMin), due: ageSec > DUE_SEC, what: it.what }
  })
  return { rows, total: data.openTotal, due: rows.filter(r => r.due).length, down: data.down, skipped: data.skipped }
}

/** The title value: `≥N` when a host is unreadable or files were skipped (the count is partial); `—` when nothing is readable. */
export const waitingHead = (v: WaitingView): { count: string; dueText: string | null } => {
  const partial = v.down.length > 0 || v.skipped > 0
  if (v.total === 0) return { count: v.down.length > 0 ? '—' : partial ? '≥0' : '0', dueText: null }
  return { count: `${partial ? '≥' : ''}${v.total}`, dueText: v.due > 0 ? `${v.due} due` : null }
}

/** The prompt tail segment, or null when there is no open item to count. */
export const waitingHint = (snap: Snap, nowMs: number): string | null => {
  const r = snap.waiting
  if (!r || !r.ok) return null
  const v = waitingView(r.v, nowMs)
  if (v.total === 0) return null
  const count = `${v.down.length > 0 || v.skipped > 0 ? '≥' : ''}${v.total}`
  return `WAIT ${count}${v.due > 0 ? ` (${v.due} due)` : ''}`
}
