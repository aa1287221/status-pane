// Pure functions behind status-pane: no $ calls, so every path runs offline.

import type { AgentGroup, BgItem, BgKind, BgStart, InflightState, CpuSample, HookVerdicts, McpInfo, MemInfo, NowState, Res, RowKey, Snap, Toggles, ToolRun } from './state'
import { waitingHint } from './waiting'

/** The first line of a failure, less the `<plugin>: $.fs.read: ` the engine puts in front of a refused call. */
export const why = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err)
  const line = (raw.split('\n')[0] ?? '').replace(/^[\w-]+: \$\.[\w.]+: /, '').replace(/^\w*Error:\s*/, '')
  return line.slice(0, 60) || 'failed'
}

/** What a draw that failed says in place of the pane. */
export const cannotDraw = (err: unknown): string => `cannot draw: ${why(err)}`.slice(0, 60)

/** Same cut as the tracker hooks and statusline.js L141, so side files share a name. */
export const sidOf = (sessionId: string): string =>
  (sessionId || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)

export type Counter = { total: number; base: number }

/** statusline.js L165-170: growth adds to the total, a drop only re-baselines. */
export const step = (c: Counter, cur: number): Counter =>
  cur >= c.base ? { total: c.total + (cur - c.base), base: cur } : { total: c.total, base: cur }

export type Cum = { cost: Counter; dur: Counter; add: Counter; rm: Counter; tok: Counter }

export const emptyCum = (): Cum => ({
  cost: { total: 0, base: 0 },
  dur: { total: 0, base: 0 },
  add: { total: 0, base: 0 },
  rm: { total: 0, base: 0 },
  tok: { total: 0, base: 0 },
})

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Reads a cum file; the old flat `{cost: n}` form migrates to total = base = n (L159-163). A text that is
 * not a JSON object is null, so a caller never mistakes a damaged file for a fresh one.
 */
export const parseCumStrict = (text: string): Cum | null => {
  let stored: unknown
  try {
    stored = JSON.parse(text)
  } catch {
    return null
  }
  const from = asRecord(stored)
  if (!from) return null
  const cum = emptyCum()
  for (const key of Object.keys(cum) as (keyof Cum)[]) {
    const v = from[key]
    if (typeof v === 'number') cum[key] = { total: num(v), base: num(v) }
    else if (typeof v === 'object' && v !== null) {
      const c = v as Record<string, unknown>
      cum[key] = { total: num(c.total), base: num(c.base) }
    }
  }
  return cum
}

/** The tolerant reading: a missing or damaged file is a fresh one (what other sessions' totals use). */
export const parseCum = (text: string | null): Cum => (text === null ? null : parseCumStrict(text)) ?? emptyCum()

/** Key order and spacing of statusline.js L171, so a rollback reads the same bytes. */
export const cumJson = (cum: Cum): string =>
  JSON.stringify({ cost: cum.cost, dur: cum.dur, add: cum.add, rm: cum.rm, tok: cum.tok })

export type RlWindow = { used_percentage: number; resets_at: number }
export type RlSnap = { t: number; five_hour: RlWindow | null; seven_day: RlWindow | null }
export type RlSnaps = Record<string, RlSnap>
export type RlField = 'five_hour' | 'seven_day'

const RL_STALE_SEC = 300
const RL_MAX_FUTURE_SEC = 8 * 86_400

const isFresh = (snap: RlSnap | undefined, nowSec: number): boolean =>
  !!snap && !!snap.t && nowSec - snap.t <= RL_STALE_SEC

/** The snapshot file after this session wrote its entry: stale and tless entries are dropped (L211-219). */
export const mergeSnap = (snaps: RlSnaps, sid: string, mine: RlSnap, nowSec: number): RlSnaps => {
  const out: RlSnaps = {}
  for (const [k, v] of Object.entries(snaps)) if (k !== sid && isFresh(v, nowSec)) out[k] = v
  out[sid] = mine
  return out
}

/**
 * Highest used % across sessions within the newest live window (L235-257); nowSec is a parameter
 * so a test can pin it.
 */
export const aggMaxOrNull = (snaps: RlSnaps, field: RlField, own: RlWindow | null, nowSec: number): number | null => {
  const live: RlWindow[] = []
  for (const snap of Object.values(snaps)) {
    const w = snap?.[field]
    if (
      isFresh(snap, nowSec) &&
      w &&
      typeof w.used_percentage === 'number' &&
      w.resets_at > nowSec &&
      w.resets_at - nowSec <= RL_MAX_FUTURE_SEC
    ) {
      live.push(w)
    }
  }
  if (live.length === 0) {
    return own && own.resets_at > nowSec && typeof own.used_percentage === 'number' ? own.used_percentage : null
  }
  const latest = Math.max(...live.map(w => w.resets_at))
  return Math.max(0, ...live.filter(w => w.resets_at === latest).map(w => w.used_percentage))
}

/** The same with 0 for a window nobody has a live reading of, as `statusline.js` draws it. */
export const aggMax = (snaps: RlSnaps, field: RlField, own: RlWindow | null, nowSec: number): number =>
  aggMaxOrNull(snaps, field, own, nowSec) ?? 0

/** Seconds to the next reset; a reset already in the past wraps by the period (L282-287). */
export const countdownSec = (
  resetAt: number | null | undefined,
  periodSec: number,
  nowSec: number,
): number | null => {
  if (!resetAt) return null
  if (resetAt > nowSec) return resetAt - nowSec
  return periodSec - ((nowSec - resetAt) % periodSec)
}

export const fmtReset5h = (sec: number): string => `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`

export const fmtReset7d = (sec: number): string => `${Math.floor(sec / 86_400)}d ${Math.floor((sec % 86_400) / 3600)}h`

const countLines = (text: string): number =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** Lines a settled tool.call added and removed, read off its `structuredPatch`; failed or held-back calls count 0. */
export const patchLineCount = (ran: unknown): { add: number; rm: number } => {
  const none = { add: 0, rm: 0 }
  const call = asRecord(ran)
  const result = asRecord(call?.result)
  if (!call || !result || call.deny !== undefined || call.isError === true || result.staged === true) return none
  const hunks = result.structuredPatch
  if (!Array.isArray(hunks)) return none
  let add = 0
  let rm = 0
  for (const hunk of hunks) {
    const lines = asRecord(hunk)?.lines
    if (!Array.isArray(lines)) continue
    for (const line of lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) add += 1
      else if (line.startsWith('-')) rm += 1
    }
  }
  if (add === 0 && rm === 0 && result.type === 'create' && typeof result.content === 'string') {
    add = countLines(result.content)
  }
  return { add, rm }
}

/** The aggregate `cpu` line, reduced to the counters os.cpus() gives statusline.js (L546-547): user+nice+sys+idle+irq. */
export const parseCpuStat = (text: string): CpuSample | null => {
  const m = /^cpu\s+(\d.*)$/m.exec(text)
  if (!m?.[1]) return null
  const f = m[1].trim().split(/\s+/).map(Number)
  if (f.length < 4 || f.some(n => !Number.isFinite(n))) return null
  const [user = 0, nice = 0, system = 0, idle = 0, , irq = 0] = f
  return { idle, total: user + nice + system + idle + irq }
}

/** Busy share between two samples; the first sample has no baseline (null), a stalled or reset counter reads 0 (L551-553). */
export const cpuPercent = (prev: CpuSample | null, cur: CpuSample): number | null => {
  if (!prev) return null
  const total = cur.total - prev.total
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((1 - (cur.idle - prev.idle) / total) * 100)))
}

const kbOf = (text: string, name: string): number | null => {
  const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text)
  return m?.[1] ? Number(m[1]) : null
}

/** RAM in use as `MemTotal - MemAvailable`: Node's os.freemem() is MemAvailable on Linux (equal here), so this is L554-556's figure. */
export const parseMeminfo = (text: string): MemInfo | null => {
  const total = kbOf(text, 'MemTotal')
  const available = kbOf(text, 'MemAvailable')
  if (!total || available === null) return null
  const used = Math.max(0, total - available)
  return { usedKb: used, totalKb: total, pct: Math.round((used / total) * 100) }
}

export const fmtGb = (kb: number): string => (kb / 1024 ** 2).toFixed(1)

export const ROW_KEYS: readonly RowKey[] = [
  'summary',
  'dir',
  'repo',
  'model',
  'cost',
  'usage',
  'quota',
  'agents',
  'memory_mcp',
  'sys',
  'edited',
  'history',
  'progress',
  'fixture',
  'waiting',
]

/** The rows file (L19-31): a missing key or file leaves the row on; `enabled:false` is the master switch. */
export const parseToggles = (text: string | null): Toggles =>
  (text === null ? null : parseTogglesStrict(text)) ?? { enabled: true, rows: allOn() }

/** Rows that stay off until the rows file says `true`: they have no producer on a normal machine. `waiting` is opt-in until the owner decides the default (ticket #28, question 1). */
const OPT_IN: readonly RowKey[] = ['fixture', 'waiting']

const allOn = () => Object.fromEntries(ROW_KEYS.map(k => [k, !OPT_IN.includes(k)])) as Record<RowKey, boolean>

/** Like parseToggles, but a text that is not a JSON object is null, so a bad read can keep the previous toggles. */
export function parseTogglesStrict(text: string): Toggles | null {
  let stored: unknown
  try {
    stored = JSON.parse(text)
  } catch {
    return null
  }
  const from = asRecord(stored)
  if (!from) return null
  const rows = allOn()
  // an opt-in row turns on only for the boolean true, so a stray 1 or "yes" cannot switch on a row with no producer
  for (const k of ROW_KEYS) if (k in from) rows[k] = OPT_IN.includes(k) ? from[k] === true : !!from[k]
  return { enabled: from.enabled !== false, rows }
}

/** Session length as statusline.js prints it (L129-134). */
export const fmtDur = (min: number): string => {
  if (min < 60) return `${min}min`
  if (min < 1440) {
    const hr = Math.floor(min / 60)
    const m = min % 60
    return m > 0 ? `${hr}hr ${m}min` : `${hr}hr`
  }
  const d = Math.floor(min / 1440)
  const hr = Math.floor((min % 1440) / 60)
  return hr > 0 ? `${d}d ${hr}hr` : `${d}d`
}

export const fmtTok = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)

export const agoText = (nowMs: number, thenMs: number): string => {
  const m = Math.round((nowMs - thenMs) / 60_000)
  return m < 1 ? 'now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}

/** `cc()` of statusline.js L128: red from 80, yellow from 50. */
export type Tone = 'green' | 'yellow' | 'red'
export const pctColor = (pct: number): Tone => (pct >= 80 ? 'red' : pct >= 50 ? 'yellow' : 'green')

/** Effort level colours of L354-362; xhigh is the 256-colour orange. */
export const effortColor = (level: string): { color?: string; dim?: boolean } => {
  if (level === 'low') return { dim: true }
  if (level === 'high') return { color: 'yellow' }
  if (level === 'xhigh') return { color: '#ff8700' }
  if (level === 'max') return { color: 'red' }
  return { color: 'green' }
}

// ---- collector helpers ----

/** `~` for a cwd under home (on a path boundary), else the last two components (L315-319). */
export const shortDir = (cwd: string, home: string | undefined): string => {
  const base = (home ?? '').replace(/\/+$/, '')
  if (cwd && base && (cwd === base || cwd.startsWith(`${base}/`))) return `~${cwd.slice(base.length)}`
  return cwd.split('/').slice(-2).join('/')
}

/** `git status --porcelain` line codes as statusline.js L303-309 bins them. */
export const countGitStatus = (porcelain: string): { added: number; modified: number; untracked: number } => {
  const n = { added: 0, modified: 0, untracked: 0 }
  for (const line of porcelain.split('\n')) {
    if (!line) continue
    const code = line.slice(0, 2)
    if (code === '??') n.untracked += 1
    else if (code.includes('A')) n.added += 1
    else n.modified += 1
  }
  return n
}

/** `owner/repo` of the origin URL, else the top-level directory's name (L310-313). */
export const repoName = (remoteUrl: string, topLevel: string): string => {
  const m = /[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remoteUrl)
  if (m) return `${m[1]}/${m[2]}`
  return topLevel.split('/').filter(Boolean).pop() ?? ''
}

/**
 * Summary file, else the first user message, else `session <id>` (L563-577; the mod has no session_name).
 * The first user entry decides even when it is empty, as in the original.
 */
export const resolveSummary = (summaryText: string | null, msgs: unknown, sid: string): string => {
  const fromFile = (summaryText ?? '').trim().split('\n')[0]?.slice(0, 500) ?? ''
  if (fromFile) return fromFile
  const first = Array.isArray(msgs) ? msgs.find(m => asRecord(m)?.r === 'u') : undefined
  const t = asRecord(first)?.t
  const text = typeof t === 'string' ? t.replace(/\n/g, ' ').trim().slice(0, 60) : ''
  return text || `session ${sid.slice(0, 8)}`
}

/** Server counts from `mcp-status-cache.json`; null when no server is listed (L435-451). */
export const mcpInfo = (cache: unknown): McpInfo | null => {
  const servers = asRecord(asRecord(cache)?.servers)
  if (!servers) return null
  const info: McpInfo = { total: 0, healthy: 0, bad: [] }
  for (const [name, entry] of Object.entries(servers)) {
    info.total += 1
    const status = asRecord(entry)?.status
    if (status === 'connected') info.healthy += 1
    else {
      info.bad.push({ name: name.replace(/^plugin:[^:]+:/, '').replace(/^claude\.ai /, ''), isAuth: status === 'auth' })
    }
  }
  return info.total > 0 ? info : null
}

/** `effort.level` of a main-loop hook input; a subagent's own effort is not the session's. */
export const effortFrom = (input: unknown): string | null => {
  const rec = asRecord(input)
  if (!rec || rec.agent_id || rec.agentId) return null
  const level = asRecord(rec.effort)?.level
  return typeof level === 'string' && level ? level.toLowerCase() : null
}

/**
 * The newest level a main-loop hook input carried, else CLAUDE_EFFORT, else unknown (null). The old
 * effort-current.txt and settings fallbacks are gone: the file is global and read `max` in a `medium` session.
 */
export const resolveEffort = (src: { hook: string | null; env: string | undefined }): string | null => {
  const first = [src.hook ?? '', src.env ?? ''].map(c => c.trim()).find(c => c !== '')
  return first ? first.toLowerCase() : null
}

/** A level as the settings spell it: a non-empty string, lower-cased. */
const levelOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().toLowerCase() : null)

/** The effort the settings name: the top-level `effortLevel`, else the longest-prefix `modelSettings` entry; `sources` come highest precedence first. */
export const configuredEffort = (sources: readonly unknown[], modelId: string): string | null => {
  const recs = sources.map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
  for (const rec of recs) {
    const top = levelOf(rec.effortLevel)
    if (top !== null) return top
  }
  const id = modelId.toLowerCase()
  let best: { len: number; level: string } | null = null
  for (const rec of recs) {
    for (const [key, entry] of Object.entries(asRecord(rec.modelSettings) ?? {})) {
      const level = levelOf(asRecord(entry)?.effortLevel)
      if (level === null || key === '' || !id.startsWith(key.toLowerCase())) continue
      if (best === null || key.length > best.len) best = { len: key.length, level }
    }
  }
  return best?.level ?? null
}

/** A `SessionRateLimit` as the snapshot file spells a window; the ISO reset time becomes epoch seconds. */
export const rlWindow = (rl: { percentUsed: number; resetsAt?: string } | undefined): RlWindow | null => {
  if (!rl || typeof rl.percentUsed !== 'number' || !rl.resetsAt) return null
  const ms = Date.parse(rl.resetsAt)
  return Number.isFinite(ms) ? { used_percentage: rl.percentUsed, resets_at: Math.floor(ms / 1000) } : null
}

/** Cost and tokens summed over every session's cum file (L487-499). */
export const allTotals = (cumTexts: (string | null)[]): { cost: number; tok: number } => {
  let cost = 0
  let tok = 0
  for (const text of cumTexts) {
    const cum = parseCum(text)
    cost += cum.cost.total
    tok += cum.tok.total
  }
  return { cost, tok }
}

/** The tracker hooks the data files come from: the script in `settings.hooks`, and the events it must be wired to. */
export const HOOK_SCRIPTS: Record<keyof HookVerdicts, { script: string; events: readonly string[] }> = {
  agents: { script: 'subagent-tracker.js', events: ['SubagentStart', 'SubagentStop'] },
  edited: { script: 'file-tracker.js', events: ['PostToolUse'] },
  summary: { script: 'summary-updater.js', events: ['UserPromptSubmit'] },
  messages: { script: 'message-tracker.js', events: ['UserPromptSubmit', 'Stop'] },
  compact: { script: 'compact-monitor.js', events: ['PreCompact'] },
}

/** What a refresh assumes before any settings read has worked: nothing is reported missing on a guess. */
export const ALL_CONFIGURED: HookVerdicts = { agents: true, edited: true, summary: true, messages: true, compact: true }

/**
 * Whether each tracker hook is wired in any of the settings given: some `hooks.<Event>[].hooks[].command`
 * names its script. Several are given because the merge takes `hooks` whole from the last source that has it.
 */
export const hooksConfigured = (...settings: unknown[]): HookVerdicts => {
  const wired = ({ script, events }: { script: string; events: readonly string[] }): boolean =>
    settings.some(one => {
      const hooks = asRecord(asRecord(one)?.hooks)
      return events.some(event => {
        const groups = hooks?.[event]
        if (!Array.isArray(groups)) return false
        return groups.some(group => {
          const entries = asRecord(group)?.hooks
          if (!Array.isArray(entries)) return false
          return entries.some(entry => {
            const command = asRecord(entry)?.command
            return typeof command === 'string' && command.includes(script)
          })
        })
      })
    })
  return {
    agents: wired(HOOK_SCRIPTS.agents),
    edited: wired(HOOK_SCRIPTS.edited),
    summary: wired(HOOK_SCRIPTS.summary),
    messages: wired(HOOK_SCRIPTS.messages),
    compact: wired(HOOK_SCRIPTS.compact),
  }
}

// claude-<family>-<n>-<n>[-<yyyymmdd>][[1m]], or the older claude-<n>-<n>-<family>[-<yyyymmdd>]
const MODEL_ID = /^claude-(?:(\d{1,2}(?:-\d{1,2})*)-)?([a-z]+)(?:-(\d{1,2}(?:-\d{1,2})*))?(?:-\d{8})?(\[[^\]]*\])?$/

/** The session's model id (`claude-opus-5-5[1m]`) as the native status line names it (`Opus 5.5 [1m]`). */
export const modelLabel = (raw: string): string => {
  const m = MODEL_ID.exec(raw)
  const lead = m?.[1]
  const trail = m?.[3]
  // exactly one version, before or after the family; anything else is not an id we know
  if (!m || (lead === undefined) === (trail === undefined)) return raw.replace(/^Claude\s+/i, '')
  const family = m[2] ?? ''
  const version = (lead ?? trail ?? '').replaceAll('-', '.')
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}${m[4] ? ` ${m[4]}` : ''}`
}

// ---- display width ----

/** East Asian wide cells, as statusline.js L69-105 counts them. */
const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x231a && cp <= 0x231b) ||
  (cp >= 0x23e9 && cp <= 0x23f3) ||
  (cp >= 0x23f8 && cp <= 0x23fa) ||
  (cp >= 0x25fd && cp <= 0x25fe) ||
  (cp >= 0x2614 && cp <= 0x2615) ||
  (cp >= 0x2648 && cp <= 0x2653) ||
  cp === 0x267f ||
  cp === 0x26a1 ||
  (cp >= 0x26aa && cp <= 0x26ab) ||
  (cp >= 0x26bd && cp <= 0x26be) ||
  (cp >= 0x26c4 && cp <= 0x26c5) ||
  cp === 0x26ce ||
  cp === 0x26d4 ||
  cp === 0x26ea ||
  (cp >= 0x26f2 && cp <= 0x26f3) ||
  cp === 0x26f5 ||
  cp === 0x26fa ||
  cp === 0x26fd ||
  cp === 0x2705 ||
  cp === 0x2728 ||
  cp === 0x274c ||
  cp === 0x274e ||
  (cp >= 0x2753 && cp <= 0x2755) ||
  cp === 0x2757 ||
  (cp >= 0x2795 && cp <= 0x2797) ||
  cp === 0x27b0 ||
  cp === 0x27bf ||
  (cp >= 0x2e80 && cp <= 0x303e) ||
  (cp >= 0x3041 && cp <= 0x33bf) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x4e00 && cp <= 0xa4cf) ||
  (cp >= 0xa960 && cp <= 0xa97c) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe10 && cp <= 0xfe6b) ||
  (cp >= 0xff01 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f004 && cp <= 0x1f9ff) ||
  (cp >= 0x1fa00 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x2fffd) ||
  (cp >= 0x30000 && cp <= 0x3fffd)

export const dw = (s: string): number => {
  let w = 0
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return w
}

// ---- clock and liveness ----

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** HH:MM(:SS) of `ms` in local time, or at `tzMin` minutes east of UTC when a test pins it. */
export const fmtClock = (ms: number, tzMin: number | undefined, withSeconds: boolean): string => {
  const d = new Date(tzMin === undefined ? ms : ms + tzMin * 60_000)
  const [h, m, sec] =
    tzMin === undefined ? [d.getHours(), d.getMinutes(), d.getSeconds()] : [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
  const hm = `${pad2(h)}:${pad2(m)}`
  return withSeconds ? `${hm}:${pad2(sec)}` : hm
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * The wall-clock time a countdown of `sec` seconds taken at `atMs` runs out at, in local time (or at `tzMin` minutes east
 * of UTC): `HH:MM` when that is the day of `atMs`, else `Ddd HH:MM`; `always` puts the weekday on whatever the day.
 */
export const fmtResetClock = (atMs: number, sec: number, tzMin: number | undefined, always: boolean): string => {
  const end = atMs + sec * 1000
  const day = (ms: number): [number, number, number, number] => {
    const d = new Date(tzMin === undefined ? ms : ms + tzMin * 60_000)
    return tzMin === undefined ? [d.getFullYear(), d.getMonth(), d.getDate(), d.getDay()] : [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCDay()]
  }
  const [y, m, date, weekday] = day(end)
  const [y0, m0, date0] = day(atMs)
  const hm = fmtClock(end, tzMin, false)
  return always || y !== y0 || m !== m0 || date !== date0 ? `${WEEKDAYS[weekday]!} ${hm}` : hm
}

export const STALE_MS = 90_000
export const DEAD_MS = 300_000

export const staleness = (atMs: number, nowMs: number): 'fresh' | 'stale' | 'dead' => {
  const age = nowMs - atMs
  return age > DEAD_MS ? 'dead' : age > STALE_MS ? 'stale' : 'fresh'
}

// ---- agents ----

/** Tracker file entries grouped by name: running first, then the latest finish, top three (L366-384). */
export const groupAgents = (raw: unknown): AgentGroup[] => {
  const byName = new Map<string, AgentGroup>()
  for (const [key, info] of Object.entries(asRecord(raw) ?? {})) {
    const rec = asRecord(info)
    if (!rec) continue
    const name = typeof rec.name === 'string' && rec.name ? rec.name : key
    const g = byName.get(name) ?? { name, running: 0, done: 0, latest: 0 }
    if (rec.status === 'running') g.running += 1
    else {
      g.done += 1
      const finished = typeof rec.finished === 'number' ? rec.finished : 0
      if (finished > g.latest) g.latest = finished
    }
    byName.set(name, g)
  }
  return [...byName.values()].sort((a, b) => b.running - a.running || b.latest - a.latest).slice(0, 3)
}

// ---- prompt tail ----

const TAIL_MAX = 48
const TAIL_SEP = ' · '

/** The context percentage, or null when it is unknown: the engine gave none, or the session has no tokens yet. */
export const knownContextPct = (v: { pct: number | null; used: number }): number | null => (v.pct !== null && v.used > 0 ? v.pct : null)

const buildTail = (snap: Snap | null, nowMs: number, tzMin?: number): string | null => {
  if (!snap || !snap.toggles.enabled) return null
  const on = snap.toggles.rows
  const parts: string[] = []
  // first, so the trim below drops the other segments before it
  const wait = on.waiting ? waitingHint(snap, nowMs) : null
  if (wait) parts.push(wait)
  const ctxPct = on.usage && snap.context.ok ? knownContextPct(snap.context.v) : null
  if (ctxPct !== null) parts.push(`ctx ${Math.round(ctxPct)}%`)
  if (on.quota && snap.quota.ok) {
    // a window nobody has a reading of is left out, not told as 0%
    if (snap.quota.v.five.pct !== null) parts.push(`5h ${snap.quota.v.five.pct}%`)
    if (snap.quota.v.seven.pct !== null) parts.push(`7d ${snap.quota.v.seven.pct}%`)
  }
  if (on.cost && snap.cost.ok) parts.push(`$${snap.cost.v.session.toFixed(2)}`)
  parts.push(staleness(snap.at, nowMs) === 'fresh' ? fmtClock(snap.at, tzMin, false) : 'stale')
  while (parts.length > 1 && parts.join(TAIL_SEP).length > TAIL_MAX) parts.pop()
  return parts.join(TAIL_SEP)
}

/** `ctx 3% · 5h 23% · 7d 61% · $3.20 · 02:41`; null when there is nothing of ours to draw. */
export const tailText = (snap: Snap | null, nowMs: number, tzMin?: number): string | null => {
  try {
    return buildTail(snap, nowMs, tzMin)
  } catch {
    return null
  }
}

export const mergeTail = (upstream: string | undefined, ours: string): string =>
  upstream ? `${upstream}${TAIL_SEP}${ours}` : ours

// ---- progress: the NOW row and /progress read the same view ----

export const NOW_MAX_CALLS = 16
export const PROGRESS_SHOWN = 3

export type Progress = { running: { tool: string; sec: number }[]; more: number }

const TOOL_NAME_MAX = 80

/** Tells apart same-tool calls that carry no tool_use_id. */
let anonSeq = 0

/** The run a main-loop call starts; a subagent's tool is not what the session is doing now. */
export const runOf = (e: { tool: string; tool_use_id?: string; agentId?: string }, now: number): ToolRun | null =>
  e.agentId !== undefined || typeof e.tool !== 'string' || e.tool === ''
    ? null
    : { id: e.tool_use_id ?? `${e.tool}@${now}#${anonSeq++}`, tool: e.tool.slice(0, TOOL_NAME_MAX), startedAt: now }

/** The calls of `sid` plus this one; a record of another session is dropped, not carried over. */
export const addRun = (s: NowState | null, sid: string, run: ToolRun): NowState => {
  const kept = s && s.sid === sid ? s.calls.filter(c => c.id !== run.id) : []
  return { sid, calls: [...kept, run].slice(-NOW_MAX_CALLS) }
}

/** An end under another session id leaves the record as it is: it is not ours to change. */
export const dropRun = (s: NowState | null, sid: string, id: string): NowState | null =>
  s && s.sid === sid ? { sid, calls: s.calls.filter(c => c.id !== id) } : s

export const fmtElapsed = (sec: number): string => {
  const s = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0
  const two = (n: number) => String(n).padStart(2, '0')
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${two(s % 60)}s`
  return `${Math.floor(s / 3600)}h${two(Math.floor((s % 3600) / 60))}m`
}

/** What NOW shows at `nowMs`: the main loop's calls oldest first, or why that is unknown. Card and /progress both read this. */
export const progressOf = (tools: Res<NowState | null>, sid: Res<string>, nowMs: number): Res<Progress> => {
  if (!tools.ok) return { ok: false, why: tools.why }
  if (!sid.ok) return { ok: false, why: sid.why }
  if (tools.v === null) return { ok: false, why: '本次載入後還沒有工具紀錄' }
  if (tools.v.sid !== sid.v) return { ok: false, why: '紀錄屬於另一個 session' }
  const all = [...tools.v.calls].sort((a, b) => a.startedAt - b.startedAt)
  const running = all.slice(0, PROGRESS_SHOWN).map(c => ({ tool: c.tool, sec: Math.max(0, Math.floor((nowMs - c.startedAt) / 1000)) }))
  return { ok: true, v: { running, more: all.length - running.length } }
}

/** The lines of `/progress`: where the card is not drawn it says why, else the rows of the card as plain text. */
export const progressText = (snap: Snap | null, tools: Res<NowState | null>, sid: Res<string>, nowMs: number, flight?: Res<InflightState | null>): string => {
  if (!snap) return 'progress n/a（等待第一次更新）'
  if (!snap.toggles.enabled) return 'progress n/a（status-pane 已停用）'
  if (!snap.toggles.rows.progress) return 'progress n/a（progress 列已在 rows 檔關閉）'
  const p = progressOf(tools, sid, nowMs)
  let now: string[]
  if (!p.ok) now = [`NOW  n/a（${p.why}）`]
  else if (p.v.running.length === 0) now = ['NOW  idle']
  else {
    const rows = p.v.running.map(r => `${r.tool} ${fmtElapsed(r.sec)}`)
    if (p.v.more > 0) rows.push(`+${p.v.more} more`)
    now = rows.map((r, i) => `${i === 0 ? 'NOW ' : '    '} ${r}`)
  }
  return [...now, ...(flight ? inflightLines(flight, sid, nowMs) : [])].join('\n')
}

// ---- in-flight: background work from the Stop snapshot, dated by the plugin's own bookkeeping ----

export const BG_MAX_STARTS = 64
export const INFLIGHT_SHOWN = 3
const BG_LABEL_MAX = 48
const NO_SNAPSHOT = '還沒有回合結束的快照'

export type Inflight = { items: { label: string; sec: number; exact: boolean }[]; more: number; ageSec: number }

/** The background call a main-loop or subagent tool call starts, or null; a ScheduleWakeup that only cancels (`stop`) starts nothing. */
export const startOf = (e: { tool: string; run_in_background?: unknown; stop?: unknown }, now: number): BgStart | null => {
  if (e.tool === 'Bash' && e.run_in_background === true) return { kind: 'shell', at: now }
  if (e.tool === 'Agent' && e.run_in_background === true) return { kind: 'subagent', at: now }
  if (e.tool === 'CronCreate' || (e.tool === 'ScheduleWakeup' && e.stop !== true)) return { kind: 'cron', at: now }
  return null
}

const BG_KIND = { Bash: 'shell', Agent: 'subagent', CronCreate: 'cron', ScheduleWakeup: 'cron' } as const

/** Whether a call of this tool can leave a task or schedule, so the hook reads the clock before it runs. */
export const mayStartBg = (e: { tool: string }): boolean => Object.hasOwn(BG_KIND, e.tool)

/** The task id a call's result names: Bash `backgroundTaskId`, an async Agent launch's `agentId`, CronCreate `id`; null otherwise. */
export const taskIdOf = (tool: string, ran: unknown): string | null => {
  const out = asRecord(asRecord(ran)?.result)
  if (!out) return null
  const id = tool === 'Bash' ? out.backgroundTaskId : tool === 'Agent' ? (out.status === 'async_launched' ? out.agentId : null) : tool === 'CronCreate' ? out.id : null
  return typeof id === 'string' && id !== '' ? id : null
}

/** What a call that went through leaves: a keyed start when its result names the task, an open start, a veto, or nothing. */
export const bgStartOf = (e: { tool: string; run_in_background?: unknown; stop?: unknown; agentId?: unknown }, ran: unknown, at: number): BgStart | null => {
  if (!mayStartBg(e)) return null
  const kind = BG_KIND[e.tool as keyof typeof BG_KIND]
  const id = taskIdOf(e.tool, ran)
  if (id !== null) return { kind, at, id }
  const flagged = startOf(e, at) !== null
  // an Agent not told otherwise runs in the background by default (2.1.296), so it may own a listed item all the same
  if (!flagged && !(e.tool === 'Agent' && e.run_in_background !== false)) return null
  return e.agentId === undefined && flagged ? { kind, at } : { kind, at, veto: true }
}

const sameSid = (s: InflightState | null, sid: string): InflightState | null => (s && s.sid === sid ? s : null)

export const addStart = (s: InflightState | null, sid: string, start: BgStart): InflightState => {
  const cur = sameSid(s, sid)
  const all = [...(cur?.starts ?? []), start]
  // a start the cap evicted may have been the one that owned an item, so the count rule gives up until the Stop
  const cut = cur?.dropped === true || all.length > BG_MAX_STARTS
  return { sid, seenAt: cur?.seenAt ?? null, items: cur?.items ?? [], starts: all.slice(-BG_MAX_STARTS), ...(cut ? { dropped: true as const } : {}) }
}

/** An engine string as one printable line: controls and bidi marks go, the length is bounded. */
const tidy = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim() : ''

/** Cuts `s` to `max` display cells on code point boundaries, `…` marking a cut (the rule of `clipText` in pane.ts). */
const clipCells = (s: string, max: number): string => {
  if (dw(s) <= max) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const cw = dw(ch)
    if (used + cw > max - 1) break
    out += ch
    used += cw
  }
  return `${out.trimEnd()}…`
}

const kindOf = (type: string): BgKind => (type === 'shell' || type === 'subagent' || type === 'monitor' || type === 'workflow' ? type : 'other')

/** Names the task from the fields the engine gives per type, never from its command line or prompt. */
const labelOf = (t: Record<string, unknown>): { kind: BgKind; label: string } => {
  const type = tidy(t.type)
  const kind = kindOf(type)
  const detail = kind === 'subagent' ? tidy(t.agent_type) : kind === 'workflow' ? tidy(t.name) : kind === 'monitor' ? [tidy(t.server), tidy(t.tool)].filter(Boolean).join(':') : ''
  const head = kind === 'subagent' ? 'agent' : kind === 'other' ? type || 'task' : kind
  return { kind, label: clipCells(detail ? `${head} ${detail}` : head, BG_LABEL_MAX) }
}

type StopInput = { background_tasks?: unknown; session_crons?: unknown }

/** The state after a main-loop Stop: each new item is dated by the start that names its id, else by the one open start of its kind when nothing else could own it. */
export const noteStop = (s: InflightState | null, sid: string, e: StopInput, now: number): InflightState | null => {
  const hasTasks = Array.isArray(e.background_tasks)
  const hasCrons = Array.isArray(e.session_crons)
  if (!hasTasks && !hasCrons) return s
  const cur = sameSid(s, sid)
  const starts = cur?.starts ?? []
  const known = new Map((cur?.items ?? []).map(i => [i.id, i]))
  const incoming: { id: string; kind: BgKind; label: string }[] = []
  if (hasTasks) {
    for (const t of e.background_tasks as Record<string, unknown>[]) {
      if (t && typeof t === 'object' && typeof t.id === 'string') incoming.push({ id: t.id, ...labelOf(t) })
    }
  }
  if (hasCrons) {
    for (const c of e.session_crons as Record<string, unknown>[]) {
      if (c && typeof c === 'object' && typeof c.id === 'string') incoming.push({ id: c.id, kind: 'cron', label: c.recurring === false ? 'wakeup' : 'cron' })
    }
  }
  const fresh = incoming.filter(i => !known.has(i.id))
  const startKind = (k: BgKind) => (k === 'cron' ? 'cron' : k === 'shell' ? 'shell' : k === 'subagent' ? 'subagent' : null)
  const keyOf = (i: { id: string; kind: BgKind }) => starts.find(st => st.id === i.id && st.kind === startKind(i.kind))
  const items: BgItem[] = incoming.map(i => {
    const old = known.get(i.id)
    if (old) {
      // a key that reached us after the Stop which first listed the task
      const late = old.exact ? undefined : keyOf(old)
      return late ? { ...old, since: late.at, exact: true } : old
    }
    const key = keyOf(i)
    if (key) return { ...i, since: key.at, exact: true }
    const k = startKind(i.kind)
    const open = starts.filter(st => st.kind === k && st.id === undefined)
    const rivals = fresh.filter(f => startKind(f.kind) === k && !keyOf(f))
    return !cur?.dropped && open.length === 1 && open[0].veto !== true && rivals.length === 1 ? { ...i, since: open[0].at, exact: true } : { ...i, since: now, exact: false }
  })
  // a field the engine left out is not an empty list: that class keeps what it had
  for (const old of cur?.items ?? []) {
    if (old.kind === 'cron' ? !hasCrons : !hasTasks) items.push(old)
  }
  return { sid, seenAt: now, items, starts: [] }
}

/** A task's notification ended it; an id we do not hold, or another session, leaves the record as it is. */
export const endTask = (s: InflightState | null, sid: string, id: string): InflightState | null =>
  s && s.sid === sid && s.items.some(i => i.id === id) ? { ...s, items: s.items.filter(i => i.id !== id) } : s

/** What BG shows at `nowMs`, oldest first, or why that is unknown. Card and /progress both read this. */
export const inflightOf = (flight: Res<InflightState | null>, sid: Res<string>, nowMs: number): Res<Inflight> => {
  if (!flight.ok) return { ok: false, why: flight.why }
  if (!sid.ok) return { ok: false, why: sid.why }
  if (flight.v === null || flight.v.seenAt === null) return { ok: false, why: NO_SNAPSHOT }
  if (flight.v.sid !== sid.v) return { ok: false, why: '紀錄屬於另一個 session' }
  const all = [...flight.v.items].sort((a, b) => a.since - b.since)
  const items = all.slice(0, INFLIGHT_SHOWN).map(i => ({ label: i.label, sec: Math.max(0, Math.floor((nowMs - i.since) / 1000)), exact: i.exact }))
  return { ok: true, v: { items, more: all.length - items.length, ageSec: Math.max(0, Math.floor((nowMs - flight.v.seenAt) / 1000)) } }
}

/** The permission dialog is not a background item and no hook gave its wait (#9): this row is always n/a. */
export const PERM_NA = 'n/a（-p 下 PermissionRequest 未觸發，TUI 未驗）'

/** The rows of BG as text lines (after NOW), the same words the card draws. */
export const inflightLines = (flight: Res<InflightState | null>, sid: Res<string>, nowMs: number): string[] => {
  const v = inflightOf(flight, sid, nowMs)
  if (!v.ok) return [`BG   n/a（${v.why}）`, `PERM ${PERM_NA}`]
  const rows = v.v.items.map(i => `${i.exact ? '' : '≥'}${i.label} ${fmtElapsed(i.sec)}`)
  if (v.v.more > 0) rows.push(`+${v.v.more} more`)
  const lines = rows.length === 0 ? ['BG   none'] : rows.map((r, i) => `${i === 0 ? 'BG  ' : '    '} ${r}`)
  return [...lines, `     snapshot ${fmtElapsed(v.v.ageSec)} ago`, `PERM ${PERM_NA}`]
}
