// Reader for the side file contract (claude-workbench contracts/side-file/SCHEMA.md, schema v1).
// Pure: bytes and a clock go in, a verdict comes out; I/O is injected and nothing here throws.
// Comments cite SCHEMA.md sections. The Python writer shares no code with this file on purpose.

import type { Res } from './state'

export type SideIo = {
  exists: (path: string) => Promise<boolean>
  readBytes: (path: string) => Promise<Uint8Array>
}

/** Section 4's seven verdicts, plus three the reader decides before it opens anything. */
export type NaVerdict =
  | 'missing'
  | 'corrupt'
  | 'malformed'
  | 'unsupported_version'
  | 'stale'
  | 'failed'
  | 'bad_name'
  | 'unknown_kind'
  | 'no_clock'

export type SideOk = {
  verdict: 'ok'
  kind: string
  producer: { id: string; host: string }
  station: string | null
  runId: string | null
  observedAtSec: number
  ageSec: number
  data: Record<string, unknown>
}

/** `text` is the contract's `n/a（...）`; `reason` is what is inside the brackets. */
export type SideNa = {
  verdict: NaVerdict
  text: string
  reason: string
  observedAtSec?: number
  lastSuccessAtSec?: number | null
}

export type SideResult = SideOk | SideNa

export type KindSpec = { cls: 'local' | 'synced'; ttlSec: number | null; finalTtlSec: number | null }

/** Section 9. A null TTL never expires; a null final TTL means `data.final` is ignored. */
export const KINDS: Record<string, KindSpec> = {
  fixture: { cls: 'local', ttlSec: 600, finalTtlSec: null },
  'sync-status': { cls: 'local', ttlSec: 900, finalTtlSec: null },
  'site-watch': { cls: 'local', ttlSec: 300, finalTtlSec: null },
  'review-lane': { cls: 'local', ttlSec: 300, finalTtlSec: 86_400 },
  waiting: { cls: 'synced', ttlSec: null, finalTtlSec: null },
}

export const SIDE_MAX_BYTES = 64 * 1024
export const SKEW_SEC = 300
const SUPPORTED_VERSIONS = [1]

const has = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const na = (verdict: NaVerdict, reason: string, extra: Partial<SideNa> = {}): SideNa => ({ verdict, text: `n/a（${reason}）`, reason, ...extra })
const bad = (violation: string): SideNa => na('malformed', `格式錯誤：${violation}`)

// ---- names and locations (section 5) ----

const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PART_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const CODE_RE = /^[a-z][a-z0-9_]{0,47}$/

/** `kind { "." part } ".json"`, at most two parts; null when the name is outside the grammar. */
export const parseSideName = (path: unknown): { kind: string; parts: string[] } | null => {
  if (typeof path !== 'string') return null
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (!name.endsWith('.json')) return null
  const pieces = name.slice(0, -'.json'.length).split('.')
  const [kind = '', ...parts] = pieces
  if (!KIND_RE.test(kind) || parts.length > 2 || !parts.every(p => PART_RE.test(p))) return null
  return { kind, parts }
}

export type SideLoc = { tmpdir?: string | undefined; home?: string | undefined; configDir?: string | undefined }
export type SideName = { scope?: string; host?: string }

const SYNCED_DIR = 'projects/-project/references/side-files'
const trimSlashes = (p: string): string => p.replace(/\/+$/, '')

/** Where a kind's file lives; null when the kind or a name part would not parse back. */
export const sideFilePath = (kind: string, loc: SideLoc, name: SideName = {}): string | null => {
  const spec = has(KINDS, kind) ? KINDS[kind] : undefined
  if (!spec) return null
  const parts: string[] = []
  if (spec.cls === 'synced') {
    if (name.host === undefined) return null
    parts.push(name.host)
  }
  if (name.scope !== undefined) parts.push(name.scope)
  // each part alone: 'a.b' joined would parse back as two parts
  if (!parts.every(p => PART_RE.test(p))) return null
  const file = `${[kind, ...parts].join('.')}.json`
  if (!parseSideName(file)) return null
  if (spec.cls === 'local') return `${trimSlashes(loc.tmpdir || '/tmp')}/claude-side/${file}`
  const config = loc.configDir || (loc.home ? `${trimSlashes(loc.home)}/.claude` : '')
  return config ? `${trimSlashes(config)}/${SYNCED_DIR}/${file}` : null
}

// ---- bytes ----

/** Stats before reading so a file past the limit is never pulled in; throws when it is too big. */
export const readBytesCapped = async (
  fs: { stat: (p: string) => Promise<{ size: number }>; read: (p: string) => Promise<{ base64: string }> },
  path: string,
): Promise<Uint8Array> => {
  if ((await fs.stat(path)).size > SIDE_MAX_BYTES) throw new Error('over the size limit')
  return bytesFromBase64((await fs.read(path)).base64) ?? new Uint8Array(0)
}

/** A reason as the card shows it: the reader's own `n/a（...）` text stays, any other is wrapped in that form. */
export const naReason = (why: string): string => (why.startsWith('n/a（') ? why : `n/a（${why}）`)

/** The longest base64 text a 64 KiB file can have; anything longer is not decoded. */
const B64_MAX = 4 * Math.ceil(SIDE_MAX_BYTES / 3)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64 to bytes; null for anything else. No atob: the engine's worker may not have it. */
export const bytesFromBase64 = (text: unknown): Uint8Array | null => {
  if (typeof text !== 'string' || text.length % 4 !== 0 || text.length > B64_MAX) return null
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const body = text.slice(0, text.length - pad)
  const out = new Uint8Array((text.length / 4) * 3 - pad)
  let acc = 0
  let bits = 0
  let n = 0
  for (const ch of body) {
    const v = B64.indexOf(ch)
    if (v < 0) return null
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return n === out.length ? out : null
}

/** Strict UTF-8 to a string: overlongs, surrogates, values past U+10FFFF and cut sequences give null. */
const utf8 = (b: Uint8Array): string | null => {
  const units: number[] = []
  let out = ''
  const flush = () => {
    out += String.fromCodePoint(...units)
    units.length = 0
  }
  for (let i = 0; i < b.length; ) {
    const c = b[i]!
    let need = 0
    let cp = 0
    let min = 0
    if (c < 0x80) cp = c
    else if (c >= 0xc2 && c <= 0xdf) [need, cp, min] = [1, c & 0x1f, 0x80]
    else if (c >= 0xe0 && c <= 0xef) [need, cp, min] = [2, c & 0x0f, 0x800]
    else if (c >= 0xf0 && c <= 0xf4) [need, cp, min] = [3, c & 0x07, 0x10000]
    else return null
    for (let k = 1; k <= need; k++) {
      const x = b[i + k]
      if (x === undefined || (x & 0xc0) !== 0x80) return null
      cp = (cp << 6) | (x & 0x3f)
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null
    units.push(cp)
    if (units.length >= 4096) flush()
    i += need + 1
  }
  flush()
  return out
}

// ---- time (section 3) ----

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/

const leap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** Epoch seconds of a `YYYY-MM-DDTHH:MM:SSZ` that is a real calendar moment, else null. Not Date.parse: it rolls over. */
export const parseStamp = (text: unknown): number | null => {
  const m = typeof text === 'string' ? STAMP_RE.exec(text) : null
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  if (y < 1 || mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null
  if (d < 1 || d > (mo === 2 && leap(y) ? 29 : MONTH_DAYS[mo - 1]!)) return null
  // days from civil (H. Hinnant), exact for the whole range
  const yy = mo <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  const days = era * 146_097 + doe - 719_468
  return days * 86_400 + h * 3600 + mi * 60 + s
}

/** An age as `45s`, `12m`, `4h`, `1h5m`, `3d2h`. */
export const ageText = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) {
    const m = Math.floor((s % 3600) / 60)
    return `${Math.floor(s / 3600)}h${m ? `${m}m` : ''}`
  }
  const h = Math.floor((s % 86_400) / 3600)
  return `${Math.floor(s / 86_400)}d${h ? `${h}h` : ''}`
}

// ---- the top-level schema_version literal (section 2) ----

const WS = ' \t\n\r'
const skipWs = (t: string, i: number): number => {
  while (i < t.length && WS.includes(t[i]!)) i++
  return i
}
const endOfString = (t: string, i: number): number => {
  i++
  while (i < t.length && t[i] !== '"') i += t[i] === '\\' ? 2 : 1
  return i + 1
}
const endOfValue = (t: string, i: number): number => {
  const c = t[i]
  if (c === '"') return endOfString(t, i)
  if (c === '{' || c === '[') {
    let depth = 0
    while (i < t.length) {
      const x = t[i]!
      if (x === '"') {
        i = endOfString(t, i)
        continue
      }
      if (x === '{' || x === '[') depth++
      if (x === '}' || x === ']') depth--
      i++
      if (depth === 0) break
    }
    return i
  }
  while (i < t.length && !',}] \t\n\r'.includes(t[i]!)) i++
  return i
}

/** The raw text of a top-level member of an already-validated JSON object (the last one wins, as in JSON.parse). */
const topLevelRaw = (text: string, wanted: string): string | null => {
  try {
    let i = skipWs(text, 0) + 1
    let found: string | null = null
    for (let guard = 0; guard <= text.length; guard++) {
      i = skipWs(text, i)
      if (text[i] === '}' || i >= text.length) break
      const keyEnd = endOfString(text, i)
      const key = JSON.parse(text.slice(i, keyEnd)) as string
      i = skipWs(text, keyEnd) + 1
      i = skipWs(text, i)
      const end = endOfValue(text, i)
      if (key === wanted) found = text.slice(i, end)
      i = skipWs(text, end)
      if (text[i] === ',') i++
    }
    return found
  } catch {
    return null
  }
}

// ---- judging one file (section 4) ----

const isControl = (cp: number): boolean => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029

const KEYS = ['kind', 'producer', 'station', 'run_id', 'observed_at', 'last_success_at', 'collection_status', 'error', 'data'] as const

/** The first section 2 violation as text, or the parsed stamps. */
const checkFields = (o: Record<string, unknown>, nameKind: string, parts: string[], spec: KindSpec) => {
  for (const key of KEYS) if (!has(o, key)) return bad(`缺少欄位 ${key}`)
  if (typeof o.kind !== 'string' || !KIND_RE.test(o.kind)) return bad('kind 格式不合')
  if (o.kind !== nameKind) return bad('kind 與檔名不符')
  const p = o.producer
  if (!isObject(p) || !has(p, 'id') || !has(p, 'host')) return bad('producer 不是 {id, host} 物件')
  if (typeof p.id !== 'string' || !LABEL_RE.test(p.id)) return bad('producer.id 不是 label')
  if (typeof p.host !== 'string' || !LABEL_RE.test(p.host)) return bad('producer.host 不是 label')
  for (const key of ['station', 'run_id'] as const) {
    const v = o[key]
    if (v !== null && (typeof v !== 'string' || !LABEL_RE.test(v))) return bad(`${key} 不是 label 或 null`)
  }
  const observed = parseStamp(o.observed_at)
  if (observed === null) return bad('observed_at 不是真實存在的 UTC 時刻')
  const last = o.last_success_at === null ? null : parseStamp(o.last_success_at)
  if (o.last_success_at !== null && last === null) return bad('last_success_at 不是真實存在的 UTC 時刻')
  const status = o.collection_status
  if (status !== 'ok' && status !== 'failed') return bad('collection_status 不是 ok 或 failed')
  let message: string | null = null
  if (o.error !== null) {
    const e = o.error
    if (!isObject(e) || !has(e, 'code') || !has(e, 'message')) return bad('error 不是 {code, message} 物件或 null')
    if (typeof e.code !== 'string' || !CODE_RE.test(e.code)) return bad('error.code 格式不合')
    const m = e.message
    if (typeof m !== 'string') return bad('error.message 不是字串')
    const points = Array.from(m)
    if (points.length < 1 || points.length > 200) return bad('error.message 長度不在 1 到 200 個 code point')
    if (points.some(c => isControl(c.codePointAt(0)!))) return bad('error.message 含控制字元')
    message = m
  }
  if (o.data !== null && !isObject(o.data)) return bad('data 不是物件或 null')
  if (status === 'ok') {
    if (o.error !== null) return bad('ok 的 error 必須是 null')
    if (o.data === null) return bad('ok 的 data 必須是物件')
    if (last !== observed) return bad('ok 的 last_success_at 必須等於 observed_at')
  } else {
    if (o.error === null) return bad('failed 的 error 必須是物件')
    if (o.data !== null) return bad('failed 的 data 必須是 null')
  }
  if (last !== null && last > observed) return bad('last_success_at 晚於 observed_at')
  if (spec.cls === 'synced' && parts[0] !== p.host) return bad('檔名的 host 不等於 producer.host')
  return { observed, last, status, message, producer: { id: p.id, host: p.host } }
}

/** Steps 2 to 8 on the bytes of a file whose name already parsed and whose kind is registered. */
const judge = (bytes: Uint8Array, nameKind: string, parts: string[], nowMs: number): SideResult => {
  const spec = KINDS[nameKind]!
  const corrupt = () => na('corrupt', '檔案損毀或被截斷')
  if (bytes.length === 0 || bytes.length > SIDE_MAX_BYTES) return corrupt()
  const text = utf8(bytes)
  if (text === null) return corrupt()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return corrupt()
  }
  if (!isObject(parsed)) return bad('頂層不是 JSON 物件')
  // 3: the literal of schema_version, which JSON.parse cannot tell from 1.0
  if (!has(parsed, 'schema_version')) return bad('schema_version 缺少')
  const literal = topLevelRaw(text, 'schema_version')
  if (literal === null || !/^-?(0|[1-9][0-9]*)$/.test(literal)) return bad('schema_version 不是 JSON 整數字面量')
  const version = Number(literal)
  if (parsed.schema_version !== version) return bad('schema_version 無法判定')
  if (version < 1 || Object.is(version, -0)) return bad('schema_version 小於 1')
  if (!SUPPORTED_VERSIONS.includes(version)) return na('unsupported_version', `版本不支援：v${literal.length > 12 ? '?' : literal}`)
  // 5
  const f = checkFields(parsed, nameKind, parts, spec)
  if ('verdict' in f) return f
  const aheadMs = f.observed * 1000 - nowMs
  if (aheadMs > SKEW_SEC * 1000) return bad('時鐘超前')
  const ageMs = Math.max(0, nowMs - f.observed * 1000)
  const data = parsed.data as Record<string, unknown> | null
  // 6: the final TTL only for a kind that has one and a boolean true
  const ttl = data !== null && data.final === true && spec.finalTtlSec !== null ? spec.finalTtlSec : spec.ttlSec
  const base = { observedAtSec: f.observed, lastSuccessAtSec: f.last }
  if (ttl !== null && ageMs > ttl * 1000) {
    const why = f.status === 'failed' ? `，最後一筆收集失敗：${f.message}` : ''
    return na('stale', `過期 ${ageText(ageMs / 1000)}${why}`, base)
  }
  // 7
  if (f.status === 'failed') {
    const since = f.last === null ? '從未成功' : `上次成功 ${ageText(nowMs / 1000 - f.last)}前`
    return na('failed', `收集失敗：${f.message}，${since}`, base)
  }
  return {
    verdict: 'ok',
    kind: nameKind,
    producer: f.producer,
    station: parsed.station as string | null,
    runId: parsed.run_id as string | null,
    observedAtSec: f.observed,
    ageSec: Math.floor(ageMs / 1000),
    data: data!,
  }
}

/** Reads and judges one side file; every failure is a classified n/a, never an exception. */
export const readSideFile = async (io: SideIo, path: string, nowMs: number): Promise<SideResult> => {
  try {
    const name = parseSideName(path)
    if (!name) return na('bad_name', '檔名不合文法，未開啟')
    if (!has(KINDS, name.kind)) return na('unknown_kind', `kind 未登記：${name.kind}`)
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return na('no_clock', '無法取得現在時刻')
    let there: unknown
    try {
      there = await io.exists(path)
    } catch {
      return na('corrupt', '檔案損毀或被截斷')
    }
    if (!there) return na('missing', '缺檔')
    let bytes: unknown
    try {
      bytes = await io.readBytes(path)
    } catch {
      return na('corrupt', '檔案損毀或被截斷')
    }
    if (!(bytes instanceof Uint8Array)) return na('corrupt', '檔案損毀或被截斷')
    return judge(bytes, name.kind, name.parts, nowMs)
  } catch {
    return na('corrupt', '檔案損毀或被截斷')
  }
}

/** Reads a kind from where its class puts it. */
export const readSideKind = async (io: SideIo, kind: string, loc: SideLoc, name: SideName, nowMs: number): Promise<SideResult> => {
  if (!has(KINDS, kind)) return na('unknown_kind', `kind 未登記：${String(kind).slice(0, 32)}`)
  const path = sideFilePath(kind, loc, name)
  return path === null ? na('bad_name', '路徑無法組出（檔名或位置不合）') : readSideFile(io, path, nowMs)
}

// ---- the fixture kind (section 9: data is { count: integer }) ----

export type FixtureData = { count: number; observedAtSec: number }

/** The fixture card's data: the count, or the contract's text; a count that is not an integer is n/a, never 0. */
export const fixtureOf = (r: SideResult): Res<FixtureData> => {
  if (r.verdict !== 'ok') return { ok: false, why: r.text }
  const count = r.data.count
  if (typeof count !== 'number' || !Number.isSafeInteger(count)) return { ok: false, why: 'n/a（格式錯誤：data.count 不是整數）' }
  return { ok: true, v: { count, observedAtSec: r.observedAtSec } }
}
