// Pure functions behind the Pane: a snapshot becomes cards (plain data), the cards become engine elements.
// No $ calls, so every path runs offline; register.tsx only hands over the element constructors.

import type { BoxProps, ElementConstructor, RasterProps, RenderElement, TextProps } from 'claude-code'

import {
  agoText,
  cannotDraw,
  dw,
  effortColor,
  fmtClock,
  fmtDur,
  fmtGb,
  fmtReset5h,
  fmtReset7d,
  fmtResetClock,
  fmtElapsed,
  inflightOf,
  PERM_NA,
  fmtTok,
  knownContextPct,
  pctColor,
  progressOf,
  staleness,
} from './model'
import type { Inflight, Progress, Tone } from './model'
import { DEFAULT_AT, adviceOf, fillOf, modeLabel } from './compact'
import type { CompactState } from './state'
import { ageText } from './sidefile'
import type { AgentGroup, InflightState, NowState, Res, Snap } from './state'

export type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean }
export type Line = Seg[]
export type Tier = 'narrow' | 'medium' | 'wide'

/** `raster` says the surface draws a Raster; `cpuHist` is the sample ring. */
export type PaneView = {
  columns: number
  nowMs: number
  tzMin?: number
  raster?: boolean
  cpuHist?: readonly number[]
  /** What the PROGRESS card is drawn from; without it the card is left out. */
  progress?: { tools: Res<NowState | null>; sid: Res<string>; inflight?: Res<InflightState | null> }
  /** The /compact state the CONTEXT hint's mode line is drawn from; without it the line is left out. */
  compact?: CompactState | null
}

export type CardId = 'header' | 'context' | '5h' | '7d' | 'cost' | 'git' | 'activity' | 'system' | 'progress' | 'fixture' | 'status'

/** A body row: a label/value split, a left-packed line, a gauge (`null` is the bare track), or the CPU chart row. */
export type CardRow =
  | { kind: 'split'; parts: Line[] }
  | { kind: 'text'; line: Line }
  | { kind: 'gauge'; pct: number | null }
  | { kind: 'chart'; label: Line; samples: number[]; columns: number; value: Line }

/** `width` counts the border and the one cell of padding either side. */
export type Card = { id: CardId; width: number; rows: CardRow[] }

/** A `footer` is the rows under the cards that belong to no card: the errors chip when SYSTEM is off. A `gap` is a blank row between cards. */
export type Block = { kind: 'cards'; cards: Card[]; gap: number } | { kind: 'footer'; lines: Line[] } | { kind: 'gap' }

export type Layout = { columns: number; w: number; tier: Tier; blocks: Block[] }

// ---- breakpoints and palette ----

/** The pane is `w = bodyColumns - 2` wide (the root's paddingX); below NARROW_BELOW cards stack, from WIDE_FROM three sit across. */
export const NARROW_BELOW = 40
export const WIDE_FROM = 80
export const MIN_W = 20
/** Samples the CPU history keeps, and the columns of its chart. */
export const HIST_MAX = 16
/** The border of every card, a grey the person's terminal draws dim. */
export const BORDER = 'gray'

export const PALETTE: Record<Tone | 'track', string> = {
  green: '#3fb950',
  yellow: '#d29922',
  red: '#f85149',
  track: '#30363d',
}

export const ROWS_FILE_HINT = 'disabled by ~/.claude/cc-statusline-rows.json'

export const tierOf = (w: number): Tier => (w < NARROW_BELOW ? 'narrow' : w < WIDE_FROM ? 'medium' : 'wide')

// ---- text fitting ----

const seg = (text: string, style: Omit<Seg, 'text'> = {}): Seg => ({ text, ...style })
const dim = (text: string): Seg => ({ text, dim: true })
const plain = (text: string): Seg => ({ text })

export const widthOf = (line: Line): number => line.reduce((n, s) => n + dw(s.text), 0)

/** `text` cut to `max` cells, ending in an ellipsis when something was left out (no space before the …). */
export const clipText = (text: string, max: number): string => {
  if (max <= 0) return ''
  if (dw(text) <= max) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const cw = dw(ch)
    if (used + cw > max - 1) break
    out += ch
    used += cw
  }
  return `${out.trimEnd()}…`
}

/** The end of `text` that fits `max` cells, with the ellipsis in front: how a path loses its head. */
export const clipStart = (text: string, max: number): string => {
  if (max <= 0) return ''
  if (dw(text) <= max) return text
  const chars = [...text]
  let used = 0
  let from = chars.length
  while (from > 0 && used + dw(chars[from - 1]!) <= max - 1) {
    from -= 1
    used += dw(chars[from]!)
  }
  return `…${chars.slice(from).join('')}`
}

/** The line cut to `max` cells with an ellipsis in the style of the segment it fell in (no space before the …). */
export const fitLine = (line: Line, max: number): Line => {
  if (widthOf(line) <= max) return line
  if (max <= 0) return []
  const out: Line = []
  let used = 0
  const ellipsis = (s: Seg): Line => {
    while (out.length > 0 && out[out.length - 1]!.text.trimEnd() === '') out.pop()
    const last = out[out.length - 1]
    if (last) out[out.length - 1] = { ...last, text: last.text.trimEnd() }
    return [...out, { ...s, text: '…' }]
  }
  for (const s of line) {
    let text = ''
    for (const ch of s.text) {
      const cw = dw(ch)
      if (used + cw > max - 1) {
        if (text) out.push({ ...s, text })
        return ellipsis(s)
      }
      text += ch
      used += cw
    }
    if (text) out.push({ ...s, text })
  }
  return out
}

/** A word wider than `max` cells cut into pieces that fit, each ending after a `/`, `-` or `_` in its second half when it has one. */
const breakWord = (word: string, max: number): string[] => {
  const pieces: string[] = []
  let rest = [...word]
  while (dw(rest.join('')) > max) {
    let used = 0
    let n = 0
    while (n < rest.length && used + dw(rest[n]!) <= max) {
      used += dw(rest[n]!)
      n += 1
    }
    n = Math.max(1, n)
    const half = Math.floor(n / 2)
    const last = (chars: string) => rest.map((ch, i) => (i >= half && i < n && chars.includes(ch) ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
    const at = last('/') >= 0 ? last('/') : last('-_')
    const cut = at >= 0 ? at + 1 : n
    pieces.push(rest.slice(0, cut).join(''))
    rest = rest.slice(cut)
  }
  pieces.push(rest.join(''))
  return pieces
}

/** Words wrapped to `max` cells, a word wider than that broken over rows of its own: nothing is cut, for text read in full. */
export const wrapWords = (text: string, max: number): string[] => {
  if (max < 1) return []
  const rows: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (dw(word) > max) {
      if (cur !== '') rows.push(cur)
      const pieces = breakWord(word, max)
      rows.push(...pieces.slice(0, -1))
      cur = pieces.at(-1)!
    } else if (cur === '') cur = word
    else if (dw(cur) + 1 + dw(word) <= max) cur = `${cur} ${word}`
    else {
      rows.push(cur)
      cur = word
    }
  }
  if (cur !== '') rows.push(cur)
  return rows
}

/** Parts side by side while they fit (`gap` between), else one row each; a part wider than `max` is cut. */
export const packRows = (parts: Line[], max: number, gap: number): Line[] => {
  const rows: Line[] = []
  let cur: Line = []
  for (const part of parts) {
    if (part.length === 0) continue
    const fitted = fitLine(part, max)
    if (cur.length === 0) cur = fitted
    else if (widthOf(cur) + gap + widthOf(fitted) <= max) cur = [...cur, plain(' '.repeat(gap)), ...fitted]
    else {
      rows.push(cur)
      cur = fitted
    }
  }
  if (cur.length > 0) rows.push(cur)
  return rows
}

// ---- gauges ----

/** The leading partial cell of a bar, by eighths filled from the left. */
export const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
/** The glyphs of a column that is filled from the bottom by eighths. */
export const LOWER = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

export type GaugeCell = { kind: 'full' | 'part' | 'track'; glyph: string }

const clampPct = (pct: number): number => Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))

/** A bar of `columns` cells, `pct` of it filled to one eighth of a cell; a reading above 0 shows at least one eighth. */
export const gaugeCells = (pct: number | null, columns: number): GaugeCell[] => {
  const p = pct === null ? 0 : clampPct(pct)
  let eighths = Math.round((p / 100) * columns * 8)
  if (p > 0 && eighths === 0) eighths = 1
  const full = Math.floor(eighths / 8)
  const rest = eighths % 8
  return Array.from({ length: columns }, (_, i): GaugeCell => {
    if (i < full) return { kind: 'full', glyph: '█' }
    if (i === full && rest > 0) return { kind: 'part', glyph: PARTIAL[rest]! }
    return { kind: 'track', glyph: '░' }
  })
}

/** The same bar as text, for a surface with no Raster: the fill in its tone, the track dim. */
export const textGauge = (pct: number | null, columns: number): Line => {
  const cells = gaugeCells(pct, columns)
  const filled = cells.filter(c => c.kind !== 'track').map(c => c.glyph).join('')
  const track = cells.filter(c => c.kind === 'track').map(c => c.glyph).join('')
  const line: Line = []
  if (filled) line.push(seg(filled, { color: PALETTE[pctColor(clampPct(pct ?? 0))] }))
  if (track) line.push(dim(track))
  return line
}

const rgb = (hex: string): number => Number.parseInt(hex.slice(1), 16)

/** `[codePoint, foreground, background]` per cell, row-major: the payload of a Raster before it is encoded. */
export type RasterCell = readonly [number, number, number]

/** Standard padded base64 of little-endian u32 triplets, as `RasterProps.cells` wants them. */
export const encodeCells = (cells: readonly RasterCell[]): string => {
  const bytes = new Uint8Array(cells.length * 12)
  const view = new DataView(bytes.buffer)
  cells.forEach(([glyph, fg, bg], i) => {
    view.setUint32(i * 12, glyph, true)
    view.setUint32(i * 12 + 4, fg, true)
    view.setUint32(i * 12 + 8, bg, true)
  })
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export type RasterData = { columns: number; rows: number; cells: string }

/** The gauge as a one-row Raster: truecolor fill in the threshold tone on a grey track, partial cell included. */
export const gaugeRaster = (pct: number | null, columns: number): RasterData => {
  const fill = rgb(PALETTE[pctColor(clampPct(pct ?? 0))])
  const track = rgb(PALETTE.track)
  const cells = gaugeCells(pct, columns).map((c): RasterCell => {
    if (c.kind === 'full') return [0x2588, fill, track]
    if (c.kind === 'part') return [c.glyph.codePointAt(0)!, fill, track]
    return [0x2588, track, track]
  })
  return { columns, rows: 1, cells: encodeCells(cells) }
}

/** Sixteenths of the chart's height for a CPU reading: 0..16 on a fixed 0..100% axis, a reading above 0 at least one. */
export const chartHeight = (pct: number): number => {
  const p = clampPct(pct)
  const h = Math.round((p / 100) * 16)
  return p > 0 && h === 0 ? 1 : h
}

/** The CPU history as a two-row area chart, the newest sample at the right edge, a column per sample. */
export const chartRaster = (samples: readonly number[], columns: number): RasterData => {
  const shown = samples.slice(-columns)
  const offset = columns - shown.length
  const track = rgb(PALETTE.track)
  const rows: RasterCell[][] = [[], []]
  for (let c = 0; c < columns; c++) {
    const v = c < offset ? null : shown[c - offset]!
    const h = v === null ? 0 : chartHeight(v)
    const color = v === null ? track : rgb(PALETTE[pctColor(clampPct(v))])
    const eighths = [Math.max(0, h - 8), Math.min(8, h)]
    eighths.forEach((k, row) => {
      rows[row]!.push(k === 0 ? [0x2588, track, track] : [LOWER[k]!.codePointAt(0)!, color, track])
    })
  }
  return { columns, rows: 2, cells: encodeCells([...rows[0]!, ...rows[1]!]) }
}

/** The CPU history as text, one glyph per sample on the same 0..100% axis. */
export const sparkText = (samples: readonly number[], columns: number): string =>
  samples
    .slice(-columns)
    .map(v => LOWER[1 + Math.round((clampPct(v) / 100) * 7)])
    .join('')

// ---- cards ----

type Ctx = { w: number; tier: Tier; nowMs: number; tzMin: number | undefined; raster: boolean; hist: readonly number[]; progress: Res<Progress> | null; inflight: Res<Inflight> | null }

const innerOf = (width: number): number => width - 4

/** Parts spread to both edges with a cell between at the least; the left part gives way first. */
const split = (left: Line, right: Line, inner: number): CardRow => {
  const rightFit = fitLine(right, inner)
  const room = inner - widthOf(rightFit) - 1
  return { kind: 'split', parts: [room > 0 ? fitLine(left, room) : [], rightFit] }
}

/** A title: bold, in the accent colour. */
const titleSeg = (title: string): Seg => seg(title, { bold: true, color: 'cyan' })

/** The first row of a card: the title at the left, the value (when it has one) at the right edge. */
const titleRow = (title: string, value: Seg | null, inner: number): CardRow =>
  value ? split([titleSeg(title)], [value], inner) : { kind: 'split', parts: [[titleSeg(title)]] }

const toneSeg = (text: string, pct: number): Seg => seg(text, { color: PALETTE[pctColor(clampPct(pct))] })

/** A failure's message wrapped to `max` cells, one dim line each: the reason is read in full, not cut. */
const naLines = (text: string, max: number): Line[] => wrapWords(text, max).map(t => [dim(t)])

/** Bidi controls a reason may carry (the side file contract lets them through); drawn, they would reorder the line. */
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** A failure's rows, its reason read in full. */
const naRows = (text: string, inner: number): CardRow[] => naLines(text.replace(BIDI_RE, ''), inner).map((line): CardRow => ({ kind: 'text', line }))

/** A dim label at the left edge, its value at the right: the grid every card is made of. A value too wide for the row goes under its label, whole. */
/** The least cells between a label and its value. */
const GAP = 2

const kv = (label: string, value: Line, inner: number): CardRow[] =>
  dw(label) + GAP + widthOf(value) <= inner
    ? [{ kind: 'split', parts: [[dim(label)], value] }]
    : [{ kind: 'split', parts: [[dim(label)]] }, { kind: 'split', parts: [[], fitLine(value, inner)] }]

/** The rows of a value that needs several: the label on the first, every row right-aligned. */
const kvRows = (label: string, rows: Line[]): CardRow[] =>
  rows.map((line, i): CardRow => ({ kind: 'split', parts: [i === 0 ? [dim(label)] : [], line] }))

/** A cell of `width` cells with `text` against its right edge. */
const cell = (text: string, width: number): string => ' '.repeat(Math.max(0, width - dw(text))) + text

/** The threshold hint and the mode line under the CONTEXT rows; nothing below the line. */
const compactRows = (fill: number | null, compact: CompactState | null, inner: number): CardRow[] => {
  const advice = adviceOf(fill, compact ?? { atPct: DEFAULT_AT })
  if (advice === null) return []
  const tone = PALETTE[pctColor(advice.pct)]
  const rows: CardRow[] = wrapWords(`△ 已達 ${advice.atPct}% · 建議 /compact`, inner).map((t): CardRow => ({ kind: 'text', line: [seg(t, { color: tone })] }))
  if (compact) rows.push(...kv('suggest', [plain(modeLabel(compact))], inner))
  return rows
}

const contextCard = (snap: Snap, width: number, inner: number, compact: CompactState | null): Card => {
  const r = snap.context
  if (!r.ok) return { id: 'context', width, rows: [titleRow('CONTEXT', null, inner), ...naRows(`n/a (${r.why})`, inner)] }
  const { used, max, compacts } = r.v
  // before the first response there is no reading: a dash and a bare track, not a 0% that nobody measured
  const known = knownContextPct(r.v)
  const p = known === null ? null : Math.round(clampPct(known))
  const figure = `${used > 0 ? fmtTok(used) : '—'} / ${max > 0 ? fmtTok(max) : '—'}`
  const rows: CardRow[] = [titleRow('CONTEXT', p === null ? dim('—') : toneSeg(`${p}%`, p), inner), { kind: 'gauge', pct: p }]
  // `used` and `compact` as two label/value pairs on one row; two rows when the pairs do not fit one
  const usedPair: Line = [dim('used'), plain(` ${figure}`)]
  if (!compacts.ok) rows.push(...kv('used', [plain(figure)], inner), ...naRows(`compact n/a (${compacts.why})`, inner))
  else {
    const compactPair: Line = [dim('compact'), plain(` ${compacts.v}`)]
    if (widthOf(usedPair) + 3 + widthOf(compactPair) <= inner) rows.push({ kind: 'split', parts: [usedPair, compactPair] })
    else rows.push(...kv('used', [plain(figure)], inner), ...kv('compact', [plain(String(compacts.v))], inner))
  }
  rows.push(...compactRows(fillOf({ tokens: used, window: max }), compact, inner))
  return { id: 'context', width, rows }
}

const quotaCard = (snap: Snap, id: '5h' | '7d', width: number, inner: number, c: Ctx): Card => {
  const title = id === '5h' ? '5H' : '7D'
  const r = snap.quota
  if (!r.ok) return { id, width, rows: [titleRow(title, null, inner), ...naRows(`n/a (${r.why})`, inner)] }
  const win = id === '5h' ? r.v.five : r.v.seven
  const p = win.pct === null ? null : Math.round(clampPct(win.pct))
  const rows: CardRow[] = [titleRow(title, p === null ? dim('—') : toneSeg(`${p}%`, p), inner), { kind: 'gauge', pct: p }]
  if (win.resetSec !== null) {
    const spaced = id === '5h' ? fmtReset5h(win.resetSec) : fmtReset7d(win.resetSec)
    const countdown = plain(c.tier === 'wide' ? spaced : spaced.replace(' ', ''))
    // the clock is that same countdown run forward from the snapshot, so the two cannot disagree; the 7-day window always names its weekday
    const clock = plain(fmtResetClock(snap.at, win.resetSec, c.tzMin, id === '7d'))
    const together: Line = [countdown, dim(' · '), clock]
    if (dw('resets') + GAP + widthOf(together) <= inner) rows.push({ kind: 'split', parts: [[dim('resets')], together] })
    else rows.push(...kv('resets', [countdown], inner), { kind: 'split', parts: [[], [clock]] })
  }
  return { id, width, rows }
}

type MatrixRow = { label: '$' | 'tokens'; session: string; all: string; known: boolean }
type Matrix = { title: string; rows: MatrixRow[]; failed: string[] }

/** The session figure is bold; a figure nobody measured is a dim dash, not a reading. */
const style = (row: MatrixRow, bold: boolean): Omit<Seg, 'text'> => (row.known ? (bold ? { bold: true } : {}) : { dim: true })

/** The `$` row is the cost toggle's and the `tokens` row the usage toggle's; with one on, the title follows it. */
const costMatrix = (snap: Snap): Matrix => {
  const on = snap.toggles.rows
  const rows: MatrixRow[] = []
  const failed: string[] = []
  if (on.cost) {
    if (snap.cost.ok) rows.push({ label: '$', session: snap.cost.v.session.toFixed(2), all: snap.cost.v.all.toFixed(2), known: true })
    else {
      rows.push({ label: '$', session: '—', all: '—', known: false })
      failed.push(`cost n/a (${snap.cost.why})`)
    }
  }
  if (on.usage) {
    if (snap.tokens.ok) rows.push({ label: 'tokens', session: `${fmtTok(snap.tokens.v.session)}≈`, all: `${fmtTok(snap.tokens.v.all)}≈`, known: true })
    else {
      rows.push({ label: 'tokens', session: '—', all: '—', known: false })
      failed.push(`tokens n/a (${snap.tokens.why})`)
    }
  }
  return { title: on.cost ? 'COST' : 'TOKENS', rows, failed }
}

/** The matrix in its full words, then with `sess` and `tok` when the full one does not fit. */
type Words = { session: string; tokens: string }
const FULL: Words = { session: 'session', tokens: 'tokens' }
const SHORT: Words = { session: 'sess', tokens: 'tok' }

const shownLabel = (row: MatrixRow, words: Words): string => (row.label === 'tokens' ? words.tokens : row.label)

/** The three column widths of the matrix: the first holds the title and the labels, the others the figures and their headers. */
const columnsOf = (m: Matrix, words: Words) => ({
  label: Math.max(dw(m.title), ...m.rows.map(row => dw(shownLabel(row, words)))),
  session: Math.max(dw(words.session), ...m.rows.map(row => dw(row.session))),
  total: Math.max(dw('total'), ...m.rows.map(row => dw(row.all))),
})

/** Cells inside a card that the matrix needs: the columns with two cells between them. */
const matrixNeed = (m: Matrix, words: Words): number => {
  const c = columnsOf(m, words)
  return c.label + 2 + c.session + 2 + c.total
}

/** The words that fit `inner` cells, or null when only the stacked rows do. */
const wordsFor = (m: Matrix, inner: number): Words | null => (matrixNeed(m, FULL) <= inner ? FULL : matrixNeed(m, SHORT) <= inner ? SHORT : null)

/**
 * COST or TOKENS as a matrix with the scopes as column headers: `session` and `total`, else `sess` and `tok`, else
 * stacked rows. A figure is never cut; a failed one is a dash and its reason follows.
 */
const costCard = (snap: Snap, width: number, inner: number): Card => {
  const m = costMatrix(snap)
  const words = wordsFor(m, inner)
  const out: CardRow[] = []
  if (words) {
    const c = columnsOf(m, words)
    const block = c.session + 2 + c.total
    out.push({
      kind: 'text',
      line: [titleSeg(m.title), plain(' '.repeat(inner - dw(m.title) - block)), seg(cell(words.session, c.session), { bold: true }), plain('  '), dim(cell('total', c.total))],
    })
    out.push({ kind: 'text', line: [dim('─'.repeat(inner))] })
    for (const row of m.rows) {
      out.push({
        kind: 'text',
        line: [dim(shownLabel(row, words).padEnd(inner - block)), seg(cell(row.session, c.session), style(row, true)), plain('  '), seg(cell(row.all, c.total), style(row, false))],
      })
    }
  } else {
    out.push(titleRow(m.title, null, inner))
    for (const scope of ['session', 'total'] as const) {
      for (const row of m.rows) {
        const label = m.rows.length === 1 ? scope : `${row.label === '$' ? '$' : 'tok'} ${scope}`
        out.push(...kv(label, [scope === 'session' ? seg(row.session, style(row, true)) : seg(row.all, style(row, false))], inner))
      }
    }
  }
  for (const text of m.failed) out.push(...naRows(text, inner))
  return { id: 'cost', width, rows: out }
}

const gitCard = (snap: Snap, width: number, inner: number): Card => {
  const rows: CardRow[] = [titleRow('GIT', null, inner)]
  // a part that failed says why, in full; a branch or a path too long for its row loses its head
  const room = (label: string) => Math.max(2, inner - dw(label) - GAP)
  if (!snap.git.ok) rows.push(...naRows(`git n/a (${snap.git.why})`, inner))
  else if (snap.git.v.notRepo) rows.push(...kv('branch', [dim('not a git repo')], inner))
  else if (snap.git.v.branch) rows.push(...kv('branch', [seg(clipStart(snap.git.v.branch, room('branch')), { color: 'magenta' })], inner))
  if (!snap.dir.ok) rows.push(...naRows(`dir n/a (${snap.dir.why})`, inner))
  else rows.push(...kv('dir', [plain(clipStart(snap.dir.v, room('dir')))], inner))
  if (!snap.lines.ok) rows.push(...naRows(`lines n/a (${snap.lines.why})`, inner))
  else rows.push(...kv('lines', [seg(`+${snap.lines.v.add}`, { color: 'green' }), plain(' '), seg(`−${snap.lines.v.rm}`, { color: 'red' }), plain(' '), dim('≈')], inner))
  if (snap.git.ok) {
    if (!snap.git.v.status.ok) rows.push(...naRows(`git n/a (${snap.git.v.status.why})`, inner))
    else {
      const g = snap.git.v.status.v
      if (g.added + g.modified + g.untracked > 0) {
        const state: Line = [seg('✗', { color: 'red' })]
        if (g.added > 0) state.push(plain(' '), seg(`+${g.added}`, { color: 'green' }))
        if (g.modified > 0) state.push(plain(' '), seg(`~${g.modified}`, { color: 'yellow' }))
        if (g.untracked > 0) state.push(plain(' '), seg(`?${g.untracked}`, { color: 'blue' }))
        rows.push(...kv('state', state, inner))
      } else if (snap.git.v.branch) rows.push(...kv('state', [seg('✓ clean', { color: 'green' })], inner))
    }
  }
  return { id: 'git', width, rows }
}

/** NOW: the main loop's calls in flight, oldest first, each with its elapsed time at this draw; BG and PERM follow. The rows `/progress` prints as text. */
const progressCard = (width: number, inner: number, p: Res<Progress>, bg: Res<Inflight> | null): Card => {
  const rows: CardRow[] = [titleRow('PROGRESS', null, inner)]
  if (!p.ok) rows.push(...naRows(`n/a（${p.why}）`, inner))
  else if (p.v.running.length === 0) rows.push(...kv('NOW', [dim('idle')], inner))
  else {
    p.v.running.forEach((r, i) => {
      const elapsed = fmtElapsed(r.sec)
      // a name too long for the row loses its head: the end of an mcp tool name is the part that tells
      const name = clipStart(r.tool, Math.max(2, inner - dw('NOW') - GAP - 1 - dw(elapsed)))
      rows.push({ kind: 'split', parts: [i === 0 ? [dim('NOW')] : [], [plain(name), plain(' '), seg(elapsed, { color: 'yellow' })]] })
    })
    if (p.v.more > 0) rows.push({ kind: 'split', parts: [[], [dim(`+${p.v.more} more`)]] })
  }
  if (bg) rows.push(...bgRows(bg, inner))
  return { id: 'progress', width, rows }
}

/** BG: what the last Stop snapshot listed, each with how long it has waited (`≥` when only a lower bound), then the PERM row: always n/a (#9: PermissionRequest did not fire under -p; the TUI is untried). */
const bgRows = (bg: Res<Inflight>, inner: number): CardRow[] => {
  const rows: CardRow[] = []
  if (!bg.ok) rows.push(...naRows(`BG n/a（${bg.why}）`, inner))
  else {
    if (bg.v.items.length === 0) rows.push(...kv('BG', [dim('none')], inner))
    bg.v.items.forEach((r, i) => {
      const elapsed = fmtElapsed(r.sec)
      const name = clipText(`${r.exact ? '' : '≥'}${r.label}`, Math.max(2, inner - dw('BG') - GAP - 1 - dw(elapsed)))
      rows.push({ kind: 'split', parts: [i === 0 ? [dim('BG')] : [], [plain(name), plain(' '), seg(elapsed, { color: 'yellow' })]] })
    })
    if (bg.v.more > 0) rows.push({ kind: 'split', parts: [[], [dim(`+${bg.v.more} more`)]] })
    rows.push({ kind: 'split', parts: [[], [dim(`snapshot ${fmtElapsed(bg.v.ageSec)} ago`)]] })
  }
  rows.push(...naRows(`PERM ${PERM_NA}`, inner))
  return rows
}

/** The demo card of the side file path: the count the file holds, its age at this draw and when it was observed. */
const fixtureCard = (snap: Snap, width: number, inner: number, c: Ctx): Card => {
  const r = snap.fixture
  if (!r) return { id: 'fixture', width, rows: [titleRow('FIXTURE', null, inner)] }
  // the reader's text already reads `n/a（...）`
  if (!r.ok) return { id: 'fixture', width, rows: [titleRow('FIXTURE', null, inner), ...naRows(r.why, inner)] }
  const age = Math.max(0, Math.floor(c.nowMs / 1000 - r.v.observedAtSec))
  return {
    id: 'fixture',
    width,
    rows: [
      titleRow('FIXTURE', plain(String(r.v.count)), inner),
      ...kv('count', [plain(String(r.v.count))], inner),
      ...kv('age', [plain(ageText(age))], inner),
      ...kv('observed', [plain(fmtClock(r.v.observedAtSec * 1000, c.tzMin, true))], inner),
    ],
  }
}

/**
 * `label` and `items` packed into rows of `max` cells, a dim `sep` between the items: a row that breaks keeps the
 * separator at its end, and the rows after the first start under `indent`.
 */
const packJoined = (label: string, items: Seg[], sep: string, max: number, indent: string): Line[] => {
  const rows: Line[] = []
  let cur: Line = label === '' ? [] : [dim(label)]
  let used = dw(label)
  let count = 0
  items.forEach((item, i) => {
    const tail = i < items.length - 1 ? 1 + dw(sep) : 0
    if (count > 0 && used + 1 + dw(item.text) + tail > max) {
      rows.push(cur)
      cur = indent === '' ? [] : [dim(indent)]
      used = dw(indent)
      count = 0
    }
    if (count > 0) {
      cur.push(plain(' '))
      used += 1
    }
    // a single item wider than the row loses its head
    const shown = used + dw(item.text) + tail > max ? { ...item, text: clipStart(item.text, Math.max(2, max - used - tail)) } : item
    cur.push(shown)
    used += dw(shown.text)
    if (tail > 0) {
      cur.push(dim(` ${sep}`))
      used += tail
    }
    count += 1
  })
  rows.push(cur)
  return rows
}

// agents: one entry per group, running ones in yellow, finished ones in green
const agentEntry = (g: AgentGroup): Line => {
  const line: Line = [plain(`${g.name.slice(0, 12)} `)]
  if (g.running > 0) line.push(seg(`○${g.running > 1 ? `×${g.running}` : ''}`, { color: 'yellow' }))
  if (g.done > 0) {
    if (g.running > 0) line.push(plain(' '))
    line.push(seg(`✓${g.done > 1 ? `×${g.done}` : ''}`, { color: 'green' }))
  }
  return line
}

const AGENTS = 'agents'
const EDITED = 'edited'
const MAX_LISTED = 3
const MAX_EDITED_ROWS = 3

/** An age in the fewest cells: `now`, `5m`, `14h`. */
const agoShort = (nowMs: number, thenMs: number): string => {
  const m = Math.round((nowMs - thenMs) / 60_000)
  return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

/** `text` cut to `max` cells in the middle, ends kept, when it alone is wider. */
const midClip = (text: string, max: number): string => {
  if (dw(text) <= max) return text
  if (max < 3) return clipText(text, max)
  const chars = [...text]
  const take = (list: string[], cells: number) => {
    let out = ''
    for (const ch of list) {
      if (dw(out) + dw(ch) > cells) break
      out += ch
    }
    return out
  }
  const head = take(chars, Math.ceil((max - 1) / 2))
  const tail = [...take(chars.reverse(), Math.floor((max - 1) / 2))].reverse().join('')
  return `${head}…${tail}`
}

/** `left` and `right` on a row with at least GAP cells between; when they do not fit, the right one under it, right-aligned. */
const pairRow = (left: Line, right: Line, inner: number): CardRow[] =>
  widthOf(left) + GAP + widthOf(right) <= inner
    ? [{ kind: 'split', parts: [left, right] }]
    : [{ kind: 'split', parts: [left] }, { kind: 'split', parts: [[], fitLine(right, inner)] }]

const moreRow = (n: number): CardRow => ({ kind: 'split', parts: [[], [dim(`+${n} more`)]] })

/** Narrow: the agents under their label, a row each: the name at the left, the status and the age of a finished one at the right. */
const agentsRowsNarrow = (r: Snap['agents'], nowMs: number, inner: number): CardRow[] => {
  if (!r.ok) return naRows(`agents n/a (${r.why})`, inner)
  if (r.v.length === 0) return kv(AGENTS, [dim('idle')], inner)
  const rows: CardRow[] = [{ kind: 'split', parts: [[dim(AGENTS)]] }]
  for (const g of r.v.slice(0, MAX_LISTED)) {
    const status = agentEntry(g).slice(1)
    const ago = g.done > 0 && g.latest ? agoShort(nowMs, g.latest) : null
    const right: Line = ago === null ? status : [...status, dim(` ${ago}`)]
    rows.push(...pairRow([plain(clipText(g.name.slice(0, 12), inner))], right, inner))
  }
  if (r.v.length > MAX_LISTED) rows.push(moreRow(r.v.length - MAX_LISTED))
  return rows
}

/** Narrow: the edited files under their label, newest first, one basename a row, right-aligned. */
const editedRowsNarrow = (r: Snap['edited'], inner: number): CardRow[] => {
  if (!r.ok) return naRows(`edited n/a (${r.why})`, inner)
  if (r.v.length === 0) return kv(EDITED, [dim('idle')], inner)
  const names = [...r.v].reverse().map(f => f.split('/').filter(Boolean).at(-1) ?? f)
  const rows: CardRow[] = [{ kind: 'split', parts: [[dim(EDITED)]] }]
  for (const name of names.slice(0, MAX_LISTED)) rows.push({ kind: 'split', parts: [[], [plain(midClip(name, inner))]] })
  if (names.length > MAX_LISTED) rows.push(moreRow(names.length - MAX_LISTED))
  return rows
}

/** The agents, a row per group; the age of a finished group goes to a row of its own when it does not fit beside the group. */
const agentsRows = (r: Snap['agents'], nowMs: number, inner: number): CardRow[] => {
  if (!r.ok) return naRows(`agents n/a (${r.why})`, inner)
  if (r.v.length === 0) return kv(AGENTS, [dim('idle')], inner)
  const room = inner - dw(AGENTS) - GAP
  const lines = r.v.flatMap((g): Line[] => {
    const base = agentEntry(g)
    const ago = g.done > 0 && g.latest ? agoText(nowMs, g.latest) : null
    if (ago === null) return [fitLine(base, room)]
    const withAgo: Line = [...base, dim(` ${ago}`)]
    return widthOf(withAgo) <= room ? [withAgo] : [fitLine(base, room), [dim(ago)]]
  })
  return kvRows(AGENTS, lines)
}

/** The edited files joined by arrows over as many rows as they need, up to MAX_EDITED_ROWS. */
const editedRows = (r: Snap['edited'], inner: number): CardRow[] => {
  if (!r.ok) return naRows(`edited n/a (${r.why})`, inner)
  if (r.v.length === 0) return kv(EDITED, [dim('idle')], inner)
  const shortName = (f: string) => {
    const chars = [...f]
    return chars.length > 25 ? `…${chars.slice(-24).join('')}` : f
  }
  const room = inner - dw(EDITED) - GAP
  const rows = packJoined('', r.v.map(f => plain(shortName(f))), '→', room, '')
  const capped = rows.length <= MAX_EDITED_ROWS ? rows : [...rows.slice(0, MAX_EDITED_ROWS - 1), fitLine([...rows[MAX_EDITED_ROWS - 1]!, dim(' …')], room)]
  return kvRows(EDITED, capped)
}

const activityCard = (snap: Snap, width: number, inner: number, c: Ctx): Card => {
  const on = snap.toggles.rows
  const rows: CardRow[] = [titleRow('ACTIVITY', null, inner)]
  // narrow: a row for each agent and each file; wider: the groups and the files flowing over a few rows
  const narrow = c.tier === 'narrow'
  if (on.agents) rows.push(...(narrow ? agentsRowsNarrow : agentsRows)(snap.agents, c.nowMs, inner))
  if (on.edited) rows.push(...(narrow ? editedRowsNarrow(snap.edited, inner) : editedRows(snap.edited, inner)))
  return { id: 'activity', width, rows }
}

// ---- header ----

const liveLine = (snap: Snap, c: Ctx): Line => {
  const level = staleness(snap.at, c.nowMs)
  if (level === 'fresh') return [seg('●', { color: PALETTE.green }), dim(` ${fmtClock(snap.at, c.tzMin, false)}`)]
  const color = level === 'dead' ? PALETTE.red : PALETTE.yellow
  const secs = Math.floor((c.nowMs - snap.at) / 1000)
  return [seg('●', { color }), seg(` stale ${secs}s`, { color })]
}

/** What needs a look when the cards below are off the screen: an mcp server that is down, and the errors. */
const flagParts = (snap: Snap): Line[] => {
  const parts: Line[] = []
  if (snap.toggles.rows.memory_mcp && snap.mcp.ok && snap.mcp.v && snap.mcp.v.bad.length > 0) {
    const color = snap.mcp.v.bad.some(b => !b.isAuth) ? 'red' : 'yellow'
    parts.push([seg('mcp ', { color }), seg(color === 'red' ? '✗' : '△', { color })])
  }
  const errors = errorsLine(snap)
  if (errors) parts.push(errors)
  return parts
}

/** The model name, the effort (the level a hook reported in its colour, one the settings name dim, else left out) and the version. */
const modelItems = (v: { name: string; version: string; effort: string | null; configured?: boolean }): Seg[] => [
  seg(v.name, { color: 'cyan', bold: true }),
  ...(v.effort === null ? [] : [seg(v.effort, v.configured === true ? { dim: true } : effortColor(v.effort))]),
  ...(v.version ? [dim(`v${v.version}`)] : []),
]

/** The model items over rows, broken only between items: a row never starts or ends with the separator. */
const packModel = (items: Seg[], max: number): Line[] => {
  const rows: Line[] = []
  let cur: Line = []
  for (const item of items) {
    const shown = dw(item.text) > max ? { ...item, text: clipStart(item.text, max) } : item
    if (cur.length > 0 && widthOf(cur) + 3 + dw(shown.text) > max) {
      rows.push(cur)
      cur = []
    }
    cur = cur.length === 0 ? [shown] : [...cur, dim(' · '), shown]
  }
  if (cur.length > 0) rows.push(cur)
  return rows
}

const SUMMARY_GAP = 2
const MAX_SUMMARY_ROWS = 2

/** The summary over at most MAX_SUMMARY_ROWS rows, the session length ending the last row (or a row of its own). */
const detailLines = (summary: string, dur: string, inner: number): Line[] => {
  let rows = summary === '' ? [] : wrapWords(summary, inner)
  if (rows.length > MAX_SUMMARY_ROWS) {
    rows = [...rows.slice(0, MAX_SUMMARY_ROWS - 1), clipText(rows.slice(MAX_SUMMARY_ROWS - 1).join(' '), inner)]
  }
  if (dur === '') return rows.map(t => [dim(t)])
  const last = rows.at(-1)
  if (last !== undefined && dw(last) + 3 + dw(dur) <= inner) {
    return [...rows.slice(0, -1).map((t): Line => [dim(t)]), [dim(last), dim(' · '), dim(dur)]]
  }
  return [...rows.map((t): Line => [dim(t)]), [dim(dur)]]
}

const headerCard = (snap: Snap, c: Ctx): Card => {
  const inner = innerOf(c.w)
  const on = snap.toggles.rows
  const liveness = liveLine(snap, c)
  const flags = flagParts(snap)
  const together: Line = [...flags.flatMap(part => [...part, plain('  ')]), ...liveness]
  // beside the liveness when they fit one row, else on rows of their own at the right edge
  const live = widthOf(together) <= inner ? together : liveness
  const flagRows = live === together ? [] : packRows(flags, inner, 2).map(line => split([], line, inner))
  const items = on.model && snap.model.ok ? modelItems(snap.model.v) : []
  const model: Line = items.flatMap((item, i) => (i > 0 ? [dim(' · '), item] : [item]))
  const modelNa = on.model && !snap.model.ok ? naRows(`model n/a (${snap.model.why})`, inner) : []
  const summaryNa = on.summary && !snap.summary.ok ? naRows(`summary n/a (${snap.summary.why})`, inner) : []
  const dur = on.cost && snap.cost.ok ? fmtDur(snap.cost.v.durMin) : ''
  const detail = detailLines(on.summary && snap.summary.ok ? snap.summary.v : '', dur, inner)
  const rows: CardRow[] = []
  // wide: everything on one row when the middle fits between the model and the liveness
  const room = inner - widthOf(live) - widthOf(model) - 2 * SUMMARY_GAP
  if (c.tier === 'wide' && modelNa.length === 0 && summaryNa.length === 0 && detail.length === 1 && widthOf(detail[0]!) <= room) {
    rows.push({ kind: 'split', parts: [model, detail[0]!, live] })
    return { id: 'header', width: c.w, rows }
  }
  // the model over as many rows as it needs; the liveness ends the last of them, else the last summary row, and
  // only when neither has the room does it take a row of its own at the right edge
  const modelRows = items.length === 0 ? [] : widthOf(model) <= inner ? [model] : packModel(items, inner)
  const holds = (line: Line | undefined) => line !== undefined && widthOf(line) + 1 + widthOf(live) <= inner
  const onModel = holds(modelRows.at(-1))
  const onDetail = !onModel && holds(detail.at(-1))
  modelRows.forEach((line, i) => rows.push(onModel && i === modelRows.length - 1 ? split(line, live, inner) : { kind: 'text', line }))
  rows.push(...flagRows)
  if (!onModel && !onDetail) rows.push(split([], live, inner))
  rows.push(...modelNa, ...summaryNa)
  detail.forEach((line, i) => rows.push(onDetail && i === detail.length - 1 ? split(line, live, inner) : { kind: 'text', line }))
  return { id: 'header', width: c.w, rows }
}

// ---- the system card ----

const cpuRows = (snap: Snap, c: Ctx, inner: number): CardRow[] => {
  const r = snap.cpu
  if (!r.ok) return naRows(`cpu n/a (${r.why})`, inner)
  if (r.v === null) return kv('cpu', [dim('—')], inner)
  const value: Line = [toneSeg(`${r.v}%`, r.v)]
  if (c.hist.length === 0) return kv('cpu', value, inner)
  // label, a cell, the chart, a cell, the value
  const columns = Math.min(HIST_MAX, inner - dw('cpu') - 1 - 1 - widthOf(value))
  if (columns < 1) return kv('cpu', value, inner)
  if (c.raster) return [{ kind: 'chart', label: [dim('cpu')], samples: c.hist.slice(-columns), columns, value }]
  return kv('cpu', [dim(sparkText(c.hist, columns)), plain(' '), ...value], inner)
}

const ramRows = (snap: Snap, inner: number): CardRow[] => {
  const r = snap.ram
  if (!r.ok) return naRows(`ram n/a (${r.why})`, inner)
  return kv('ram', [toneSeg(`${r.v.pct}%`, r.v.pct), plain(`  ${fmtGb(r.v.usedKb)}/${fmtGb(r.v.totalKb)}G`)], inner)
}

/** The active count and every server that is down, over rows when they do not fit one. */
const mcpRows = (snap: Snap, inner: number): CardRow[] => {
  const r = snap.mcp
  if (!r.ok) return naRows(`mcp n/a (${r.why})`, inner)
  if (!r.v) return []
  const { total, healthy, bad } = r.v
  const head: Line =
    bad.length === 0
      ? [seg(String(total), { color: 'green' }), plain(' '), seg('✓', { color: 'green' })]
      : [seg(`${healthy}/${total}`, { color: healthy === 0 ? 'red' : 'yellow' })]
  const down = bad.map((b): Line => [seg(`${b.name} ${b.isAuth ? '△' : '✗'}`, { color: b.isAuth ? 'yellow' : 'red' })])
  return kvRows('mcp', packRows([head, ...down], inner - dw('mcp') - GAP, 2))
}

const memoryRows = (snap: Snap, inner: number): CardRow[] => {
  const r = snap.memory
  if (!r.ok) return naRows(`memory n/a (${r.why})`, inner)
  if (r.v.length === 0) return []
  return kvRows('memory', packJoined('', r.v.map(plain), '·', inner - dw('memory') - GAP, ''))
}

const errorsLine = (snap: Snap): Line | null =>
  snap.errors > 0 ? [seg(`${snap.errors} error${snap.errors === 1 ? '' : 's'}`, { color: PALETTE.red })] : null

/** CPU and RAM, then the MCP servers and the memory files, a labelled row each; the errors chip ends it unless it stands apart. */
const systemCard = (snap: Snap, width: number, inner: number, c: Ctx, withErrors: boolean): Card => {
  const on = snap.toggles.rows
  const rows: CardRow[] = [titleRow('SYSTEM', null, inner)]
  if (on.sys) rows.push(...cpuRows(snap, c, inner), ...ramRows(snap, inner))
  if (on.memory_mcp) rows.push(...mcpRows(snap, inner), ...memoryRows(snap, inner))
  const errors = errorsLine(snap)
  if (errors && withErrors) rows.push(split([], errors, inner))
  return { id: 'system', width, rows }
}

// ---- layout ----

/** Widths of `n` cards across `total` cells with `gap` cells between: the left ones take the odd cells. */
export const splitWidths = (total: number, n: number, gap = 1): number[] => {
  const room = total - gap * (n - 1)
  const base = Math.floor(room / n)
  const extra = room % n
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0))
}

const statusLayout = (view: PaneView, w: number, text: string): Layout => {
  const inner = innerOf(w)
  const rows: CardRow[] = wrapWords(text, inner).map(t => ({ kind: 'text', line: [dim(t)] }))
  return { columns: view.columns, w, tier: tierOf(w), blocks: [{ kind: 'cards', gap: 1, cards: [{ id: 'status', width: w, rows }] }] }
}

type BandId = Exclude<CardId, 'header' | 'status'>

/** Sections have no frame to tell them apart, so side by side they keep three cells between. */
/** The cells inside the card beside COST that it is never made narrower than: GIT's longest row of a usual figure. */
const PARTNER_INNER = 17

/**
 * Widths of the cards of a band: equal shares, except that a COST card with a partner takes the cells its matrix needs
 * (the full words first, then `sess` and `tok`) from the partner as far as PARTNER_INNER allows.
 */
const bandWidths = (snap: Snap, ids: BandId[], total: number, gap: number): number[] => {
  const equal = splitWidths(total, ids.length, gap)
  if (ids.length !== 2 || ids[0] !== 'cost') return equal
  const border = 4
  const m = costMatrix(snap)
  const have = equal[0]! - border
  const most = total - gap - PARTNER_INNER - 2 * border
  const full = matrixNeed(m, FULL)
  const short = matrixNeed(m, SHORT)
  const inner = have >= full ? have : most >= full ? full : have >= short ? have : most >= short ? short : have
  return [inner + border, total - gap - inner - border]
}

/** A blank row between the cards: the narrow pane is read a card at a time. */
const gapped = (layout: Layout): Layout => {
  const apart = (i: number) => layout.blocks[i]?.kind === 'cards' && layout.blocks[i + 1]?.kind === 'cards'
  return { ...layout, blocks: layout.blocks.flatMap((block, i): Block[] => (apart(i) ? [block, { kind: 'gap' }] : [block])) }
}

/** The pane as framed cards at every width and height; the engine scrolls what is taller than its room. A draw never throws. */
export const paneLayout = (snap: Snap | null, view: PaneView): Layout => {
  try {
    const w = Math.max(MIN_W, view.columns - 2)
    if (!snap) return statusLayout(view, w, 'waiting for the first refresh')
    if (!snap.toggles.enabled) return statusLayout(view, w, ROWS_FILE_HINT)
    const tier = tierOf(w)
    const c: Ctx = { w, tier, nowMs: view.nowMs, tzMin: view.tzMin, raster: view.raster === true, hist: view.cpuHist ?? [], progress: view.progress ? progressOf(view.progress.tools, view.progress.sid, view.nowMs) : null, inflight: view.progress?.inflight ? inflightOf(view.progress.inflight, view.progress.sid, view.nowMs) : null }
    const on = snap.toggles.rows
    const present: Record<BandId, boolean> = {
      context: on.usage,
      '5h': on.quota,
      '7d': on.quota,
      cost: on.cost || on.usage,
      git: on.dir || on.repo,
      activity: on.agents || on.edited,
      system: on.sys || on.memory_mcp,
      progress: on.progress && c.progress !== null,
      fixture: snap.fixture !== undefined,
    }
    const bands: BandId[][] =
      tier === 'narrow'
        ? [['progress'], ['context'], ['5h'], ['7d'], ['cost'], ['git'], ['activity'], ['system'], ['fixture']]
        : tier === 'medium'
          ? [['progress'], ['context'], ['5h', '7d'], ['cost', 'git'], ['activity'], ['system'], ['fixture']]
          : [['progress'], ['context', '5h', '7d'], ['cost', 'git', 'activity'], ['system'], ['fixture']]
    const build = (id: BandId, width: number): Card => {
      const inner = innerOf(width)
      if (id === 'context') return contextCard(snap, width, inner, view.compact ?? null)
      if (id === '5h' || id === '7d') return quotaCard(snap, id, width, inner, c)
      if (id === 'cost') return costCard(snap, width, inner)
      if (id === 'git') return gitCard(snap, width, inner)
      if (id === 'activity') return activityCard(snap, width, inner, c)
      if (id === 'progress') return progressCard(width, inner, c.progress!, c.inflight)
      if (id === 'fixture') return fixtureCard(snap, width, inner, c)
      return systemCard(snap, width, inner, c, true)
    }
    const blocks: Block[] = [{ kind: 'cards', gap: 1, cards: [headerCard(snap, c)] }]
    for (const band of bands) {
      const ids = band.filter(id => present[id])
      if (ids.length === 0) continue
      const widths = bandWidths(snap, ids, w, 1)
      blocks.push({ kind: 'cards', gap: 1, cards: ids.map((id, i) => build(id, widths[i]!)) })
    }
    // the errors are in the SYSTEM card; with that card off they stand alone under the cards
    const errors = errorsLine(snap)
    if (errors && !present.system) blocks.push({ kind: 'footer', lines: [errors] })
    const layout: Layout = { columns: view.columns, w, tier, blocks }
    return tier === 'narrow' ? gapped(layout) : layout
  } catch (err) {
    return statusLayout(view, Math.max(MIN_W, view.columns - 2), `status-pane n/a (${cannotDraw(err)})`)
  }
}

// ---- elements ----

/** The constructors `$.ui.resolve(e)` hands out; `Raster` only where the surface has one. */
export type Els = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Raster: ElementConstructor<RasterProps> | null
}

/** The layout as engine elements: real Boxes with round borders, Texts, and Rasters where there is a Raster. */
export const layoutTree = (layout: Layout, els: Els): RenderElement => {
  const { Box, Text, Raster } = els
  const text = (s: Seg): RenderElement =>
    Text({
      ...(s.color ? { color: s.color } : {}),
      ...(s.dim ? { dimColor: true } : {}),
      ...(s.bold ? { bold: true } : {}),
      ...(s.text.trim() !== '' ? { wrap: 'truncate-end' as const } : {}),
      children: s.text,
    })
  const lineEl = (line: Line): RenderElement => (line.length === 1 ? text(line[0]!) : Box({ children: line.map(text) }))
  const gaugeEl = (id: string, pct: number | null, columns: number): RenderElement =>
    Raster !== null
      ? Raster({ key: `gauge-${id}`, ...gaugeRaster(pct, columns) })
      : Box({ children: textGauge(pct, columns).map(text) })
  const rowEl = (row: CardRow, id: CardId, inner: number): RenderElement => {
    if (row.kind === 'text') return lineEl(row.line)
    if (row.kind === 'gauge') return gaugeEl(id, row.pct, inner)
    if (row.kind === 'chart') {
      const chart =
        Raster !== null
          ? Raster({ key: 'cpu-chart', ...chartRaster(row.samples, row.columns) })
          : text(dim(sparkText(row.samples, row.columns)))
      return Box({
        width: inner,
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        children: [lineEl(row.label), Box({ columnGap: 1, alignItems: 'flex-end', children: [chart, lineEl(row.value)] })],
      })
    }
    return Box({ width: inner, justifyContent: 'space-between', children: row.parts.map(lineEl) })
  }
  const cardEl = (card: Card): RenderElement => {
    return Box({
      width: card.width,
      borderStyle: 'round',
      borderColor: BORDER,
      paddingX: 1,
      flexDirection: 'column',
      children: card.rows.map(row => rowEl(row, card.id, innerOf(card.width))),
    })
  }
  const blockEl = (block: Block): RenderElement => {
    if (block.kind === 'gap') return text(plain(' '))
    if (block.kind === 'cards') {
      return block.cards.length === 1
        ? cardEl(block.cards[0]!)
        : Box({ flexDirection: 'row', columnGap: block.gap, children: block.cards.map(cardEl) })
    }
    return Box({ flexDirection: 'column', children: block.lines.map(line => Box({ paddingX: 1, children: [lineEl(line)] })) })
  }
  return Box({ flexDirection: 'column', paddingX: 1, children: layout.blocks.map(blockEl) })
}
