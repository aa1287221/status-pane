// Test-only: reads a drawn tree the way a terminal lays it out (every width the pane gives is explicit),
// so a test can look at the pane as text. It shares nothing with pane.ts, which builds the tree.

import { dw } from './model'
import type { Els } from './pane'

export type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }

/** Element constructors that make the plain data the engine makes, for tests that never mount. */
const make =
  (type: string) =>
  (props: Record<string, unknown> & { children?: unknown }): Node => {
    const { children, ...rest } = props
    const kids = children === undefined ? undefined : Array.isArray(children) ? children : [children]
    return { type, ...(Object.keys(rest).length > 0 ? { props: rest } : {}), ...(kids ? { children: kids } : {}) }
  }

export const FAKE_ELS = { Box: make('Box'), Text: make('Text'), Raster: make('Raster') } as unknown as Els
export const FAKE_ELS_PLAIN = { ...FAKE_ELS, Raster: null } as Els

export const isNode = (x: unknown): x is Node => typeof x === 'object' && x !== null && 'type' in x

export const kidsOf = (n: Node): unknown[] => (n.children ?? []).filter(c => c !== null && c !== undefined && c !== false)

export const textOf = (n: Node): string =>
  kidsOf(n)
    .map(c => (typeof c === 'string' ? c : isNode(c) ? textOf(c) : ''))
    .join('')

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const padEnd = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - dw(s)))
const isColumn = (n: Node): boolean => String(n.props?.flexDirection ?? 'row').startsWith('column')
const gapOf = (p: Record<string, unknown> | undefined): number => num(p?.columnGap) ?? num(p?.gap) ?? 0

// ---- rasters ----

export type DecodedCell = { code: number; glyph: string; fg: number; bg: number }

/** The cells of a Raster: `columns * rows` little-endian u32 triplets in standard base64. */
export const decodeCells = (cells: string): DecodedCell[] => {
  const binary = atob(cells)
  const view = new DataView(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i))
  const out: DecodedCell[] = []
  for (let o = 0; o + 12 <= binary.length; o += 12) {
    const code = view.getUint32(o, true)
    out.push({ code, glyph: String.fromCodePoint(code), fg: view.getUint32(o + 4, true), bg: view.getUint32(o + 8, true) })
  }
  return out
}

export const rasterCells = (n: Node): DecodedCell[] => decodeCells(String(n.props?.cells ?? ''))

const rasterRows = (n: Node): string[] => {
  const columns = num(n.props?.columns) ?? 0
  const rows = num(n.props?.rows) ?? 0
  const cells = rasterCells(n)
  // a cell with one colour for glyph and ground is the track of a bar, drawn here as a shaded cell
  return Array.from({ length: rows }, (_, r) =>
    cells
      .slice(r * columns, (r + 1) * columns)
      .map(c => (c.fg === c.bg ? '░' : c.glyph))
      .join(''),
  )
}

// ---- layout ----

/** Cells a node asks for along a row: its width prop, or what its content needs. */
export const naturalWidth = (n: Node): number => {
  if (n.type === 'Text') return dw(textOf(n))
  if (n.type === 'Raster') return num(n.props?.columns) ?? 0
  const p = n.props ?? {}
  const width = num(p.width)
  if (width !== undefined) return width
  const kids = kidsOf(n).filter(isNode)
  const widths = kids.map(naturalWidth)
  const content = isColumn(n)
    ? Math.max(0, ...widths)
    : widths.reduce((a, b) => a + b, 0) + gapOf(p) * Math.max(0, kids.length - 1)
  return content + (p.borderStyle ? 2 : 0) + 2 * (num(p.paddingX) ?? num(p.padding) ?? 0)
}

const columnBody = (kids: Node[], inner: number): string[] =>
  kids.flatMap(k => (k.type === 'Box' ? renderNode(k, num(k.props?.width) ?? inner) : renderNode(k, naturalWidth(k))))

const rowBody = (kids: Node[], inner: number, p: Record<string, unknown>): string[] => {
  const widths = kids.map(naturalWidth)
  const gap = gapOf(p)
  let gaps = kids.map((_, i) => (i === 0 ? 0 : gap))
  if (p.justifyContent === 'space-between' && kids.length > 1) {
    const free = Math.max(0, inner - widths.reduce((a, b) => a + b, 0))
    const n = kids.length - 1
    const base = Math.floor(free / n)
    const rest = free % n
    gaps = kids.map((_, i) => (i === 0 ? 0 : Math.max(gap, base + (i > n - rest ? 1 : 0))))
  }
  const rendered = kids.map((k, i) => renderNode(k, widths[i]!))
  const height = Math.max(0, ...rendered.map(r => r.length))
  const align = String(p.alignItems ?? 'stretch')
  const columns = kids.map((k, i) => {
    let r = rendered[i]!
    // a box stretches to the row's height, border and all
    if (align === 'stretch' && k.type === 'Box' && r.length < height) r = renderNode(k, widths[i]!, height)
    const blank = ' '.repeat(widths[i]!)
    const missing = Array.from({ length: height - r.length }, () => blank)
    return align === 'flex-end' ? [...missing, ...r] : [...r, ...missing]
  })
  return Array.from({ length: height }, (_, row) =>
    columns.map((col, i) => ' '.repeat(gaps[i]!) + padEnd(col[row]!, widths[i]!)).join(''),
  )
}

/** The lines of a node laid out `W` cells wide (a box also `minHeight` tall). */
export const renderNode = (n: Node, W: number, minHeight = 0): string[] => {
  if (n.type === 'Text') return [textOf(n)]
  if (n.type === 'Raster') return rasterRows(n)
  const p = n.props ?? {}
  const border = p.borderStyle ? 1 : 0
  const padX = num(p.paddingX) ?? num(p.padding) ?? 0
  const inner = W - 2 * border - 2 * padX
  const kids = kidsOf(n).filter(isNode)
  const body = isColumn(n) ? columnBody(kids, inner) : rowBody(kids, inner, p)
  while (body.length < Math.max(0, minHeight - 2 * border)) body.push('')
  const pad = ' '.repeat(padX)
  const lines = body.map(l => `${pad}${padEnd(l, inner)}${pad}`)
  if (!border) return lines
  return [`╭${'─'.repeat(W - 2)}╮`, ...lines.map(l => `│${l}│`), `╰${'─'.repeat(W - 2)}╯`]
}

/** The tree as the pane would look in `columns` cells: the root's own padding and trailing blanks dropped. */
export const renderTree = (tree: unknown, columns: number): string[] => {
  const root = tree as Node
  const pad = num(root.props?.paddingX) ?? 0
  return renderNode(root, columns).map(l => l.slice(pad).trimEnd())
}

// ---- cards ----

export type CardView = {
  /** The bold upper-case word of the title row; '' for the header and the message card. */
  title: string
  /** The rest of the title row after the title, spaces trimmed: the headline value, or the column headers of a matrix. */
  value: string
  width: number
  /** Every rendered line of the card, borders included. */
  raw: string[]
  /** The rows after the title row, borders and padding off, trailing blanks off. */
  body: string[]
  node: Node
}

const strip = (line: string): string => line.slice(2, -2).trimEnd()

const cardView = (n: Node): CardView => {
  const width = num(n.props?.width) ?? naturalWidth(n)
  const raw = renderNode(n, width)
  // a section has no border: its rows are the whole of it
  const interior = n.props?.borderStyle ? raw.slice(1, -1).map(strip) : raw.map(l => l.trimEnd())
  const rows = kidsOf(n).filter(isNode)
  const first = rows[0]
  const firstTexts = first ? (first.type === 'Text' ? [first] : kidsOf(first).filter(isNode)) : []
  const head = firstTexts[0]
  const isTitle = head !== undefined && head.type === 'Text' && head.props?.bold === true && /^[A-Z0-9]+$/.test(textOf(head))
  return {
    title: isTitle ? textOf(head!) : '',
    value: isTitle ? interior[0]!.slice(textOf(head!).length).trim() : '',
    width,
    raw,
    body: isTitle ? interior.slice(1) : interior,
    node: n,
  }
}

export type PaneParts = {
  /** The whole pane as text. */
  lines: string[]
  /** Every card in the order it is drawn; the header is the first. */
  cards: CardView[]
  /** The lines that are not in a card. */
  footer: string[]
}

const isCardBox = (n: Node): boolean =>
  n.type === 'Box' && (n.props?.borderStyle !== undefined || (typeof n.props?.width === 'number' && isColumn(n)))

/** The pane's tree taken apart: its cards (side by side or not), and the footer lines under them. */
export const paneParts = (tree: unknown, columns: number): PaneParts => {
  const root = tree as Node
  const cards: CardView[] = []
  const footer: string[] = []
  const inner = columns - 2
  for (const block of kidsOf(root).filter(isNode)) {
    if (isCardBox(block)) cards.push(cardView(block))
    else {
      const kids = kidsOf(block).filter(isNode)
      if (kids.length > 0 && kids.every(isCardBox)) for (const k of kids) cards.push(cardView(k))
      else footer.push(...renderNode(block, inner).map(l => l.trimEnd()).filter(l => l !== ''))
    }
  }
  return { lines: renderTree(tree, columns), cards, footer }
}

export const cardTitled = (parts: PaneParts, title: string): CardView | undefined => parts.cards.find(c => c.title === title)

/** Where something in a tree is wider than the room it is given: empty when everything fits. */
export const findOverflow = (n: Node, avail: number, path = 'root'): string[] => {
  if (n.type === 'Text') return naturalWidth(n) > avail ? [`${path}: text of ${naturalWidth(n)} cells in ${avail}`] : []
  if (n.type === 'Raster') return naturalWidth(n) > avail ? [`${path}: raster of ${naturalWidth(n)} cells in ${avail}`] : []
  const p = n.props ?? {}
  const W = num(p.width) ?? avail
  const problems: string[] = W > avail ? [`${path}: box of ${W} cells in ${avail}`] : []
  const inner = W - (p.borderStyle ? 2 : 0) - 2 * (num(p.paddingX) ?? num(p.padding) ?? 0)
  const kids = kidsOf(n).filter(isNode)
  if (isColumn(n)) {
    kids.forEach((k, i) => problems.push(...findOverflow(k, k.type === 'Box' ? Math.min(inner, naturalWidth(k)) : inner, `${path}>${k.type}${i}`)))
  } else {
    const total = kids.map(naturalWidth).reduce((a, b) => a + b, 0) + gapOf(p) * Math.max(0, kids.length - 1)
    if (total > inner) problems.push(`${path}: row of ${total} cells in ${inner}`)
    kids.forEach((k, i) => problems.push(...findOverflow(k, naturalWidth(k), `${path}>${k.type}${i}`)))
  }
  return problems
}
