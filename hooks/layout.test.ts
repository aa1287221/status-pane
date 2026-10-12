import { describe, expect, test } from 'claude-code/testing'

import { MOCKUP_AT, QUIET_HINT, makeSnap, pair, right } from './fixture'
import { dw, tailText } from './model'
import {
  BORDER,
  HIST_MAX,
  LOWER,
  MIN_W,
  PALETTE,
  PARTIAL,
  ROWS_FILE_HINT,
  chartHeight,
  chartRaster,
  clipStart,
  clipText,
  fitLine,
  gaugeCells,
  gaugeRaster,
  layoutTree,
  packRows,
  paneLayout,
  sparkText,
  splitWidths,
  textGauge,
  tierOf,
  wrapWords,
} from './pane'
import type { Layout, PaneView } from './pane'
import type { Res, RowKey, Snap } from './state'
import { FAKE_ELS, FAKE_ELS_PLAIN, decodeCells, findOverflow, isNode, kidsOf, paneParts, rasterCells, renderTree, textOf } from './tree'
import type { DecodedCell, Node } from './tree'

const bad = (why: string): Res<never> => ({ ok: false, why })

/** Sixteen CPU readings, the newest 12% as the snapshot says. */
const HIST = [2, 5, 9, 14, 22, 35, 50, 70, 100, 60, 30, 12, 6, 4, 8, 12]

const view = (columns: number, over: Partial<PaneView> = {}): PaneView => ({
  columns,
  nowMs: MOCKUP_AT,
  tzMin: 0,
  raster: true,
  cpuHist: HIST,
  ...over,
})
const layoutAt = (snap: Snap | null, columns: number, over?: Partial<PaneView>): Layout => paneLayout(snap, view(columns, over))
const treeAt = (snap: Snap | null, columns: number, over?: Partial<PaneView>): Node =>
  layoutTree(layoutAt(snap, columns, over), over?.raster === false ? FAKE_ELS_PLAIN : FAKE_ELS) as unknown as Node
const partsAt = (snap: Snap | null, columns: number, over?: Partial<PaneView>) => paneParts(treeAt(snap, columns, over), columns)
const textAt = (snap: Snap | null, columns: number, over?: Partial<PaneView>) => renderTree(treeAt(snap, columns, over), columns)
const nodesOf = (n: Node, type: string): Node[] => [
  ...(n.type === type ? [n] : []),
  ...kidsOf(n)
    .filter(isNode)
    .flatMap(k => nodesOf(k, type)),
]
/** A clipped pane marks the cut on a row of its own; the marker may carry a note after it. */
const marked = (lines: string[]): boolean => lines.some(l => l.startsWith('↓ more'))
const bandsOf = (l: Layout): string[][] => l.blocks.flatMap(b => (b.kind === 'cards' ? [b.cards.map(c => `${c.id}:${c.width}`)] : []))

/** The snapshot with some rows switched off in the rows file. */
const without = (...keys: RowKey[]): Snap => {
  const base = makeSnap()
  return makeSnap({ toggles: { enabled: true, rows: { ...base.toggles.rows, ...Object.fromEntries(keys.map(k => [k, false])) } } })
}

/** A snapshot whose mcp servers are all up: the header names a server that is down, which the header tests are not about. */
const CALM_MCP = { ok: true as const, v: { total: 6, healthy: 6, bad: [] } }
const calm = (over: Partial<Snap> = {}): Snap => makeSnap({ mcp: CALM_MCP, ...over })
const calmWithout = (...keys: RowKey[]): Snap => calm({ toggles: without(...keys).toggles })

/** A raster's cells as the text a terminal would show: a track cell is a shaded one. */
const shown = (cells: readonly DecodedCell[]): string => cells.map(c => (c.fg === c.bg ? '░' : c.glyph)).join('')
const hex = (rgb: number): string => `#${rgb.toString(16).padStart(6, '0')}`
const rgbOf = (color: string): number => Number.parseInt(color.slice(1), 16)

describe('breakpoints: the pane is bodyColumns - 2 wide and its tier follows', () => {
  test('narrow below 40, medium to 79, wide from 80', () => {
    expect([MIN_W, 39, 40, 79, 80, 200].map(tierOf)).toEqual(['narrow', 'narrow', 'medium', 'medium', 'wide', 'wide'])
    expect([41, 42, 81, 82].map(columns => layoutAt(makeSnap(), columns).tier)).toEqual(['narrow', 'medium', 'medium', 'wide'])
  })

  test('narrow (w=34): every card full width, stacked', () => {
    expect(bandsOf(layoutAt(makeSnap(), 36))).toEqual([
      ['header:34'],
      ['context:34'],
      ['5h:34'],
      ['7d:34'],
      ['cost:34'],
      ['git:34'],
      ['activity:34'],
      ['system:34'],
    ])
  })

  test('medium (w=47): the context alone, 5H beside 7D, COST beside a narrower GIT, then ACTIVITY and SYSTEM alone', () => {
    expect(bandsOf(layoutAt(makeSnap(), 49))).toEqual([
      ['header:47'],
      ['context:47'],
      ['5h:23', '7d:23'],
      ['cost:24', 'git:22'],
      ['activity:47'],
      ['system:47'],
    ])
  })

  test('wide (w=87): three across twice, then SYSTEM across the whole width; the header on two rows', () => {
    const layout = layoutAt(makeSnap(), 89)
    expect(bandsOf(layout)).toEqual([['header:87'], ['context:29', '5h:28', '7d:28'], ['cost:29', 'git:28', 'activity:28'], ['system:87']])
    const header = layout.blocks[0]
    expect(header?.kind === 'cards' ? header.cards[0]?.rows.length : -1).toBe(2)
  })

  test('the edge at 39 and 40: stacked, then a pair', () => {
    expect(bandsOf(layoutAt(makeSnap(), 41)).slice(1)).toEqual([
      ['context:39'],
      ['5h:39'],
      ['7d:39'],
      ['cost:39'],
      ['git:39'],
      ['activity:39'],
      ['system:39'],
    ])
    expect(bandsOf(layoutAt(makeSnap(), 42)).slice(1)).toEqual([
      ['context:40'],
      ['5h:20', '7d:19'],
      ['cost:20', 'git:19'],
      ['activity:40'],
      ['system:40'],
    ])
  })

  test('the edge at 79 and 80: a pair, then three across', () => {
    expect(bandsOf(layoutAt(makeSnap(), 81)).slice(1)).toEqual([
      ['context:79'],
      ['5h:39', '7d:39'],
      ['cost:39', 'git:39'],
      ['activity:79'],
      ['system:79'],
    ])
    expect(bandsOf(layoutAt(makeSnap(), 82)).slice(1)).toEqual([
      ['context:26', '5h:26', '7d:26'],
      ['cost:26', 'git:26', 'activity:26'],
      ['system:80'],
    ])
  })

  test('cards share the width with a cell between them, the left ones taking the odd cells', () => {
    expect(splitWidths(47, 2)).toEqual([23, 23])
    expect(splitWidths(40, 2)).toEqual([20, 19])
    expect(splitWidths(87, 3)).toEqual([29, 28, 28])
    expect(splitWidths(34, 1)).toEqual([34])
  })

  test('ACTIVITY and SYSTEM are cards at every breakpoint, and there is no footer under them', () => {
    for (const columns of [36, 49, 89]) {
      const parts = partsAt(makeSnap(), columns)
      expect(parts.cards.map(c => c.title)).toEqual(['', 'CONTEXT', '5H', '7D', 'COST', 'GIT', 'ACTIVITY', 'SYSTEM'])
      expect(parts.footer).toEqual([])
    }
  })

  test('below 22 columns the cards stay 20 wide', () => {
    expect(layoutAt(makeSnap(), 10).w).toBe(MIN_W)
  })
})

describe('gauges: partial blocks on a track, eight steps to a cell', () => {
  const glyphs = (pct: number, columns: number) =>
    gaugeCells(pct, columns)
      .map(c => c.glyph)
      .join('')

  test('a bar of 20 cells fills to an eighth', () => {
    expect(glyphs(0, 20)).toBe('░'.repeat(20))
    expect(glyphs(49, 20)).toBe(`${'█'.repeat(9)}▊${'░'.repeat(10)}`)
    expect(glyphs(50, 20)).toBe(`${'█'.repeat(10)}${'░'.repeat(10)}`)
    expect(glyphs(79, 20)).toBe(`${'█'.repeat(15)}▊${'░'.repeat(4)}`)
    expect(glyphs(80, 20)).toBe(`${'█'.repeat(16)}${'░'.repeat(4)}`)
    expect(glyphs(100, 20)).toBe('█'.repeat(20))
  })

  test('the leading partial cell is one of the seven left blocks', () => {
    expect(PARTIAL).toEqual(['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'])
    expect([12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100].map(p => glyphs(p, 1))).toEqual(['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'])
  })

  test('a reading above 0 shows at least an eighth, one below 0 or above 100 is clamped, junk reads 0', () => {
    expect(glyphs(1, 5)).toBe('▏░░░░')
    expect(glyphs(150, 4)).toBe('████')
    expect(glyphs(-5, 4)).toBe('░░░░')
    expect(glyphs(Number.NaN, 4)).toBe('░░░░')
  })

  test('the text fallback is the same bar: the fill in its tone, the track dim', () => {
    expect(textGauge(49, 20)).toEqual([
      { text: `${'█'.repeat(9)}▊`, color: PALETTE.green },
      { text: '░'.repeat(10), dim: true },
    ])
    expect(textGauge(0, 4)).toEqual([{ text: '░░░░', dim: true }])
    expect(textGauge(100, 4)).toEqual([{ text: '████', color: PALETTE.red }])
  })

  const FILL = rgbOf(PALETTE.green)
  const TRACK = rgbOf(PALETTE.track)
  // fill length (cells with the tone), its colour, and the leading partial glyph
  const CASES: [number, number, string, string][] = [
    [0, 0, '', ''],
    [49, 10, PALETTE.green, '▊'],
    [50, 10, PALETTE.yellow, ''],
    [79, 16, PALETTE.yellow, '▊'],
    [80, 16, PALETTE.red, ''],
    [100, 20, PALETTE.red, ''],
  ]
  for (const [pct, fill, color, partial] of CASES) {
    test(`a Raster at ${pct}%: ${fill} cells filled${color ? ` in ${color}` : ''}${partial ? `, the last one ${partial}` : ''}`, () => {
      const raster = gaugeRaster(pct, 20)
      expect([raster.columns, raster.rows]).toEqual([20, 1])
      const cells = decodeCells(raster.cells)
      expect(cells).toHaveLength(20)
      const filled = cells.filter(c => c.fg !== c.bg)
      expect(filled).toHaveLength(fill)
      if (color) expect(filled.every(c => c.fg === rgbOf(color))).toBe(true)
      expect(cells.slice(fill).every(c => c.fg === TRACK && c.bg === TRACK)).toBe(true)
      expect(cells.every(c => c.bg === TRACK)).toBe(true)
      // the cells before the partial one are full blocks
      const full = partial ? fill - 1 : fill
      expect(filled.slice(0, full).every(c => c.glyph === '█')).toBe(true)
      expect(partial ? filled[fill - 1]?.glyph : '').toBe(partial)
    })
  }

  test('the tones are green below 50, yellow below 80, red from 80', () => {
    const tone = (pct: number) => hex(decodeCells(gaugeRaster(pct, 10).cells)[0]!.fg)
    expect([1, 49, 50, 79, 80, 100].map(tone)).toEqual([
      PALETTE.green,
      PALETTE.green,
      PALETTE.yellow,
      PALETTE.yellow,
      PALETTE.red,
      PALETTE.red,
    ])
    expect(FILL).toBe(0x3fb950)
  })

  test('a Raster cell is three little-endian u32 words in padded base64', () => {
    const { cells } = gaugeRaster(100, 1)
    // U+2588, then red 0xf85149 and the grey track 0x30363d, each as four bytes with the low one first
    expect(cells).toBe(btoa(String.fromCharCode(0x88, 0x25, 0, 0, 0x49, 0x51, 0xf8, 0, 0x3d, 0x36, 0x30, 0)))
  })
})

describe('the CPU history: a two-row area chart, newest at the right edge', () => {
  test('the height is sixteenths of a fixed 0..100% axis, a reading above 0 at least one', () => {
    expect([0, 1, 3, 5, 6, 50, 100, 150, -3].map(chartHeight)).toEqual([0, 1, 1, 1, 1, 8, 16, 16, 0])
  })

  test('16 samples are 16 columns: the bottom row fills first, the top row from half height', () => {
    const raster = chartRaster(HIST, HIST_MAX)
    expect([raster.columns, raster.rows]).toEqual([16, 2])
    const cells = rasterCells({ type: 'Raster', props: { ...raster } })
    expect(shown(cells.slice(0, 16))).toBe('░░░░░░░▃█▂░░░░░░')
    expect(shown(cells.slice(16))).toBe('▁▁▁▂▄▆████▅▂▁▁▁▂')
  })

  test('each column takes the tone of its own reading', () => {
    const cells = decodeCells(chartRaster(HIST, HIST_MAX).cells).slice(16)
    expect([0, 5, 7, 8].map(i => hex(cells[i]!.fg))).toEqual([PALETTE.green, PALETTE.green, PALETTE.yellow, PALETTE.red])
    expect(cells.every(c => c.bg === rgbOf(PALETTE.track))).toBe(true)
  })

  test('fewer than 16 samples sit at the right, the columns before them empty', () => {
    const cells = decodeCells(chartRaster([10, 100], 16).cells)
    expect(shown(cells.slice(0, 16))).toBe(`${'░'.repeat(15)}█`)
    expect(shown(cells.slice(16))).toBe(`${'░'.repeat(14)}▂█`)
  })

  test('samples that are all equal are a flat band at their own height', () => {
    const cells = decodeCells(chartRaster(Array(16).fill(50), 16).cells)
    expect(shown(cells.slice(0, 16))).toBe('░'.repeat(16))
    expect(shown(cells.slice(16))).toBe('█'.repeat(16))
    const low = decodeCells(chartRaster(Array(16).fill(1), 16).cells)
    expect(shown(low.slice(16))).toBe('▁'.repeat(16))
  })

  test('no samples is an empty track; more than the columns keeps the newest', () => {
    expect(shown(decodeCells(chartRaster([], 8).cells))).toBe('░'.repeat(16))
    const cells = decodeCells(chartRaster([100, 100, 100, 0, 0, 0, 100], 4).cells)
    expect(shown(cells.slice(4))).toBe('░░░█')
  })

  test('as text: a glyph per sample on the same axis, the newest columns when there are more', () => {
    expect(sparkText([0, 50, 100], 16)).toBe('▁▅█')
    expect(sparkText([30, 30, 30], 16)).toBe('▃▃▃')
    expect(sparkText([1, 2, 3, 100], 2)).toBe('▁█')
    expect(sparkText([], 16)).toBe('')
    expect(LOWER).toEqual(['', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'])
  })
})

describe('text fitting: cut with an ellipsis, by display width', () => {
  test('clipText keeps what fits and ends in …; CJK counts two cells', () => {
    expect(clipText('abcdef', 4)).toBe('abc…')
    expect(clipText('abc', 3)).toBe('abc')
    expect(clipText('遷移statusline', 5)).toBe('遷移…')
    expect(clipText('遷移statusline', 4)).toBe('遷…')
    expect(clipText('x', 0)).toBe('')
    expect(clipText('foo bar baz', 9)).toBe('foo bar…')
  })

  test('clipStart keeps the end, the way a path loses its head', () => {
    expect(clipStart('/a/b/c/dddd', 7)).toBe('…c/dddd')
    expect(clipStart('/a/b', 9)).toBe('/a/b')
    expect(clipStart('目錄目錄目錄', 5)).toBe('…目錄')
  })

  test('fitLine cuts across segments and puts the … in the style of the one it fell in', () => {
    const line = fitLine([{ text: 'abc', dim: true }, { text: 'defgh', color: 'red' }], 6)
    expect(line.map(s => s.text).join('')).toBe('abcde…')
    expect(line.at(-1)).toEqual({ text: '…', color: 'red' })
    expect(fitLine([{ text: 'abc' }], 3)).toEqual([{ text: 'abc' }])
    expect(fitLine([{ text: 'abc' }], 0)).toEqual([])
    // no space is left in front of the …, even one that ended a segment
    const spaced = fitLine([{ text: 'ab ', dim: true }, { text: 'cdef', color: 'red' }], 4)
    expect(spaced.map(s => s.text).join('')).toBe('ab…')
  })

  test('wrapWords wraps at spaces, and breaks a word wider than the line over rows instead of cutting it', () => {
    expect(wrapWords('waiting for the first refresh', 16)).toEqual(['waiting for the', 'first refresh'])
    expect(wrapWords('aaaaaaaaaaaaaaaaaaaa', 8)).toEqual(['aaaaaaaa', 'aaaaaaaa', 'aaaa'])
    expect(wrapWords('', 8)).toEqual([])
    expect(wrapWords('abc', 0)).toEqual([])
  })

  test('a long word breaks after a path separator when there is one in its second half', () => {
    expect(wrapWords('open ~/.claude/cc-statusline-rows.json', 30)).toEqual(['open', '~/.claude/cc-statusline-', 'rows.json'])
    expect(wrapWords('a/b/c/d/e/f/g/h/i', 6)).toEqual(['a/b/c/', 'd/e/f/', 'g/h/i'])
    // a slash is a better place to break than a hyphen, and the words after the long one follow its last piece
    expect(wrapWords('abcdefgh/ij-klmnopqrs', 12)).toEqual(['abcdefgh/', 'ij-klmnopqrs'])
    expect(wrapWords('~/.claude/cc-statusline-rows.json abc', 30)).toEqual(['~/.claude/cc-statusline-', 'rows.json abc'])
    expect(wrapWords('遷移到面板的討論與實作設計', 8)).toEqual(['遷移到面', '板的討論', '與實作設', '計'])
  })

  test('packRows puts parts side by side while they fit, else one per row', () => {
    const p = (text: string) => [{ text }]
    const rows = packRows([p('aaa'), p('bbb'), p('cc')], 9, 2)
    expect(rows.map(r => r.map(s => s.text).join(''))).toEqual(['aaa  bbb', 'cc'])
    expect(packRows([p('aaaaaaaaaaaa')], 6, 2).map(r => r.map(s => s.text).join(''))).toEqual(['aaaaa…'])
  })

  test('packRows fills a row to its last cell, and an empty part leaves no gap behind it', () => {
    const p = (text: string) => [{ text }]
    const text = (rows: ReturnType<typeof packRows>) => rows.map(r => r.map(s => s.text).join(''))
    expect(text(packRows([p('aaa'), p('bbb')], 8, 2))).toEqual(['aaa  bbb'])
    expect(text(packRows([p('aaa'), p('bbb')], 7, 2))).toEqual(['aaa', 'bbb'])
    expect(text(packRows([p('aaa'), [], p('bbb')], 8, 2))).toEqual(['aaa  bbb'])
    expect(text(packRows([[], p('aaa')], 8, 2))).toEqual(['aaa'])
  })
})

describe('the header card', () => {
  test('medium: model, effort and version at the left, the liveness at the right; then the whole summary, and the session length', () => {
    const header = partsAt(calm(), 49).cards[0]!
    expect(header.title).toBe('')
    // the 40 cells of the summary and the 12 of the length do not share the 43 of a row
    expect(header.body).toEqual([`Opus 5.5 · max · v2.1.294${' '.repeat(11)}● 02:41`, '遷移 statusline 到 mod pane 的討論與實作', '1hr 20min'])
  })

  test('the session length ends the summary row to the last cell, and a cell more sends it to a row of its own', () => {
    const body = (n: number) => partsAt(calm({ summary: { ok: true, v: 's'.repeat(n) } }), 49).cards[0]!.body.slice(1)
    // 31 and the 12 of ` · 1hr 20min` are the 43 cells of the card
    expect(body(31)).toEqual([`${'s'.repeat(31)} · 1hr 20min`])
    expect(body(32)).toEqual(['s'.repeat(32), '1hr 20min'])
  })

  test('the liveness shares the model row to the last cell, and a cell more sends it to the last summary row', () => {
    // 'Opus-Nameeeeeeeeee · max · v2.1.294' is 35 cells, and 35 and 7 with a blank are the 43 of the card
    const body = (name: string) => partsAt(calm({ model: { ok: true, v: { name, version: '2.1.294', effort: 'max' } } }), 49).cards[0]!.body
    expect(body('Opus-Nameeeeeeeeee')[0]).toBe('Opus-Nameeeeeeeeee · max · v2.1.294 ● 02:41')
    // a cell more: the summary row (the length, on a row of its own at this width) has the room, so no row is wasted
    expect(body('Opus-Nameeeeeeeeeee')).toEqual([
      'Opus-Nameeeeeeeeeee · max · v2.1.294',
      '遷移 statusline 到 mod pane 的討論與實作',
      `1hr 20min${' '.repeat(43 - 9 - 7)}● 02:41`,
    ])
  })

  test('narrow: when line 1 cannot hold the liveness it goes to the right end of the summary row, so there is no orphan row', () => {
    // 38 columns: w=36, 32 cells inside; 'Opus 5.5 · max · v2.1.294' and ' ● 02:41' are 33
    const header = partsAt(calm(), 38).cards[0]!
    expect(header.body).toEqual(['Opus 5.5 · max · v2.1.294', '遷移 statusline 到 mod pane', `的討論與實作 · 1hr 20min ● 02:41`])
    expect(header.body.every(row => row.trim() !== '' && !/^ +● /.test(row))).toBe(true)
  })

  test('narrow: with neither line able to hold the liveness it takes a row of its own at the right edge', () => {
    // no length (cost off) and a summary of 30 cells: 30 and 8 do not fit 32, nor does the model row
    const snap = calm({ summary: { ok: true, v: 'a'.repeat(30) }, toggles: calmWithout('cost').toggles })
    expect(partsAt(snap, 38).cards[0]!.body).toEqual(['Opus 5.5 · max · v2.1.294', `${' '.repeat(25)}● 02:41`, 'a'.repeat(30)])
    // a summary of 24 cells leaves room beside it
    const roomy = calm({ summary: { ok: true, v: 'a'.repeat(24) }, toggles: calmWithout('cost').toggles })
    expect(partsAt(roomy, 38).cards[0]!.body).toEqual(['Opus 5.5 · max · v2.1.294', `${'a'.repeat(24)} ● 02:41`])
  })

  test('without the model row the liveness ends the summary row, and the version is left out when there is none', () => {
    const short = calm({ summary: { ok: true, v: 'short' } })
    expect(partsAt({ ...short, toggles: calmWithout('model').toggles }, 49).cards[0]!.body).toEqual([`short · 1hr 20min${' '.repeat(43 - 17 - 7)}● 02:41`])
    const noVersion = calm({ model: { ok: true, v: { name: 'Opus 5.5', version: '', effort: 'low' } } })
    expect(partsAt(noVersion, 49).cards[0]!.body[0]).toBe(`Opus 5.5 · low${' '.repeat(22)}● 02:41`)
  })

  test('a summary that leaves room shares its row with the session length', () => {
    const short = calm({ summary: { ok: true, v: 'a short summary' } })
    expect(partsAt(short, 49).cards[0]!.body.slice(1)).toEqual(['a short summary · 1hr 20min'])
  })

  test('narrow: the model row has no room for the liveness beside it, so the liveness takes a row at the right edge', () => {
    const header = partsAt(calm(), 36).cards[0]!
    expect(header.body).toEqual([
      'Opus 5.5 · max · v2.1.294',
      `${' '.repeat(23)}● 02:41`,
      '遷移 statusline 到 mod pane',
      '的討論與實作 · 1hr 20min',
    ])
  })

  test('wide: everything on one row when the summary and the length fit between the model and the liveness', () => {
    const short = calm({ summary: { ok: true, v: 'a short summary' } })
    const header = partsAt(short, 89).cards[0]!
    expect(header.body).toHaveLength(1)
    expect(header.body[0]).toMatch(/^Opus 5\.5 · max · v2\.1\.294 +a short summary · 1hr 20min +● 02:41$/)
  })

  test('wide: a summary of two rows is not cut down to the one that would fit between: both rows show', () => {
    const two = calm({ summary: { ok: true, v: `${'a'.repeat(40)} ${'b'.repeat(50)}` } })
    expect(partsAt(two, 89).cards[0]!.body).toEqual([
      `Opus 5.5 · max · v2.1.294${' '.repeat(51)}● 02:41`,
      'a'.repeat(40),
      `${'b'.repeat(50)} · 1hr 20min`,
    ])
  })

  test('wide: a summary that does not fit between takes a row of its own, whole, with the session length', () => {
    const header = partsAt(calm(), 89).cards[0]!
    expect(header.body).toEqual([`Opus 5.5 · max · v2.1.294${' '.repeat(51)}● 02:41`, '遷移 statusline 到 mod pane 的討論與實作 · 1hr 20min'])
  })

  test('the model is bold cyan, the effort has its own colour; an unknown effort is left out, with no orphan separator', () => {
    const segs = (snap: Snap) => {
      const l = layoutAt(snap, 49)
      const card = l.blocks[0]?.kind === 'cards' ? l.blocks[0].cards[0]! : null
      const row = card?.rows[0]
      return row?.kind === 'split' ? row.parts[0]! : []
    }
    expect(segs(calm())[0]).toEqual({ text: 'Opus 5.5', color: 'cyan', bold: true })
    expect(segs(calm())[1]).toEqual({ text: ' · ', dim: true })
    expect(segs(calm())[2]).toEqual({ text: 'max', color: 'red' })
    expect(segs(calm())[4]).toEqual({ text: 'v2.1.294', dim: true })
    const unknown = calm({ model: { ok: true, v: { name: 'Opus 5.5', version: '2.1.294', effort: null } } })
    expect(segs(unknown)).toEqual([{ text: 'Opus 5.5', color: 'cyan', bold: true }, { text: ' · ', dim: true }, { text: 'v2.1.294', dim: true }])
    expect(partsAt(unknown, 49).cards[0]!.body[0]).toBe(`Opus 5.5 · v2.1.294${' '.repeat(17)}● 02:41`)
    for (const columns of [36, 49, 89]) expect(partsAt(unknown, columns).cards[0]!.body.join(' ')).not.toContain('?')
    const low = calm({ model: { ok: true, v: { name: 'Opus 5.5', version: '', effort: 'low' } } })
    expect(segs(low)).toEqual([{ text: 'Opus 5.5', color: 'cyan', bold: true }, { text: ' · ', dim: true }, { text: 'low', dim: true }])
    const bare = calm({ model: { ok: true, v: { name: 'Opus 5.5', version: '', effort: null } } })
    expect(segs(bare)).toEqual([{ text: 'Opus 5.5', color: 'cyan', bold: true }])
  })

  test('an effort the settings name is dim whatever its level, the level a hook reported has its colour', () => {
    const model = (effort: string, configured?: boolean): Snap =>
      calm({ model: { ok: true, v: { name: 'Opus 5.5', version: '2.1.294', effort, ...(configured === undefined ? {} : { configured }) } } })
    const effortSeg = (snap: Snap) => {
      const l = layoutAt(snap, 49)
      const card = l.blocks[0]?.kind === 'cards' ? l.blocks[0].cards[0]! : null
      const row = card?.rows[0]
      return row?.kind === 'split' ? row.parts[0]![2] : undefined
    }
    expect(effortSeg(model('max', true))).toEqual({ text: 'max', dim: true })
    expect(effortSeg(model('xhigh', true))).toEqual({ text: 'xhigh', dim: true })
    expect(effortSeg(model('max', false))).toEqual({ text: 'max', color: 'red' })
    // a snapshot written before the field existed was all live readings
    expect(effortSeg(model('max'))).toEqual({ text: 'max', color: 'red' })
    const dimmed = nodesOf(treeAt(model('max', true), 49), 'Text').find(t => textOf(t) === 'max')!
    expect(dimmed.props).toMatchObject({ dimColor: true })
    expect(dimmed.props?.color).toBeUndefined()
    const live = nodesOf(treeAt(model('max', false), 49), 'Text').find(t => textOf(t) === 'max')!
    expect(live.props).toMatchObject({ color: 'red' })
    expect(live.props?.dimColor).toBeUndefined()
    // the text is the same either way
    expect(partsAt(model('max', true), 49).cards[0]!.body[0]).toBe(partsAt(model('max', false), 49).cards[0]!.body[0])
  })

  test('the liveness dot is green with the time; past 90 s yellow with the age, past 300 s red', () => {
    const live = (ageS: number) => {
      const l = layoutAt(calm(), 49, { nowMs: MOCKUP_AT + ageS * 1000 })
      const row = l.blocks[0]?.kind === 'cards' ? l.blocks[0].cards[0]!.rows[0] : undefined
      return row?.kind === 'split' ? row.parts[1]! : []
    }
    expect(live(0)).toEqual([{ text: '●', color: PALETTE.green }, { text: ' 02:41', dim: true }])
    expect(live(90)[0]?.color).toBe(PALETTE.green)
    expect(live(91)).toEqual([{ text: '●', color: PALETTE.yellow }, { text: ' stale 91s', color: PALETTE.yellow }])
    expect(live(300)[0]?.color).toBe(PALETTE.yellow)
    expect(live(301)).toEqual([{ text: '●', color: PALETTE.red }, { text: ' stale 301s', color: PALETTE.red }])
    expect(partsAt(calm(), 49, { nowMs: MOCKUP_AT + 120_000 }).cards[0]!.body[0]).toContain('● stale 120s')
  })

  test('a model row too long for the card goes over two rows: a name too long loses its head, the effort and the version follow', () => {
    const long = calm({ model: { ok: true, v: { name: 'Mx'.repeat(30), version: '2.1.294', effort: 'max' } } })
    expect(partsAt(long, 49).cards[0]!.body.slice(0, 2)).toEqual([`…${'Mx'.repeat(21)}`, `max · v2.1.294${' '.repeat(22)}● 02:41`])
  })

  test('narrow: a long model name and the effort and version still show, the liveness under them', () => {
    const named = calm({ model: { ok: true, v: { name: 'Opus 5.5 [1m]', version: '2.1.294', effort: 'xhigh' } } })
    expect(partsAt(named, 36).cards[0]!.body.slice(0, 3)).toEqual(['Opus 5.5 [1m] · xhigh', `v2.1.294${' '.repeat(15)}● 02:41`, '遷移 statusline 到 mod pane'])
  })

  test('wide: the middle gets what is left after the model, the liveness and two cells either side', () => {
    const row = (summary: string) => partsAt(calm({ summary: { ok: true, v: summary } }), 89).cards[0]!.body
    // 83 inner cells less the 7 of the liveness, the 25 of the model and 4 for the gaps leave 47, and ` · 1hr 20min` takes 12
    expect(row('s'.repeat(35))).toHaveLength(1)
    expect(row('s'.repeat(35))[0]).toContain(`${'s'.repeat(35)} · 1hr 20min`)
    expect(row('s'.repeat(36))).toHaveLength(2)
    expect(row('s'.repeat(36))[1]).toBe(`${'s'.repeat(36)} · 1hr 20min`)
  })

  test('wide: a model name that leaves no room between sends the summary to its own row', () => {
    const long = calm({ model: { ok: true, v: { name: 'M'.repeat(53), version: '2.1.294', effort: 'max' } } })
    const body = partsAt(long, 89).cards[0]!.body
    expect(body).toHaveLength(2)
    expect(body[0]!.startsWith(`${'M'.repeat(53)} · max · v2.1.294`)).toBe(true)
    expect(body[1]).toBe('遷移 statusline 到 mod pane 的討論與實作 · 1hr 20min')
  })

  test('a model or summary that failed says nothing when its row is switched off', () => {
    const base = calm()
    const off = calm({
      model: bad('no model'),
      summary: bad('no summary'),
      toggles: { enabled: true, rows: { ...base.toggles.rows, model: false, summary: false } },
    })
    for (const columns of [36, 49, 89]) expect(partsAt(off, columns).cards[0]!.body.join(' ')).not.toContain('n/a')
  })

  test('a CJK summary wraps by display width and is whole at every width, the session length after it', () => {
    for (const columns of [36, 42, 49, 60, 79, 89]) {
      const body = partsAt(calm(), columns).cards[0]!.body
      expect(body.every(row => dw(row) <= columns - 2 - 4)).toBe(true)
      expect(body.slice(1).join(' ')).toContain('遷移 statusline 到 mod pane')
      expect(body.join(' ')).toContain('的討論與實作')
      expect(body.at(-1)).toMatch(/1hr 20min$/)
    }
  })

  test('a summary of more than two rows is cut with an ellipsis at the end of the second', () => {
    const long = calm({ summary: { ok: true, v: '長'.repeat(60) } })
    expect(partsAt(long, 49).cards[0]!.body.slice(1)).toEqual(['長'.repeat(21), `${'長'.repeat(21)}…`, '1hr 20min'])
  })

  test('the summary alone when the cost row is off, the length alone when the summary is', () => {
    expect(partsAt(calmWithout('cost'), 49).cards[0]!.body.slice(1)).toEqual(['遷移 statusline 到 mod pane 的討論與實作'])
    expect(partsAt(calmWithout('summary'), 49).cards[0]!.body).toEqual([`Opus 5.5 · max · v2.1.294${' '.repeat(11)}● 02:41`, '1hr 20min'])
  })

  test('with the model row off the liveness stays at the right edge, ending the last summary row', () => {
    const header = partsAt(calmWithout('model'), 49).cards[0]!
    expect(header.body).toHaveLength(2)
    expect(header.body.at(-1)).toBe(`1hr 20min${' '.repeat(43 - 9 - 7)}● 02:41`)
    // with no summary and no length either it has a row of its own
    const bare = calm({ toggles: calmWithout('model', 'summary', 'cost').toggles })
    expect(partsAt(bare, 49).cards[0]!.body).toEqual([`${' '.repeat(43 - 7)}● 02:41`])
  })

  test('a model or summary that failed says why in the header, in full', () => {
    const snap = calm({ model: bad('no session'), summary: bad('summary-updater.js and message-tracker.js hooks not configured') })
    const header = partsAt(snap, 49).cards[0]!
    expect(header.body).toEqual([
      'model n/a (no session)',
      'summary n/a (summary-updater.js and',
      'message-tracker.js hooks not configured)',
      `1hr 20min${' '.repeat(43 - 9 - 7)}● 02:41`,
    ])
  })
})

describe('the header card, stacked in wide', () => {
  test('a failed summary stacks under the model, in full, and the session length follows it', () => {
    const snap = calm({ summary: bad('summary-updater.js and message-tracker.js hooks not configured') })
    expect(partsAt(snap, 89).cards[0]!.body).toEqual([
      `Opus 5.5 · max · v2.1.294${' '.repeat(51)}● 02:41`,
      'summary n/a (summary-updater.js and message-tracker.js hooks not configured)',
      '1hr 20min',
    ])
  })
})

/** The card with that title in the pane at `columns`. */
const card = (snap: Snap, columns: number, title: string, over?: Partial<PaneView>) =>
  partsAt(snap, columns, over).cards.find(c => c.title === title)!
const ctx = (over: Partial<{ pct: number | null; used: number; max: number; compacts: Res<number> }> = {}): Snap =>
  calm({ context: { ok: true, v: { pct: 3, used: 32_000, max: 1_000_000, compacts: { ok: true, v: 0 }, ...over } } })
const cardsOf = (l: Layout) => l.blocks.flatMap(b => (b.kind === 'cards' ? b.cards : []))

describe('the gauge cards', () => {
  test('CONTEXT: the percentage in the title, the bar, then used and compact as two label/value pairs on one row', () => {
    const c = card(makeSnap(), 49, 'CONTEXT')
    expect(c.value).toBe('3%')
    expect(c.body).toEqual([`█▎${'░'.repeat(41)}`, pair('used 32.0K / 1.0M', 'compact 0', 43), QUIET_HINT])
  })

  test('the compact count is always told, 0 included, flush against the right edge', () => {
    const row = (compacts: Res<number>) => card(ctx({ compacts }), 49, 'CONTEXT').body[1]!
    expect(row({ ok: true, v: 0 })).toBe(pair('used 32.0K / 1.0M', 'compact 0', 43))
    expect(row({ ok: true, v: 2 })).toBe(pair('used 32.0K / 1.0M', 'compact 2', 43))
    expect(row({ ok: true, v: 12 })).toBe(pair('used 32.0K / 1.0M', 'compact 12', 43))
  })

  test('the pair goes to two rows only when it does not fit one: 29 cells hold it, 28 do not', () => {
    // a full-width card has columns - 6 cells inside
    expect(card(makeSnap(), 35, 'CONTEXT').body.slice(1)).toEqual([pair('used 32.0K / 1.0M', 'compact 0', 29), QUIET_HINT])
    expect(card(makeSnap(), 34, 'CONTEXT').body.slice(1)).toEqual([pair('used', '32.0K / 1.0M', 28), pair('compact', '0', 28), QUIET_HINT])
    expect(card(makeSnap(), 89, 'CONTEXT').body.slice(1)).toEqual([pair('used', '32.0K / 1.0M', 25), pair('compact', '0', 25), QUIET_HINT])
  })

  test('at w=36 (the 40-column dock) 127.8K / 1.0M and compact 12 still share one row, with a cell to spare; anything longer goes to two', () => {
    const wide = (used: number, compacts: number) => ctx({ used, compacts: { ok: true, v: compacts } })
    // 38 columns: w=36, 32 cells inside; 'used 127.8K / 1.0M' is 18, 'compact 12' is 10, and 3 between them
    expect(card(wide(127_800, 12), 38, 'CONTEXT').body.slice(1)).toEqual([pair('used 127.8K / 1.0M', 'compact 12', 32), QUIET_HINT])
    expect(card(wide(127_800, 123), 38, 'CONTEXT').body.slice(1)).toEqual([pair('used 127.8K / 1.0M', 'compact 123', 32), QUIET_HINT])
    expect(card(wide(127_800, 1234), 38, 'CONTEXT').body.slice(1)).toEqual([pair('used', '127.8K / 1.0M', 32), pair('compact', '1234', 32), QUIET_HINT])
  })

  test('a compact count that cannot be had is told in the body, dim, and the gauge stays', () => {
    const c = card(ctx({ compacts: bad('compact-monitor.js hook not configured') }), 49, 'CONTEXT')
    expect(c.body.slice(1)).toEqual([pair('used', '32.0K / 1.0M', 43), 'compact n/a (compact-monitor.js hook not', 'configured)', QUIET_HINT])
    expect(c.value).toBe('3%')
  })

  test('before the first response there is no reading: a dash in the title, a bare track, the window and the count stay', () => {
    const snap = ctx({ pct: null, used: 0 })
    const c = card(snap, 49, 'CONTEXT')
    expect(c.value).toBe('—')
    expect(c.body).toEqual(['░'.repeat(43), pair('used — / 1.0M', 'compact 0', 43), QUIET_HINT])
    // no fill in the Raster either: every cell is the track
    const gauge = nodesOf(treeAt(snap, 49), 'Raster').find(r => r.props?.key === 'gauge-context')!
    expect(rasterCells(gauge).every(c => c.fg === c.bg)).toBe(true)
  })

  test('tokens that are not there make the context unknown too, a percentage with them or not', () => {
    expect(card(ctx({ used: 0 }), 49, 'CONTEXT').value).toBe('—')
    expect(card(ctx({ pct: null }), 49, 'CONTEXT').value).toBe('—')
    expect(card(makeSnap(), 49, 'CONTEXT').value).toBe('3%')
  })

  test('the dash is dim, not in the colour of a reading', () => {
    const title = nodesOf(treeAt(ctx({ pct: null, used: 0 }), 49), 'Text').find(t => textOf(t) === '—' && t.props?.dimColor === true)
    expect(title).toBeDefined()
  })

  test('a window with no live reading anywhere is a dash and a bare track too, not 0%', () => {
    const unknown = { pct: null, resetSec: null }
    const quota = makeSnap({ quota: { ok: true, v: { five: unknown, seven: unknown } } })
    for (const columns of [36, 49, 89]) {
      for (const title of ['5H', '7D']) {
        const c = card(quota, columns, title)
        expect(c.value).toBe('—')
        expect(c.body).toEqual([expect.stringMatching(/^░+$/)])
      }
    }
    expect(nodesOf(treeAt(quota, 49), 'Raster').filter(r => String(r.props?.key).startsWith('gauge-5h')).every(r => rasterCells(r).every(c => c.fg === c.bg))).toBe(true)
  })

  test('a percentage that is not a number reads 0% in the title, not NaN%', () => {
    expect(card(ctx({ pct: Number.NaN, used: 1, max: 2 }), 49, 'CONTEXT').value).toBe('0%')
    const win = { pct: Number.NaN, resetSec: null }
    const quota = makeSnap({ quota: { ok: true, v: { five: win, seven: win } } })
    expect(partsAt(quota, 49).cards.filter(c => c.title === '5H' || c.title === '7D').map(c => c.value)).toEqual(['0%', '0%'])
  })

  test('a fraction is rounded in the title: 3.6 reads 4%', () => {
    expect(card(ctx({ pct: 3.6, used: 1, max: 2 }), 49, 'CONTEXT').value).toBe('4%')
    const quota = makeSnap({ quota: { ok: true, v: { five: { pct: 23.6, resetSec: null }, seven: { pct: 61.4, resetSec: null } } } })
    expect(partsAt(quota, 49).cards.filter(c => c.title === '5H' || c.title === '7D').map(c => c.value)).toEqual(['24%', '61%'])
  })

  test('a window that is not known reads a dash too', () => {
    expect(card(ctx({ max: 0 }), 49, 'CONTEXT').body[1]).toBe(pair('used 32.0K / —', 'compact 0', 43))
  })

  test('the value in the title and the fill take the tone of the reading', () => {
    const tones = (pct: number) => {
      const c = cardsOf(layoutAt(ctx({ pct, used: 1, max: 2 }), 49)).find(c => c.id === 'context')!
      const row = c.rows[0]
      return row?.kind === 'split' ? row.parts[1]![0]!.color : undefined
    }
    expect([10, 50, 80].map(tones)).toEqual([PALETTE.green, PALETTE.yellow, PALETTE.red])
  })

  test('5H and 7D: percentage, bar, then the countdown against the right edge, compact in medium and spaced in wide', () => {
    const medium = partsAt(makeSnap(), 49)
    const five = medium.cards.find(c => c.title === '5H')!
    const seven = medium.cards.find(c => c.title === '7D')!
    expect([five.value, seven.value]).toEqual(['23%', '61%'])
    // 19 cells inside: the countdown and the clock do not share the row, so the clock goes under, against the right edge
    expect(five.body).toEqual([`████▍${'░'.repeat(14)}`, pair('resets', '2h10m', 19), right('04:51', 19)])
    expect(seven.body).toEqual([`${'█'.repeat(11)}▋${'░'.repeat(7)}`, pair('resets', '3d4h', 19), right('Mon 06:41', 19)])
    const wide = partsAt(makeSnap(), 89)
    expect(wide.cards.find(c => c.title === '5H')!.body.slice(1)).toEqual([pair('resets', '2h 10m · 04:51', 24)])
    expect(wide.cards.find(c => c.title === '7D')!.body.slice(1)).toEqual([pair('resets', '3d 4h', 24), right('Mon 06:41', 24)])
  })

  test('a window with no reset time is the bar alone', () => {
    const none = makeSnap({ quota: { ok: true, v: { five: { pct: 0, resetSec: null }, seven: { pct: 0, resetSec: null } } } })
    const c = card(none, 49, '5H')
    expect(c.value).toBe('0%')
    expect(c.body).toEqual(['░'.repeat(19)])
  })

  test('even the narrowest pair (w=40) keeps the label beside the number', () => {
    expect(card(makeSnap(), 42, '7D').body[1]).toBe(pair('resets', '3d4h', 15))
  })
})

describe('the table style: bold accent titles, dim labels, values against the right edge', () => {
  const TITLES = ['CONTEXT', '5H', '7D', 'COST', 'GIT', 'ACTIVITY', 'SYSTEM']

  test('every title is bold in the accent colour; the headline value keeps the tone of its reading', () => {
    for (const columns of [36, 49, 89]) {
      const tree = treeAt(makeSnap(), columns)
      const found = nodesOf(tree, 'Text').filter(t => TITLES.includes(textOf(t)) && t.props?.bold === true)
      expect(found.map(textOf), `titles at ${columns}`).toEqual(TITLES)
      for (const t of found) expect(t.props).toMatchObject({ bold: true, color: 'cyan' })
    }
    const pct = nodesOf(treeAt(makeSnap(), 49), 'Text').find(t => textOf(t) === '3%')!
    expect(pct.props?.color).toBe(PALETTE.green)
    expect(pct.props?.bold).toBeUndefined()
  })

  test('the labels of a card are dim, its values are not', () => {
    const tree = treeAt(makeSnap(), 89)
    const dimOf = (text: string) => nodesOf(tree, 'Text').find(t => textOf(t) === text)?.props?.dimColor
    for (const label of ['branch', 'dir', 'lines', 'state', 'resets', 'used', 'compact', 'agents', 'edited', 'cpu', 'ram', 'mcp', 'memory']) {
      expect(dimOf(label), label).toBe(true)
    }
    for (const value of ['main', '~/project', '3%', '45%']) expect(dimOf(value), value).toBeUndefined()
  })

  test('the values of GIT, ACTIVITY and SYSTEM all end at the right edge of the card, at every breakpoint', () => {
    for (const columns of [36, 49, 89]) {
      const parts = partsAt(makeSnap(), columns)
      for (const title of ['GIT', 'ACTIVITY', 'SYSTEM']) {
        const c = parts.cards.find(c => c.title === title)!
        const inner = c.width - 4
        // the first row of the chart is the top of the drawing, shorter than the row
        const rows = c.body.filter(row => !/^ *[░▁▂▃▄▅▆▇█]+$/.test(row) && row !== 'agents' && row !== 'edited')
        expect(rows.length).toBeGreaterThan(2)
        for (const row of rows) expect(dw(row), `${title} at ${columns}: "${row}"`).toBe(inner)
      }
    }
  })
})

describe('COST: the scopes are written once as column headers', () => {
  const MATRIX = (inner: number) => ({
    head: 'session  total',
    rule: '─'.repeat(inner),
    dollars: '$'.padEnd(inner - 14) + '   3.20' + '  ' + '12.34',
    tokens: 'tokens'.padEnd(inner - 14) + '230.0K≈' + '  ' + '1.2M≈',
  })

  /** The same with `sess` for the session header and `tok` for the tokens row. */
  const SHORT = (inner: number) => ({
    rule: '─'.repeat(inner),
    dollars: '$'.padEnd(inner - 14) + '   3.20' + '  ' + '12.34',
    tokens: 'tok'.padEnd(inner - 14) + '230.0K≈' + '  ' + '1.2M≈',
  })

  test('narrow and wide: the headers on the title row, a hairline, then a row per measure', () => {
    for (const [columns, inner] of [[36, 30], [89, 25]] as const) {
      const m = MATRIX(inner)
      const c = card(makeSnap(), columns, 'COST')
      expect(c.value).toBe(m.head)
      expect(c.body).toEqual([m.rule, m.dollars, m.tokens])
      expect(c.raw[1]).toBe(`│ COST${' '.repeat(inner - 4 - 14)}session  total │`)
    }
  })

  test('the matrix holds down the chain: 22 cells inside are the full words, 20 and 21 are sess and tok, 19 are stacked rows', () => {
    // a full-width card has columns - 6 cells inside
    expect(card(makeSnap(), 28, 'COST').body).toEqual([MATRIX(22).rule, MATRIX(22).dollars, MATRIX(22).tokens])
    for (const [columns, inner] of [[27, 21], [26, 20]] as const) {
      const c = card(makeSnap(), columns, 'COST')
      expect(c.value, `${inner}`).toMatch(/^sess {2}total$/)
      expect(c.body, `${inner}`).toEqual([SHORT(inner).rule, SHORT(inner).dollars, SHORT(inner).tokens])
    }
    // 'tok session' and '230.0K≈' need 20 with the two cells between them: the value goes under its label
    expect(card(makeSnap(), 25, 'COST').body).toEqual([
      pair('$ session', '3.20', 19),
      'tok session',
      right('230.0K≈', 19),
      pair('$ total', '12.34', 19),
      pair('tok total', '1.2M≈', 19),
    ])
  })

  test('medium gives COST the 22 cells inside its sess and tok matrix needs, and GIT the 18 that are left', () => {
    const c = card(makeSnap(), 49, 'COST')
    expect(c.value).toBe('sess  total')
    expect(c.body).toEqual([SHORT(20).rule, SHORT(20).dollars, SHORT(20).tokens])
    expect(c.width).toBe(24)
    expect(card(makeSnap(), 49, 'GIT').width).toBe(22)
    // two cells more and the full words fit
    const full = card(makeSnap(), 51, 'COST')
    expect(full.value).toBe('session  total')
    expect(full.body).toEqual([MATRIX(22).rule, MATRIX(22).dollars, MATRIX(22).tokens])
  })

  test('the weighted pair: COST takes what its matrix needs while GIT keeps 17 cells inside, and gives it back when the equal share is enough', () => {
    const widths = (columns: number) => {
      const band = bandsOf(layoutAt(makeSnap(), columns)).find(b => b[0]?.startsWith('cost'))
      return band
    }
    // GIT keeps 17 cells inside (its longest usual row, 'lines' + 2 + '+120 −45 ≈'). w=48: sess and tok, 24 and 22; w=48 is
    // columns 50: the full words, 26 and 21; from columns 55 the equal share is enough
    expect(widths(49)).toEqual(['cost:24', 'git:22'])
    expect(widths(50)).toEqual(['cost:26', 'git:21'])
    expect(widths(54)).toEqual(['cost:26', 'git:25'])
    expect(widths(55)).toEqual(['cost:26', 'git:26'])
    expect(widths(56)).toEqual(['cost:27', 'git:26'])
    expect(widths(48)).toEqual(['cost:24', 'git:21'])
    // below that GIT would fall under 17 inside, so the shares stay equal and COST is stacked
    expect(widths(47)).toEqual(['cost:22', 'git:22'])
    expect(widths(42)).toEqual(['cost:20', 'git:19'])
  })

  test('the fallback chain with long figures: the full words, then sess and tok, then stacked rows, and no number is ever cut', () => {
    const big = makeSnap({
      cost: { ok: true, v: { all: 9876.54, session: 1234.56, durMin: 80 } },
      tokens: { ok: true, v: { all: 12_300_000, session: 2_300_000 } },
    })
    const kind = (columns: number) => {
      const c = card(big, columns, 'COST')
      return c.value.startsWith('session') ? 'full' : c.value.startsWith('sess') ? 'short' : 'stacked'
    }
    // the matrix needs 24 cells with the full words (6 + 2 + 7 + 2 + 7) and 22 with sess and tok (4 + 2 + 7 + 2 + 7)
    expect([54, 53, 52].map(kind)).toEqual(['full', 'full', 'full'])
    expect([51, 50].map(kind)).toEqual(['short', 'short'])
    expect([49, 48, 47, 46].map(kind)).toEqual(['stacked', 'stacked', 'stacked', 'stacked'])
    // from the widest to the narrowest of the medium tier the kind only ever goes down the chain
    const order = { full: 0, short: 1, stacked: 2 }
    const walk = Array.from({ length: 19 }, (_, i) => order[kind(60 - i)])
    expect(walk).toEqual([...walk].sort((a, b) => a - b))
    expect(walk.at(0)).toBe(0)
    expect(walk.at(-1)).toBe(2)
    for (let columns = 42; columns <= 60; columns++) {
      const said = card(big, columns, 'COST').body.join(' ')
      for (const figure of ['1234.56', '9876.54', '2.3M≈', '12.3M≈']) expect(said, `${columns}: ${figure}`).toContain(figure)
    }
    // the shapes themselves
    expect(card(big, 52, 'COST').body).toEqual([
      '─'.repeat(24),
      '$'.padEnd(8) + '1234.56' + '  ' + '9876.54',
      'tokens'.padEnd(8) + '  2.3M≈' + '  ' + ' 12.3M≈',
    ].map((row, i) => (i === 0 ? row : row)))
    expect(card(big, 51, 'COST').body).toEqual([
      '─'.repeat(22),
      '$'.padEnd(6) + '1234.56' + '  ' + '9876.54',
      'tok'.padEnd(6) + '  2.3M≈' + '  ' + ' 12.3M≈',
    ])
    expect(card(big, 47, 'COST').body).toEqual([
      pair('$ session', '1234.56', 18),
      pair('tok session', '2.3M≈', 18),
      pair('$ total', '9876.54', 18),
      pair('tok total', '12.3M≈', 18),
    ])
  })

  test('the session column is bold, the total and the labels are not', () => {
    const tree = treeAt(makeSnap(), 36)
    const text = (s: string) => nodesOf(tree, 'Text').find(t => textOf(t).trim() === s)!
    expect(text('session').props).toMatchObject({ bold: true })
    expect(text('3.20').props).toMatchObject({ bold: true })
    expect(text('230.0K≈').props).toMatchObject({ bold: true })
    expect(text('total').props).toMatchObject({ dimColor: true })
    expect(text('12.34').props?.bold).toBeUndefined()
    expect(text('$').props).toMatchObject({ dimColor: true })
    expect(text('tokens').props).toMatchObject({ dimColor: true })
    expect(text('─'.repeat(30)).props).toMatchObject({ dimColor: true })
  })

  test('the $ row is the cost row switched on and the tokens row the usage row: cost only', () => {
    const c = card(without('usage'), 36, 'COST')
    expect(c.value).toBe('session  total')
    expect(c.body).toEqual([MATRIX(30).rule, MATRIX(30).dollars])
  })

  test('usage only: the title follows the one row there is, TOKENS', () => {
    const parts = partsAt(without('cost'), 36)
    expect(parts.cards.map(c => c.title)).toEqual(['', 'CONTEXT', '5H', '7D', 'TOKENS', 'GIT', 'ACTIVITY', 'SYSTEM'])
    const c = parts.cards.find(c => c.title === 'TOKENS')!
    expect(c.value).toBe('session  total')
    expect(c.body).toEqual([MATRIX(30).rule, MATRIX(30).tokens])
  })

  test('both off: there is no card, and CONTEXT goes with the usage row', () => {
    const titles = partsAt(without('cost', 'usage'), 36).cards.map(c => c.title)
    expect(titles).toEqual(['', '5H', '7D', 'GIT', 'ACTIVITY', 'SYSTEM'])
  })

  test('one row stacked is labelled by the scope alone', () => {
    // 16 cells inside the narrowest card: even sess and tok need 17 (4 + 2 + 4 + 2 + 5) for the $ row alone
    expect(card(without('usage'), 22, 'COST').body).toEqual([pair('session', '3.20', 16), pair('total', '12.34', 16)])
    expect(card(without('cost'), 22, 'TOKENS').body).toEqual([pair('session', '230.0K≈', 16), pair('total', '1.2M≈', 16)])
  })

  test('a figure that failed reads a dash, dim, and the reason follows whole', () => {
    const c = card(makeSnap({ cost: bad('cum file is corrupt') }), 36, 'COST')
    expect(c.body.slice(0, 3)).toEqual([MATRIX(30).rule, '$'.padEnd(16) + '      —' + '  ' + '    —', MATRIX(30).tokens])
    expect(c.body.slice(3)).toEqual(['cost n/a (cum file is corrupt)'])
    const dash = nodesOf(treeAt(makeSnap({ cost: bad('x') }), 36), 'Text').filter(t => textOf(t).trim() === '—')
    expect(dash).toHaveLength(2)
    for (const t of dash) expect(t.props).toMatchObject({ dimColor: true })
    const tokens = card(makeSnap({ tokens: bad('cum file is corrupt') }), 36, 'COST')
    expect(tokens.body).toEqual([MATRIX(30).rule, MATRIX(30).dollars, 'tokens'.padEnd(16) + '      —' + '  ' + '    —', 'tokens n/a (cum file is', 'corrupt)'])
  })

  test('a long figure widens its column and the matrix holds while it fits; else the figures are stacked, whole', () => {
    const big = makeSnap({ cost: { ok: true, v: { all: 123_456.78, session: 98_765.43, durMin: 1 } } })
    // 35 cells inside at 120 columns: session 8 wide, total 9 wide
    expect(card(big, 120, 'COST').body).toEqual([
      '─'.repeat(35),
      '$'.padEnd(16) + '98765.43' + '  ' + '123456.78',
      'tokens'.padEnd(16) + ' 230.0K≈' + '  ' + '    1.2M≈',
    ])
    // 25 cells inside at 89 columns: the 27 the full words need are not there, the 25 of sess and tok are
    expect(card(big, 89, 'COST').body).toEqual([
      '─'.repeat(25),
      '$'.padEnd(6) + '98765.43' + '  ' + '123456.78',
      'tok'.padEnd(6) + ' 230.0K≈' + '  ' + '    1.2M≈',
    ])
    // 22 cells inside at 82 columns: not even those, so the rows are stacked
    expect(card(big, 82, 'COST').body).toEqual([
      pair('$ session', '98765.43', 22),
      pair('tok session', '230.0K≈', 22),
      pair('$ total', '123456.78', 22),
      pair('tok total', '1.2M≈', 22),
    ])
  })


  test('the session length is in the header, not in COST', () => {
    for (const columns of [36, 49, 89]) {
      const parts = partsAt(makeSnap(), columns)
      expect(parts.cards.find(c => c.title === 'COST')!.body.join(' ')).not.toContain('1hr')
      expect(parts.cards[0]!.body.join(' ')).toContain('1hr 20min')
    }
  })

  test('the tokens are not in CONTEXT any more', () => {
    for (const columns of [36, 49, 89]) expect(card(makeSnap(), columns, 'CONTEXT').body.join(' ')).not.toMatch(/tokens|230\.0K|1\.2M/)
  })
})

describe('GIT', () => {
  test('wide and medium: branch, dir, lines and state, one label/value row each', () => {
    expect(card(makeSnap(), 89, 'GIT').body).toEqual([
      pair('branch', 'main', 24),
      pair('dir', '~/project', 24),
      pair('lines', '+120 −45 ≈', 24),
      pair('state', '✗ +1 ~3 ?2', 24),
    ])
    // medium gives GIT the 18 cells inside that are left beside the COST matrix
    expect(card(makeSnap(), 49, 'GIT').body).toEqual([
      pair('branch', 'main', 18),
      pair('dir', '~/project', 18),
      pair('lines', '+120 −45 ≈', 18),
      pair('state', '✗ +1 ~3 ?2', 18),
    ])
  })

  test('beside the COST matrix GIT stacks the lines and the state under their labels when they do not fit, and loses no field', () => {
    const big = makeSnap({
      lines: { ok: true, v: { add: 12_345, rm: 6_789 } },
      git: { ok: true, v: { branch: 'main', repo: '', status: { ok: true, v: { added: 12, modified: 345, untracked: 6789 } } } },
    })
    const c = card(big, 49, 'GIT')
    expect(c.width).toBe(22)
    expect(c.body).toEqual([pair('branch', 'main', 18), pair('dir', '~/project', 18), 'lines', right('+12345 −6789 ≈', 18), 'state', right('✗ +12 ~345 ?6789', 18)])
    expect(card(big, 49, 'COST').value).toBe('sess  total')
  })

  test('a clean tree reads ✓ clean in green, a dirty one ✗ with counts in their colours', () => {
    const clean = makeSnap({ git: { ok: true, v: { branch: 'main', repo: '', status: { ok: true, v: { added: 0, modified: 0, untracked: 0 } } } } })
    expect(card(clean, 89, 'GIT').body[3]).toBe(pair('state', '✓ clean', 24))
    const git = cardsOf(layoutAt(makeSnap(), 89)).find(c => c.id === 'git')!
    const segs = (i: number) => {
      const row = git.rows[i]
      return row?.kind === 'split' ? row.parts.flat().filter(s => s.color).map(s => [s.text, s.color]) : null
    }
    expect(segs(1)).toEqual([['main', 'magenta']])
    expect(segs(3)).toEqual([['+120', 'green'], ['−45', 'red']])
    expect(segs(4)).toEqual([['✗', 'red'], ['+1', 'green'], ['~3', 'yellow'], ['?2', 'blue']])
    const cleanGit = cardsOf(layoutAt(clean, 89)).find(c => c.id === 'git')!
    const row = cleanGit.rows[4]
    expect(row?.kind === 'split' ? row.parts.flat().filter(s => s.color).map(s => [s.text, s.color]) : null).toEqual([['✓ clean', 'green']])
  })

  test('the state names only the kinds that are there, and an untracked file alone makes the tree dirty', () => {
    const state = (added: number, modified: number, untracked: number) => {
      const git = { ok: true as const, v: { branch: 'main', repo: '', status: { ok: true as const, v: { added, modified, untracked } } } }
      return card(makeSnap({ git }), 89, 'GIT').body[3]
    }
    expect(state(1, 0, 0)).toBe(pair('state', '✗ +1', 24))
    expect(state(0, 3, 0)).toBe(pair('state', '✗ ~3', 24))
    expect(state(0, 0, 2)).toBe(pair('state', '✗ ?2', 24))
    expect(state(0, 0, 0)).toBe(pair('state', '✓ clean', 24))
  })

  test('outside a repository there is no branch and no state, the directory and the lines stay', () => {
    const none = makeSnap({ git: { ok: true, v: { branch: '', repo: '', status: { ok: true, v: { added: 0, modified: 0, untracked: 0 } } } } })
    expect(card(none, 89, 'GIT').body).toEqual([pair('dir', '~/project', 24), pair('lines', '+120 −45 ≈', 24)])
  })

  test('a long path loses its head, kept to the room beside its label', () => {
    const snap = makeSnap({ dir: { ok: true, v: '~/work/sites/Oracle_GB300/Test_Scripts/QCIDiag/S8P_host_GB300' } })
    // 18 cells inside, 3 for the label and two between: 13 for the path
    expect(card(snap, 49, 'GIT').body[1]).toBe(pair('dir', '…P_host_GB300', 18))
  })

  test('a number is never cut: a value too wide for its row goes under the label, whole', () => {
    const big = makeSnap({
      lines: { ok: true, v: { add: 12_345, rm: 6_789 } },
      git: { ok: true, v: { branch: 'main', repo: '', status: { ok: true, v: { added: 12, modified: 345, untracked: 6789 } } } },
    })
    // 16 cells inside the narrowest card: 'lines' + a cell + '+12345 −6789 ≈' (14) is 20
    const c = card(big, 22, 'GIT')
    expect(c.body).toEqual([pair('branch', 'main', 16), pair('dir', '~/project', 16), 'lines', right('+12345 −6789 ≈', 16), 'state', right('✗ +12 ~345 ?6789', 16)])
  })

  test('with the branch not to be had the reason is told in full where the branch would be', () => {
    const snap = makeSnap({ git: { ok: true, v: { branch: 'main', repo: '', status: bad('fatal: this operation must be run in a work tree') } } })
    expect(card(snap, 89, 'GIT').body).toEqual([
      pair('branch', 'main', 24),
      pair('dir', '~/project', 24),
      pair('lines', '+120 −45 ≈', 24),
      'git n/a (fatal: this',
      'operation must be run in',
      'a work tree)',
    ])
  })

  test('a lines reason that runs over several rows keeps its rows, and the state follows', () => {
    const snap = makeSnap({ lines: bad('cum file is corrupt') })
    expect(card(snap, 89, 'GIT').body).toEqual([pair('branch', 'main', 24), pair('dir', '~/project', 24), 'lines n/a (cum file is', 'corrupt)', pair('state', '✗ +1 ~3 ?2', 24)])
  })

  test('a lines reason of one row is a row of its own too', () => {
    const snap = makeSnap({ lines: bad('x') })
    expect(card(snap, 89, 'GIT').body).toEqual([pair('branch', 'main', 24), pair('dir', '~/project', 24), 'lines n/a (x)', pair('state', '✗ +1 ~3 ?2', 24)])
  })

  test('the branch reason keeps its rows, and the directory follows them', () => {
    const snap = makeSnap({ git: bad('fatal: detected dubious ownership in repository') })
    expect(card(snap, 89, 'GIT').body).toEqual(['git n/a (fatal: detected', 'dubious ownership in', 'repository)', pair('dir', '~/project', 24), pair('lines', '+120 −45 ≈', 24)])
  })
})

describe('ACTIVITY', () => {
  const activity = (snap: Snap, columns: number) => card(snap, columns, 'ACTIVITY')

  test('a card at every breakpoint: a label/value row per group, the age beside it when it fits and under it when it does not, the files over rows', () => {
    // 24, 43 and 30 cells inside the card at 89, 49 and 36 columns
    expect(activity(makeSnap(), 89).body).toEqual([
      pair('agents', 'general-purp ○', 24),
      right('Explore ✓×3', 24),
      right('5m ago', 24),
      pair('edited', 'register.tsx →', 24),
      right('SPEC.md →', 24),
      right('settings.json', 24),
    ])
    expect(activity(makeSnap(), 49).body).toEqual([
      pair('agents', 'general-purp ○', 43),
      right('Explore ✓×3 5m ago', 43),
      pair('edited', 'register.tsx → SPEC.md →', 43),
      right('settings.json', 43),
    ])
    // narrow: a row for each agent (the status and the age against the right edge) and each file, newest first
    expect(activity(makeSnap(), 36).body).toEqual([
      'agents',
      pair('general-purp', '○', 30),
      pair('Explore', '✓×3 5m', 30),
      'edited',
      right('settings.json', 30),
      right('SPEC.md', 30),
      right('register.tsx', 30),
    ])
  })

  test('idle reads idle at every breakpoint', () => {
    const idle = makeSnap({ agents: { ok: true, v: [] }, edited: { ok: true, v: [] } })
    for (const [columns, inner] of [[36, 30], [49, 43], [89, 24]] as const) {
      expect(activity(idle, columns).body).toEqual([pair('agents', 'idle', inner), pair('edited', 'idle', inner)])
    }
  })

  test('running agents are yellow and finished ones green', () => {
    const c = cardsOf(layoutAt(makeSnap(), 49)).find(c => c.id === 'activity')!
    const colours = (i: number) => {
      const row = c.rows[i]
      return row?.kind === 'split' ? row.parts.flat().filter(s => s.color).map(s => [s.text, s.color]) : null
    }
    expect(colours(1)).toEqual([['○', 'yellow']])
    expect(colours(2)).toEqual([['✓×3', 'green']])
  })

  test('the age shares the row with its group to the last cell, and not a cell more', () => {
    const group = (name: string) => makeSnap({ agents: { ok: true, v: [{ name, running: 0, done: 3, latest: MOCKUP_AT - 5 * 60_000 }] } })
    // 24 cells inside the card at 89 columns, 17 of them beside the label
    expect(activity(group('Explo'), 89).body[0]).toBe(pair('agents', 'Explo ✓×3 5m ago', 24))
    expect(activity(group('Explor'), 89).body.slice(0, 2)).toEqual([pair('agents', 'Explor ✓×3', 24), right('5m ago', 24)])
  })

  test('a group that is only running has no age', () => {
    const running = makeSnap({ agents: { ok: true, v: [{ name: 'Explore', running: 1, done: 0, latest: MOCKUP_AT - 60_000 }] } })
    expect(activity(running, 49).body[0]).toBe(pair('agents', 'Explore ○', 43))
    expect(activity(running, 49).body.join(' ')).not.toContain('ago')
  })

  test('only the first group has the label; the files break where the next name would not fit, the arrow staying on the row it ends', () => {
    const two = makeSnap({ agents: { ok: true, v: [{ name: 'a', running: 1, done: 0, latest: 0 }, { name: 'b', running: 0, done: 1, latest: 0 }] } })
    expect(activity(two, 89).body.slice(0, 2)).toEqual([pair('agents', 'a ○', 24), right('b ✓', 24)])
    // 'aaaa → bbbbbbb →' is exactly the 16 cells beside the label
    const names = (v: string[]) => activity(makeSnap({ edited: { ok: true, v } }), 89).body.slice(-2)
    expect(names(['aaaa', 'bbbbbbb', 'c'])).toEqual([pair('edited', 'aaaa → bbbbbbb →', 24), right('c', 24)])
    expect(names(['aaaa', 'bbbbbbbb', 'c'])).toEqual([pair('edited', 'aaaa →', 24), right('bbbbbbbb → c', 24)])
  })

  test('the arrows between the files are dim and the names are not', () => {
    const c = cardsOf(layoutAt(makeSnap(), 49)).find(c => c.id === 'activity')!
    const row = c.rows.find(r => r.kind === 'split' && r.parts[0]?.[0]?.text === 'edited')
    expect(row?.kind === 'split' ? row.parts : null).toEqual([
      [{ text: 'edited', dim: true }],
      [{ text: 'register.tsx' }, { text: ' →', dim: true }, { text: ' ' }, { text: 'SPEC.md' }, { text: ' →', dim: true }],
    ])
  })

  test('a group with some running and some done reads both marks, a cell apart', () => {
    const both = makeSnap({ agents: { ok: true, v: [{ name: 'Explore', running: 1, done: 2, latest: 0 }] } })
    expect(activity(both, 89).body[0]).toBe(pair('agents', 'Explore ○ ✓×2', 24))
  })

  test('a file name of 26 cells keeps its last 24 behind an ellipsis, one of 25 stays whole', () => {
    const last = (name: string) => activity(makeSnap({ edited: { ok: true, v: [name] } }), 120).body.at(-1)
    // 34 cells inside the card at 120 columns
    expect(last('a'.repeat(25))).toBe(pair('edited', 'a'.repeat(25), 34))
    expect(last('b'.repeat(26))).toBe(pair('edited', `…${'b'.repeat(24)}`, 34))
  })

  test('a first name too wide for the card loses its head to fit', () => {
    const edited = makeSnap({ edited: { ok: true, v: ['a'.repeat(25)] } })
    expect(activity(edited, 89).body.at(-1)).toBe(pair('edited', `…${'a'.repeat(15)}`, 24))
  })

  test('only the part that is on is drawn', () => {
    expect(activity(without('edited'), 89).body).toEqual([pair('agents', 'general-purp ○', 24), right('Explore ✓×3', 24), right('5m ago', 24)])
    expect(activity(without('agents'), 89).body).toEqual([pair('edited', 'register.tsx →', 24), right('SPEC.md →', 24), right('settings.json', 24)])
  })

  test('the edited files take three rows at most, the last ending in an ellipsis', () => {
    const names = ['aaaaaaaaaaa.ts', 'bbbbbbbbbbb.ts', 'ccccccccccc.ts', 'ddddddddddd.ts']
    const body = activity(makeSnap({ edited: { ok: true, v: names } }), 89).body.slice(3)
    expect(body).toHaveLength(3)
    expect(body.slice(0, 2)).toEqual([pair('edited', 'aaaaaaaaaaa.ts →', 24), right('bbbbbbbbbbb.ts →', 24)])
    expect(body[2]).toMatch(/^ +ccccccccccc\.ts.*…$/)
    expect(dw(body[2]!)).toBe(24)
  })

  test('a failure says why in the card, whole', () => {
    const failed = makeSnap({ agents: bad('subagent-tracker.js hook not configured'), edited: bad('file-tracker.js hook not configured') })
    expect(activity(failed, 49).body).toEqual([
      'agents n/a (subagent-tracker.js hook not',
      'configured)',
      'edited n/a (file-tracker.js hook not',
      'configured)',
    ])
  })
})

describe('the system card', () => {
  const system = (snap: Snap, columns: number, over?: Partial<PaneView>) => card(snap, columns, 'SYSTEM', over)
  const mcp = (total: number, healthy: number, bad: { name: string; isAuth: boolean }[]): Snap => makeSnap({ mcp: { ok: true, v: { total, healthy, bad } } })
  /** The row of the system card whose label is `label`, as plain data. */
  const rowOf = (snap: Snap, label: string, over?: Partial<PaneView>) =>
    cardsOf(layoutAt(snap, 89, over)).find(c => c.id === 'system')!.rows.find(r => (r.kind === 'split' && r.parts[0]?.[0]?.text === label) || (r.kind === 'chart' && r.label[0]?.text === label))
  const SPARK = '▁▁▁▂▄▆████▅▂▁▁▁▂'
  const TOP = '░░░░░░░▃█▂░░░░░░'
  /** The chart's two rows then ram and mcp, `inner` cells wide: the chart is 16 columns, a cell, and the value. */
  const head = (inner: number) => [' '.repeat(inner - 20) + TOP, pair('cpu', `${SPARK} 12%`, inner), pair('ram', '45%  7.0/15.6G', inner), pair('mcp', '5/6  notion ✗', inner)]

  test('at every breakpoint it holds the CPU with its chart, the RAM, the mcp servers and the memory files, whole', () => {
    // 43, 30 and 83 cells inside the card at 49, 36 and 89 columns
    expect(system(makeSnap(), 49).body).toEqual([...head(43), pair('memory', 'global · project · 3 rules', 43)])
    expect(system(makeSnap(), 36).body).toEqual([...head(30), pair('memory', 'global · project ·', 30), right('3 rules', 30)])
    expect(system(makeSnap(), 89).body).toEqual([...head(83), pair('memory', 'global · project · 3 rules', 83)])
  })

  test('every server that is down is named, over rows when the card is too narrow for one', () => {
    const many = mcp(4, 1, [
      { name: 'alpha', isAuth: false },
      { name: 'beta-server', isAuth: true },
      { name: 'gamma-long-name', isAuth: false },
    ])
    expect(system(many, 36).body.slice(3, 6)).toEqual([pair('mcp', '1/4  alpha ✗', 30), right('beta-server △', 30), right('gamma-long-name ✗', 30)])
    expect(system(many, 89).body.slice(3)).toEqual([pair('mcp', '1/4  alpha ✗  beta-server △  gamma-long-name ✗', 83), pair('memory', 'global · project · 3 rules', 83)])
  })

  test('mcp: every server up reads a green count with a tick; one down is named with its icon', () => {
    expect(system(mcp(2, 2, []), 49).body.at(-2)).toBe(pair('mcp', '2 ✓', 43))
    expect(system(mcp(3, 1, [{ name: 'a', isAuth: true }, { name: 'b', isAuth: false }]), 49).body.at(-2)).toBe(pair('mcp', '1/3  a △  b ✗', 43))
    expect(system(makeSnap({ mcp: { ok: true, v: null } }), 49).body.join('\n')).not.toContain('mcp')
  })

  test('mcp: a server that needs auth is yellow with a triangle, one that is down red; all down reads red', () => {
    const segs = (snap: Snap) => {
      const row = rowOf(snap, 'mcp')
      return row?.kind === 'split' ? row.parts[1]!.filter(s => s.color).map(s => [s.text, s.color]) : []
    }
    expect(segs(mcp(3, 1, [{ name: 'a', isAuth: true }, { name: 'b', isAuth: false }]))).toEqual([['1/3', 'yellow'], ['a △', 'yellow'], ['b ✗', 'red']])
    expect(segs(mcp(1, 0, [{ name: 'a', isAuth: false }]))).toEqual([['0/1', 'red'], ['a ✗', 'red']])
    expect(segs(mcp(2, 2, []))).toEqual([['2', 'green'], ['✓', 'green']])
  })

  test('the memory files come whole: over rows at the separators, or with the head of a name that is too long lost', () => {
    const memory = (v: string[]) => system(makeSnap({ memory: { ok: true, v } }), 36).body.slice(4)
    expect(memory(['global', 'project', '3 rules'])).toEqual([pair('memory', 'global · project ·', 30), right('3 rules', 30)])
    expect(memory(['x'.repeat(40)])).toEqual([pair('memory', `…${'x'.repeat(21)}`, 30)])
    expect(system(makeSnap({ memory: { ok: true, v: [] } }), 49).body.join('\n')).not.toContain('memory')
  })

  test('a narrow card fits fewer chart columns and keeps the newest readings', () => {
    const chart = (function find(n: Node): Node | undefined {
      return n.type === 'Raster' && n.props?.key === 'cpu-chart' ? n : kidsOf(n).filter(isNode).map(find).find(Boolean)
    })(treeAt(makeSnap(), 24))
    // 18 cells inside the card, less the label, the value and two gaps
    expect(chart?.props).toMatchObject({ columns: 10, rows: 2 })
    expect(chart?.props?.cells).toBe(chartRaster(HIST.slice(-10), 10).cells)
  })

  test('the CPU and RAM values take the tone of their reading', () => {
    const tones = (cpu: number, ram: number) => {
      const snap = makeSnap({ cpu: { ok: true, v: cpu }, ram: { ok: true, v: { usedKb: 1, totalKb: 2, pct: ram } } })
      const chart = rowOf(snap, 'cpu')
      const mem = rowOf(snap, 'ram')
      return [
        chart?.kind === 'chart' ? chart.value.map(v => v.color) : [],
        mem?.kind === 'split' ? mem.parts[1]!.filter(v => v.text.endsWith('%')).map(v => v.color) : [],
      ]
    }
    expect(tones(10, 45)).toEqual([[PALETTE.green], [PALETTE.green]])
    expect(tones(55, 79)).toEqual([[PALETTE.yellow], [PALETTE.yellow]])
    expect(tones(80, 95)).toEqual([[PALETTE.red], [PALETTE.red]])
  })

  test('the RAM figure goes under its label when the card is too narrow for both', () => {
    // 16 cells inside the card at 22 columns: 'ram' and 14 more are 18
    expect(system(makeSnap(), 22).body.slice(2, 4)).toEqual(['ram', right('45%  7.0/15.6G', 16)])
  })

  test('a view with no Raster plans a text row, not a chart one', () => {
    for (const raster of [false, true]) expect(rowOf(makeSnap(), 'cpu', { raster })?.kind).toBe(raster ? 'chart' : 'split')
  })

  test('without the chart surface the history is a text sparkline in the line', () => {
    expect(system(makeSnap(), 49, { raster: false }).body).toEqual([
      pair('cpu', `${sparkText(HIST, 16)} 12%`, 43),
      pair('ram', '45%  7.0/15.6G', 43),
      pair('mcp', '5/6  notion ✗', 43),
      pair('memory', 'global · project · 3 rules', 43),
    ])
  })

  test('the first reading has no CPU share yet: a dash; a history of none is a plain number', () => {
    expect(system(makeSnap({ cpu: { ok: true, v: null } }), 49).body[0]).toBe(pair('cpu', '—', 43))
    expect(system(makeSnap(), 49, { cpuHist: [] }).body[0]).toBe(pair('cpu', '12%', 43))
  })

  test('errors are the last row, in red against the right edge, singular for one', () => {
    expect(system(makeSnap({ errors: 1 }), 49).body.at(-1)).toBe(right('1 error', 43))
    expect(system(makeSnap({ errors: 3 }), 49).body.at(-1)).toBe(right('3 errors', 43))
    expect(system(makeSnap({ errors: 1 }), 36).body.slice(-3)).toEqual([pair('memory', 'global · project ·', 30), right('3 rules', 30), right('1 error', 30)])
    const last = cardsOf(layoutAt(makeSnap({ errors: 2 }), 49)).find(c => c.id === 'system')!.rows.at(-1)
    expect(last?.kind === 'split' ? last.parts[1] : null).toEqual([{ text: '2 errors', color: PALETTE.red }])
  })

  test('the errors row follows the rows that are there: the RAM row when the mcp and memory are off', () => {
    const base = makeSnap({ errors: 2 })
    const noMcp = makeSnap({ errors: 2, toggles: { enabled: true, rows: { ...base.toggles.rows, memory_mcp: false } } })
    expect(system(noMcp, 89).body.slice(-2)).toEqual([pair('ram', '45%  7.0/15.6G', 83), right('2 errors', 83)])
  })

  test('a row that failed says why in full, in order: the rows before it and after it are untouched', () => {
    const snap = makeSnap({ ram: bad('unreadable /proc/meminfo') })
    expect(system(snap, 89).body.slice(0, 4)).toEqual([
      ' '.repeat(63) + TOP,
      pair('cpu', `${SPARK} 12%`, 83),
      'ram n/a (unreadable /proc/meminfo)',
      pair('mcp', '5/6  notion ✗', 83),
    ])
  })

  test('with the card off the errors stand alone under the cards', () => {
    const base = makeSnap()
    const off = makeSnap({ errors: 2, toggles: { enabled: true, rows: { ...base.toggles.rows, sys: false, memory_mcp: false } } })
    for (const columns of [36, 49, 89]) {
      const parts = partsAt(off, columns)
      expect(parts.cards.map(c => c.title)).not.toContain('SYSTEM')
      expect(parts.footer).toEqual([' 2 errors'])
    }
    expect(partsAt(makeSnap({ errors: 0 }), 49).footer).toEqual([])
  })

  test('failed collectors take rows of their own and say why in full; the memory files still follow', () => {
    const snap = makeSnap({ cpu: bad('unreadable /proc/stat'), ram: bad('unreadable /proc/meminfo'), mcp: bad('mcp-status-refresh.js missing') })
    expect(system(snap, 49).body).toEqual([
      'cpu n/a (unreadable /proc/stat)',
      'ram n/a (unreadable /proc/meminfo)',
      'mcp n/a (mcp-status-refresh.js missing)',
      pair('memory', 'global · project · 3 rules', 43),
    ])
  })
})

describe('a card whose collector failed keeps its frame and says why, dim, in its body', () => {
  const FAILED = makeSnap({
    summary: bad('no summary'),
    dir: bad('no dir'),
    git: bad('git not found'),
    lines: bad('cum file is corrupt'),
    model: bad('no model'),
    cost: bad('cum file is corrupt'),
    agents: bad('subagent-tracker.js hook not configured'),
    context: bad('usage refused'),
    tokens: bad('cum file is corrupt'),
    quota: bad('usage refused'),
    cpu: bad('unreadable /proc/stat'),
    ram: bad('unreadable /proc/meminfo'),
    memory: bad('memory refused'),
    mcp: bad('mcp-status-refresh.js missing'),
    edited: bad('file-tracker.js hook not configured'),
  })

  test('CONTEXT, 5H, 7D and COST', () => {
    const parts = partsAt(FAILED, 89)
    expect(parts.cards.find(c => c.title === 'CONTEXT')!.body).toEqual(['n/a (usage refused)'])
    expect(parts.cards.find(c => c.title === '5H')!.body).toEqual(['n/a (usage refused)'])
    expect(parts.cards.find(c => c.title === '7D')!.body).toEqual(['n/a (usage refused)'])
    // the matrix keeps its rows with a dash in each cell, and the reasons follow
    const dash = '      —  ' + '    —'
    expect(parts.cards.find(c => c.title === 'COST')!.body).toEqual([
      '─'.repeat(25),
      '$'.padEnd(11) + dash,
      'tokens'.padEnd(11) + dash,
      'cost n/a (cum file is',
      'corrupt)',
      'tokens n/a (cum file is',
      'corrupt)',
    ])
  })

  test('the reasons are dim', () => {
    const tree = treeAt(FAILED, 89)
    const reasons = (function walk(n: Node): Node[] {
      return [...(n.type === 'Text' && /n\/a/.test(textOf(n)) ? [n] : []), ...kidsOf(n).filter(isNode).flatMap(walk)]
    })(tree)
    expect(reasons.length).toBeGreaterThan(10)
    for (const reason of reasons) expect(reason.props).toMatchObject({ dimColor: true })
  })

  test('GIT says what failed, part by part', () => {
    const body = partsAt(FAILED, 89).cards.find(c => c.title === 'GIT')!.body
    expect(body).toEqual(['git n/a (git not found)', 'dir n/a (no dir)', 'lines n/a (cum file is', 'corrupt)'])
  })

  test('ACTIVITY and the header', () => {
    const parts = partsAt(FAILED, 89)
    expect(parts.cards.find(c => c.title === 'ACTIVITY')!.body).toEqual([
      'agents n/a',
      '(subagent-tracker.js',
      'hook not configured)',
      'edited n/a',
      '(file-tracker.js hook',
      'not configured)',
    ])
    expect(parts.cards[0]!.body).toEqual([`${' '.repeat(76)}● 02:41`, 'model n/a (no model)', 'summary n/a (no summary)'])
  })

  test('every card in its n/a state draws at every breakpoint with the frame whole and nothing past it', () => {
    for (const columns of [36, 49, 89]) {
      const tree = treeAt(FAILED, columns)
      expect(findOverflow(tree, columns)).toEqual([])
      const parts = paneParts(tree, columns)
      for (const card of parts.cards) {
        expect(card.raw[0]).toMatch(/^╭─+╮$/)
        expect(card.raw.at(-1)).toMatch(/^╰─+╯$/)
        expect(card.raw.every(l => dw(l) === card.width)).toBe(true)
      }
    }
  })

  test('the chips of a failed collector say why on lines of their own in the SYSTEM card', () => {
    const parts = partsAt(FAILED, 89)
    expect(parts.cards.find(c => c.title === 'SYSTEM')!.body).toEqual([
      'cpu n/a (unreadable /proc/stat)',
      'ram n/a (unreadable /proc/meminfo)',
      'mcp n/a (mcp-status-refresh.js missing)',
      'memory n/a (memory refused)',
    ])
    expect(parts.footer).toEqual([])
  })
})

describe('toggles hide whole cards or parts', () => {
  const titles = (snap: Snap, columns: number) => partsAt(snap, columns).cards.map(c => c.title)

  test('usage hides CONTEXT; quota hides 5H and 7D; dir and repo together hide GIT; cost and usage together hide COST', () => {
    expect(titles(without('usage'), 89)).toEqual(['', '5H', '7D', 'COST', 'GIT', 'ACTIVITY', 'SYSTEM'])
    expect(titles(without('quota'), 89)).toEqual(['', 'CONTEXT', 'COST', 'GIT', 'ACTIVITY', 'SYSTEM'])
    expect(titles(without('cost'), 89)).toEqual(['', 'CONTEXT', '5H', '7D', 'TOKENS', 'GIT', 'ACTIVITY', 'SYSTEM'])
    expect(titles(without('cost', 'usage'), 89)).toEqual(['', '5H', '7D', 'GIT', 'ACTIVITY', 'SYSTEM'])
    expect(titles(without('dir'), 89)).toContain('GIT')
    expect(titles(without('repo'), 89)).toContain('GIT')
    expect(titles(without('dir', 'repo'), 89)).toEqual(['', 'CONTEXT', '5H', '7D', 'COST', 'ACTIVITY', 'SYSTEM'])
    expect(titles(without('agents', 'edited'), 89)).toEqual(['', 'CONTEXT', '5H', '7D', 'COST', 'GIT', 'SYSTEM'])
    expect(titles(without('sys', 'memory_mcp'), 89)).toEqual(['', 'CONTEXT', '5H', '7D', 'COST', 'GIT', 'ACTIVITY'])
  })

  test('the $ row follows the cost toggle and the tokens row the usage toggle; one card holds both', () => {
    for (const columns of [36, 49, 89]) {
      const costOff = partsAt(without('cost'), columns).cards
      expect(costOff.some(c => c.title === 'COST')).toBe(false)
      const tokens = costOff.find(c => c.title === 'TOKENS')!
      expect(tokens.body.join(' ')).toMatch(/230\.0K≈/)
      expect(tokens.body.join(' ')).not.toContain('$')
      const usageOff = partsAt(without('usage'), columns).cards
      const cost = usageOff.find(c => c.title === 'COST')!
      expect(cost.body.join(' ')).toMatch(/12\.34/)
      expect(cost.body.join(' ')).not.toMatch(/tok|230\.0K/)
      expect(usageOff.some(c => c.title === 'CONTEXT' || c.title === 'TOKENS')).toBe(false)
      expect(partsAt(without('cost', 'usage'), columns).cards.some(c => c.title === 'COST' || c.title === 'TOKENS')).toBe(false)
    }
  })

  test('a pair with one side hidden gives the other the full width', () => {
    const rest = [['activity:47'], ['system:47']]
    expect(bandsOf(layoutAt(without('cost', 'usage'), 49)).slice(1)).toEqual([['5h:23', '7d:23'], ['git:47'], ...rest])
    expect(bandsOf(layoutAt(without('dir', 'repo'), 49)).slice(1)).toEqual([['context:47'], ['5h:23', '7d:23'], ['cost:47'], ...rest])
    expect(bandsOf(layoutAt(without('quota'), 49)).slice(1)).toEqual([['context:47'], ['cost:24', 'git:22'], ...rest])
  })

  test('three across become two, or one, as cards go', () => {
    expect(bandsOf(layoutAt(without('usage'), 89)).slice(1)).toEqual([['5h:43', '7d:43'], ['cost:29', 'git:28', 'activity:28'], ['system:87']])
    expect(bandsOf(layoutAt(without('usage', 'quota'), 89)).slice(1)).toEqual([['cost:29', 'git:28', 'activity:28'], ['system:87']])
    expect(bandsOf(layoutAt(without('cost', 'usage', 'agents', 'edited'), 89)).slice(1)).toEqual([['5h:43', '7d:43'], ['git:87'], ['system:87']])
    expect(bandsOf(layoutAt(without('quota', 'cost', 'usage'), 89)).slice(1)).toEqual([['git:43', 'activity:43'], ['system:87']])
  })

  test('summary hides header line 2; model hides the model part', () => {
    expect(partsAt(without('summary'), 49).cards[0]!.body).toEqual([`Opus 5.5 · max · v2.1.294${' '.repeat(4)}mcp ✗  ● 02:41`, '1hr 20min'])
    expect(partsAt(without('model'), 89).cards[0]!.body[0]).toMatch(/^ *遷移.*● 02:41$/)
  })

  test('agents and edited each hide their part of ACTIVITY', () => {
    const body = (snap: Snap) => partsAt(snap, 49).cards.find(c => c.title === 'ACTIVITY')!.body
    expect(body(without('agents'))).toEqual([pair('edited', 'register.tsx → SPEC.md →', 43), right('settings.json', 43)])
    expect(body(without('edited'))).toEqual([pair('agents', 'general-purp ○', 43), right('Explore ✓×3 5m ago', 43)])
  })

  test('sys hides the CPU and RAM rows; memory_mcp hides the mcp and memory rows', () => {
    const body = (snap: Snap) => partsAt(snap, 49).cards.find(c => c.title === 'SYSTEM')!.body
    expect(body(without('sys'))).toEqual([pair('mcp', '5/6  notion ✗', 43), pair('memory', 'global · project · 3 rules', 43)])
    expect(body(without('memory_mcp'))).toEqual([' '.repeat(23) + '░░░░░░░▃█▂░░░░░░', pair('cpu', '▁▁▁▂▄▆████▅▂▁▁▁▂ 12%', 43), pair('ram', '45%  7.0/15.6G', 43)])
  })

  test('with everything off the header is all that is left', () => {
    const snap = without('summary', 'dir', 'repo', 'model', 'cost', 'usage', 'quota', 'agents', 'memory_mcp', 'sys', 'edited')
    const parts = partsAt(snap, 49)
    expect(parts.cards.map(c => c.title)).toEqual([''])
    expect(parts.cards[0]!.body).toEqual([`${' '.repeat(36)}● 02:41`])
    expect(parts.footer).toEqual([])
  })
})

describe('a message instead of the cards', () => {
  test('before the first refresh: one card saying it is waiting', () => {
    expect(textAt(null, 49)).toEqual([`╭${'─'.repeat(45)}╮`, `│ ${'waiting for the first refresh'.padEnd(43)} │`, `╰${'─'.repeat(45)}╯`])
    expect(partsAt(null, 36).cards[0]!.body).toEqual(['waiting for the first refresh'])
    expect(partsAt(null, 22).cards[0]!.body).toEqual(['waiting for the', 'first refresh'])
  })

  test('the master switch off: one card with the disabled text, wrapped', () => {
    const off = makeSnap({ toggles: { enabled: false, rows: makeSnap().toggles.rows } })
    expect(partsAt(off, 89).cards.map(c => c.body)).toEqual([[ROWS_FILE_HINT]])
    // the file name is wider than the 30 cells inside the card: it is broken at a hyphen, not cut
    expect(partsAt(off, 36).cards[0]!.body).toEqual(['disabled by', '~/.claude/cc-statusline-', 'rows.json'])
    expect(partsAt(off, 49).footer).toEqual([])
  })

  test('a snapshot this version did not write draws one card saying the draw failed, and never throws', () => {
    const old = {} as Snap
    const parts = partsAt(old, 49)
    expect(parts.cards).toHaveLength(1)
    expect(parts.cards[0]!.body.join(' ')).toMatch(/^status-pane n\/a \(cannot draw: /)
    expect(() => paneLayout(null, { columns: 0, nowMs: 0 })).not.toThrow()
  })
})

describe('the elements: real Boxes with round borders, Texts, and Rasters where the surface has them', () => {
  const nodes = (n: Node, type: string): Node[] => [
    ...(n.type === type ? [n] : []),
    ...kidsOf(n)
      .filter(isNode)
      .flatMap(k => nodes(k, type)),
  ]
  const cards = (n: Node) => nodes(n, 'Box').filter(b => b.props?.borderStyle !== undefined)

  test('every card is a Box with a round dim border, one cell of padding, a column, and an explicit width', () => {
    const tree = treeAt(makeSnap(), 89)
    const all = cards(tree)
    expect(all).toHaveLength(8)
    for (const card of all) {
      expect(card.props).toMatchObject({ borderStyle: 'round', borderColor: BORDER, paddingX: 1, flexDirection: 'column' })
      expect(typeof card.props?.width).toBe('number')
    }
    expect(all.map(c => c.props?.width)).toEqual([87, 29, 28, 28, 29, 28, 28, 87])
  })

  test('the root is a padded column; a band of cards is a row with a cell between', () => {
    const tree = treeAt(makeSnap(), 89)
    expect(tree.props).toMatchObject({ flexDirection: 'column', paddingX: 1 })
    const bands = nodes(tree, 'Box').filter(b => b.props?.flexDirection === 'row' && b.props?.columnGap === 1)
    expect(bands).toHaveLength(2)
    expect(bands.map(b => kidsOf(b).length)).toEqual([3, 3])
  })

  test('the first row of a card is the title: bold upper case on the left, the value on the right', () => {
    const tree = treeAt(makeSnap(), 89)
    const context = cards(tree).find(c => textOf(kidsOf(c).filter(isNode)[0]!).startsWith('CONTEXT'))!
    const title = kidsOf(context).filter(isNode)[0]!
    expect(title.props).toMatchObject({ justifyContent: 'space-between', width: 25 })
    const [left, right] = kidsOf(title).filter(isNode)
    expect(left?.props).toMatchObject({ bold: true })
    expect(textOf(left!)).toBe('CONTEXT')
    expect(right?.props).toMatchObject({ color: PALETTE.green })
    expect(textOf(right!)).toBe('3%')
  })

  test('every card starts with a title row: a Box whose first child is the bold accent title, whether it has a value or not', () => {
    const tree = treeAt(makeSnap(), 89)
    const firsts = cards(tree).slice(1).map(c => kidsOf(c).filter(isNode)[0]!)
    expect(firsts).toHaveLength(7)
    for (const row of firsts) {
      expect(row.type).toBe('Box')
      expect(kidsOf(row).filter(isNode)[0]?.props).toMatchObject({ bold: true, color: 'cyan' })
    }
    expect(firsts.map(r => textOf(kidsOf(r).filter(isNode)[0]!))).toEqual(['CONTEXT', '5H', '7D', 'COST', 'GIT', 'ACTIVITY', 'SYSTEM'])
    // a title with a value, or alone, spreads its children; the COST row lays the column headers out with spaces
    for (const row of firsts.filter(r => !textOf(r).startsWith('COST'))) expect(row.props).toMatchObject({ justifyContent: 'space-between' })
    expect(textOf(firsts[3]!)).toMatch(/^COST {7}session {2}total$/)
  })

  test('on the terminal a gauge is a Raster of the card width and one row', () => {
    const tree = treeAt(makeSnap(), 89)
    const rasters = nodes(tree, 'Raster')
    expect(rasters.map(r => [r.props?.key, r.props?.columns, r.props?.rows])).toEqual([
      ['gauge-context', 25, 1],
      ['gauge-5h', 24, 1],
      ['gauge-7d', 24, 1],
      ['cpu-chart', 16, 2],
    ])
    expect(shown(rasterCells(rasters[0]!))).toBe(`▊${'░'.repeat(24)}`)
  })

  test('elsewhere the gauge is Text: the fill in its tone and the dim track, and there is no Raster', () => {
    const tree = treeAt(makeSnap(), 89, { raster: false })
    expect(nodes(tree, 'Raster')).toEqual([])
    const texts = nodes(tree, 'Text').filter(t => /^[█▏▎▍▌▋▊▉]+$/.test(textOf(t)) || /^░+$/.test(textOf(t)))
    expect(texts.slice(0, 2).map(t => [textOf(t), t.props?.color ?? (t.props?.dimColor ? 'dim' : '')])).toEqual([
      ['▊', PALETTE.green],
      ['░'.repeat(24), 'dim'],
    ])
  })

  test('labels and values are Text; colour discipline: cyan only on the model and the titles, dim for the secondary', () => {
    const tree = treeAt(makeSnap(), 89)
    const cyan = nodes(tree, 'Text').filter(t => t.props?.color === 'cyan')
    expect(cyan.map(textOf)).toEqual(['Opus 5.5', 'CONTEXT', '5H', '7D', 'COST', 'GIT', 'ACTIVITY', 'SYSTEM'])
    for (const t of cyan) expect(t.props).toMatchObject({ bold: true })
    const colours = new Set(nodes(tree, 'Text').flatMap(t => (typeof t.props?.color === 'string' ? [t.props.color] : [])))
    expect([...colours].sort()).toEqual(['blue', 'cyan', 'green', 'magenta', 'red', 'yellow', PALETTE.green, PALETTE.yellow].sort())
  })

  test('a Text with something to cut is told to truncate; a gap of spaces is left alone', () => {
    const texts = nodes(treeAt(makeSnap(), 89), 'Text')
    expect(texts.filter(t => textOf(t).trim() !== '').every(t => t.props?.wrap === 'truncate-end')).toBe(true)
    const gaps = texts.filter(t => textOf(t).trim() === '')
    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps.every(t => t.props?.wrap === undefined)).toBe(true)
  })

  test('a terminal table with no Raster still draws the chart chip, the history as dim text', () => {
    const tree = layoutTree(layoutAt(makeSnap(), 49), FAKE_ELS_PLAIN) as unknown as Node
    expect(nodes(tree, 'Raster')).toEqual([])
    const spark = nodes(tree, 'Text').find(t => /^[▁▂▃▄▅▆▇█]{16}$/.test(textOf(t)))
    expect(spark?.props).toMatchObject({ dimColor: true })
    expect(textOf(spark!)).toBe(sparkText(HIST, 16))
  })

  test('a Text that can overrun is told to truncate, not wrap', () => {
    const tree = treeAt(makeSnap(), 89)
    const summary = nodes(tree, 'Text').find(t => textOf(t).startsWith('遷移'))!
    expect(summary.props).toMatchObject({ wrap: 'truncate-end', dimColor: true })
  })

  test('no glyph in the tree is wider than a cell but the CJK in the summary and in the CONTEXT hint', () => {
    const tree = treeAt(makeSnap(), 89)
    const wide = nodes(tree, 'Text').filter(t => /[^\u0000-⿿]/.test(textOf(t)))
    expect(wide.map(textOf)).toEqual(['遷移 statusline 到 mod pane 的討論與實作', QUIET_HINT])
  })
})

describe('no line passes its box at any width from 20 to 120', () => {
  const NASTY = makeSnap({
    summary: { ok: true, v: '遷移'.repeat(60) },
    dir: { ok: true, v: '/very/long/path/that/goes/on/and/on/and/on/to/QCIDiag/S8P_host_GB300/目錄/目錄' },
    git: {
      ok: true,
      v: { branch: `feature/${'x'.repeat(60)}`, repo: '', status: { ok: true, v: { added: 1234, modified: 5678, untracked: 90123 } } },
    },
    lines: { ok: true, v: { add: 123_456, rm: 98_765 } },
    model: { ok: true, v: { name: 'Opus 5.5 [1m]', version: '2.1.294-beta.123', effort: 'xhigh' } },
    cost: { ok: true, v: { all: 123_456.78, session: 98_765.43, durMin: 99_999 } },
    tokens: { ok: true, v: { all: 9_999_999_999, session: 1 } },
    agents: {
      ok: true,
      v: [
        { name: 'general-purpose-agent', running: 12, done: 345, latest: MOCKUP_AT - 99 * 3_600_000 },
        { name: 'Explorer-of-everything', running: 1, done: 22, latest: MOCKUP_AT - 90_000 },
        { name: '目錄目錄目錄目錄目錄目錄', running: 0, done: 1, latest: 0 },
      ],
    },
    edited: { ok: true, v: ['/a/very/very/very/very/long/file/name/that/never/ends/index.tsx', '目錄目錄目錄目錄目錄目錄目錄目錄目錄目錄目錄.ts', 'b.ts'] },
    mcp: {
      ok: true,
      v: { total: 9, healthy: 3, bad: [{ name: 'a-rather-long-server-name', isAuth: false }, { name: 'another-long-one', isAuth: true }] },
    },
    memory: { ok: true, v: ['global', 'project', '300 rules', 'something else'] },
    errors: 12345,
  })

  for (const [name, snap] of [
    ['a healthy snapshot', makeSnap()],
    ['one with very long text and big numbers', NASTY],
  ] as const) {
    for (const raster of [true, false]) {
      test(`${name}, ${raster ? 'with' : 'without'} Rasters`, () => {
        for (let columns = MIN_W + 2; columns <= 122; columns++) {
          const tree = treeAt(snap, columns, { raster })
          expect(findOverflow(tree, columns)).toEqual([])
          const widest = Math.max(...renderTree(tree, columns).map(dw))
          expect(widest).toBeLessThanOrEqual(columns - 2)
        }
      })
    }
  }


  test('the states with nothing to show do not overrun either', () => {
    const snaps: (Snap | null)[] = [null, makeSnap({ toggles: { enabled: false, rows: makeSnap().toggles.rows } }), {} as Snap]
    for (const snap of snaps) {
      for (let columns = MIN_W + 2; columns <= 122; columns++) {
        expect(findOverflow(treeAt(snap, columns), columns)).toEqual([])
      }
    }
  })

  test('every card is as wide as it was given and its frame is whole', () => {
    for (let columns = MIN_W + 2; columns <= 122; columns += 3) {
      for (const card of partsAt(NASTY, columns).cards) {
        expect(card.raw[0]).toMatch(/^╭─+╮$/)
        expect(card.raw.at(-1)).toMatch(/^╰─+╯$/)
        expect(card.raw.every(l => dw(l) === card.width)).toBe(true)
      }
    }
  })
})

describe('completeness: no field of the old pane is dropped for want of width', () => {
  /** What a card says, as running text: its title, its value and its rows, runs of blanks as one. */
  const said = (columns: number, title: string): string => {
    const card = partsAt(makeSnap(), columns).cards.find(c => c.title === title)
    return [card?.title, card?.value, ...(card?.body ?? [])].join(' ').replace(/\s+/g, ' ')
  }
  /** [card, the value texts of its fields]; the countdowns are written without a blank below wide. */
  const fields = (wide: boolean): [string, string[]][] => [
    ['', ['遷移 statusline 到 mod pane 的討論與實作', 'Opus 5.5', 'max', 'v2.1.294', '1hr 20min', '● 02:41']],
    ['CONTEXT', ['3%', 'used 32.0K / 1.0M', 'compact 0']],
    ['5H', ['23%', 'resets', wide ? '2h 10m' : '2h10m']],
    ['7D', ['61%', 'resets', wide ? '3d 4h' : '3d4h']],
    ['COST', ['sess', 'total', '$', '3.20', '12.34', 'tok', '230.0K≈', '1.2M≈']],
    ['GIT', ['branch main', 'dir ~/project', 'lines +120 −45 ≈', 'state ✗ +1 ~3 ?2']],
    ['ACTIVITY', ['agents', 'general-purp', 'Explore', '✓×3', '5m', 'edited', 'register.tsx', 'SPEC.md', 'settings.json']],
    ['SYSTEM', ['cpu', '12%', 'ram', '45%', '7.0/15.6G', 'mcp', '5/6', 'notion ✗', 'memory', 'global · project · 3 rules']],
  ]

  for (const columns of [36, 49, 89]) {
    test(`w=${columns - 2}: every field of a full snapshot is in the card that holds it`, () => {
      for (const [title, values] of fields(columns >= 82)) {
        for (const value of values) expect(said(columns, title), `${title || 'header'} at w=${columns - 2}: ${value}`).toContain(value)
      }
    })
  }

  test('the CPU history is drawn at every breakpoint: a 2-row Raster on the terminal, a sparkline of the readings elsewhere', () => {
    for (const columns of [36, 49, 89]) {
      const chart = treeAt(makeSnap(), columns).children
      expect(JSON.stringify(chart)).toContain('"key":"cpu-chart"')
      expect(said(columns, 'SYSTEM')).not.toContain('▁▁▂▂')
      const plain = partsAt(makeSnap(), columns, { raster: false }).cards.find(c => c.title === 'SYSTEM')!.body.join(' ')
      expect(plain).toContain(sparkText(HIST, 16))
    }
  })

  test('nothing is dropped when each field is as long as it gets: the long values show whole or lose their head, never vanish', () => {
    const long = makeSnap({
      dir: { ok: true, v: '/very/long/path/that/goes/on/and/on/to/QCIDiag/S8P_host_GB300' },
      git: { ok: true, v: { branch: 'feature/some-very-long-branch-name', repo: '', status: { ok: true, v: { added: 12, modified: 345, untracked: 6789 } } } },
      model: { ok: true, v: { name: 'Opus 5.5 [1m]', version: '2.1.294', effort: 'xhigh' } },
      cost: { ok: true, v: { all: 123_456.78, session: 98_765.43, durMin: 99_999 } },
      tokens: { ok: true, v: { all: 9_999_999_999, session: 999_999 } },
    })
    for (const columns of [22, 36, 49, 89]) {
      const text = (title: string) => {
        const card = partsAt(long, columns).cards.find(c => c.title === title)
        return [card?.title, card?.value, ...(card?.body ?? [])].join(' ').replace(/\s+/g, ' ')
      }
      expect(text(''), `header at ${columns}`).toContain('v2.1.294')
      expect(text(''), `header at ${columns}`).toContain('xhigh')
      expect(text('COST'), `cost at ${columns}`).toContain('98765.43')
      expect(text('COST'), `cost at ${columns}`).toContain('123456.78')
      expect(text('COST'), `cost at ${columns}`).toContain('1000.0K≈')
      expect(text('COST'), `cost at ${columns}`).toContain('10.0B≈')
      expect(text('GIT'), `git at ${columns}`).toContain('?6789')
    }
  })
})

describe('goldens: the full snapshot, laid out as a terminal would', () => {
  // each tree is read back with tree.ts, which shares nothing with pane.ts; the chart is the 16 readings above
  test("narrow, w=34 (bodyColumns 36): framed cards one under another, a blank row between them", () => {
    expect(textAt(makeSnap(), 36)).toEqual([
      "╭────────────────────────────────╮",
      "│ Opus 5.5 · max · v2.1.294      │",
      "│                 mcp ✗  ● 02:41 │",
      "│ 遷移 statusline 到 mod pane    │",
      "│ 的討論與實作 · 1hr 20min       │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ CONTEXT                     3% │",
      "│ ▉░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │",
      "│ used 32.0K / 1.0M    compact 0 │",
      "│ 達 60% 建議 /compact           │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ 5H                         23% │",
      "│ ██████▉░░░░░░░░░░░░░░░░░░░░░░░ │",
      "│ resets           2h10m · 04:51 │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ 7D                         61% │",
      "│ ██████████████████▎░░░░░░░░░░░ │",
      "│ resets        3d4h · Mon 06:41 │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ COST            session  total │",
      "│ ────────────────────────────── │",
      "│ $                  3.20  12.34 │",
      "│ tokens          230.0K≈  1.2M≈ │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ GIT                            │",
      "│ branch                    main │",
      "│ dir                  ~/project │",
      "│ lines               +120 −45 ≈ │",
      "│ state               ✗ +1 ~3 ?2 │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ ACTIVITY                       │",
      "│ agents                         │",
      "│ general-purp                 ○ │",
      "│ Explore                 ✓×3 5m │",
      "│ edited                         │",
      "│                  settings.json │",
      "│                        SPEC.md │",
      "│                   register.tsx │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ SYSTEM                         │",
      "│           ░░░░░░░▃█▂░░░░░░     │",
      "│ cpu       ▁▁▁▂▄▆████▅▂▁▁▁▂ 12% │",
      "│ ram             45%  7.0/15.6G │",
      "│ mcp              5/6  notion ✗ │",
      "│ memory      global · project · │",
      "│                        3 rules │",
      "╰────────────────────────────────╯",
    ])
  })

  test("narrow, w=36 (bodyColumns 38, the 40-column dock): the liveness ends the summary row, mcp and errors beside it", () => {
    expect(textAt(makeSnap(), 38)).toEqual([
      "╭──────────────────────────────────╮",
      "│ Opus 5.5 · max · v2.1.294        │",
      "│                   mcp ✗  ● 02:41 │",
      "│ 遷移 statusline 到 mod pane      │",
      "│ 的討論與實作 · 1hr 20min         │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ CONTEXT                       3% │",
      "│ █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │",
      "│ used 32.0K / 1.0M      compact 0 │",
      "│ 達 60% 建議 /compact             │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ 5H                           23% │",
      "│ ███████▍░░░░░░░░░░░░░░░░░░░░░░░░ │",
      "│ resets             2h10m · 04:51 │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ 7D                           61% │",
      "│ ███████████████████▌░░░░░░░░░░░░ │",
      "│ resets          3d4h · Mon 06:41 │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ COST              session  total │",
      "│ ──────────────────────────────── │",
      "│ $                    3.20  12.34 │",
      "│ tokens            230.0K≈  1.2M≈ │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ GIT                              │",
      "│ branch                      main │",
      "│ dir                    ~/project │",
      "│ lines                 +120 −45 ≈ │",
      "│ state                 ✗ +1 ~3 ?2 │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ ACTIVITY                         │",
      "│ agents                           │",
      "│ general-purp                   ○ │",
      "│ Explore                   ✓×3 5m │",
      "│ edited                           │",
      "│                    settings.json │",
      "│                          SPEC.md │",
      "│                     register.tsx │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ SYSTEM                           │",
      "│             ░░░░░░░▃█▂░░░░░░     │",
      "│ cpu         ▁▁▁▂▄▆████▅▂▁▁▁▂ 12% │",
      "│ ram               45%  7.0/15.6G │",
      "│ mcp                5/6  notion ✗ │",
      "│ memory        global · project · │",
      "│                          3 rules │",
      "╰──────────────────────────────────╯",
    ])
  })

  test("narrow, w=36 with errors: the count rides the liveness", () => {
    expect(textAt(makeSnap({ errors: 2 }), 38)).toEqual([
      "╭──────────────────────────────────╮",
      "│ Opus 5.5 · max · v2.1.294        │",
      "│         mcp ✗  2 errors  ● 02:41 │",
      "│ 遷移 statusline 到 mod pane      │",
      "│ 的討論與實作 · 1hr 20min         │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ CONTEXT                       3% │",
      "│ █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │",
      "│ used 32.0K / 1.0M      compact 0 │",
      "│ 達 60% 建議 /compact             │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ 5H                           23% │",
      "│ ███████▍░░░░░░░░░░░░░░░░░░░░░░░░ │",
      "│ resets             2h10m · 04:51 │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ 7D                           61% │",
      "│ ███████████████████▌░░░░░░░░░░░░ │",
      "│ resets          3d4h · Mon 06:41 │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ COST              session  total │",
      "│ ──────────────────────────────── │",
      "│ $                    3.20  12.34 │",
      "│ tokens            230.0K≈  1.2M≈ │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ GIT                              │",
      "│ branch                      main │",
      "│ dir                    ~/project │",
      "│ lines                 +120 −45 ≈ │",
      "│ state                 ✗ +1 ~3 ?2 │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ ACTIVITY                         │",
      "│ agents                           │",
      "│ general-purp                   ○ │",
      "│ Explore                   ✓×3 5m │",
      "│ edited                           │",
      "│                    settings.json │",
      "│                          SPEC.md │",
      "│                     register.tsx │",
      "╰──────────────────────────────────╯",
      "",
      "╭──────────────────────────────────╮",
      "│ SYSTEM                           │",
      "│             ░░░░░░░▃█▂░░░░░░     │",
      "│ cpu         ▁▁▁▂▄▆████▅▂▁▁▁▂ 12% │",
      "│ ram               45%  7.0/15.6G │",
      "│ mcp                5/6  notion ✗ │",
      "│ memory        global · project · │",
      "│                          3 rules │",
      "│                         2 errors │",
      "╰──────────────────────────────────╯",
    ])
  })

  test("medium, w=47 (bodyColumns 49): the context alone, then pairs, then the activity and the system alone", () => {
    expect(textAt(makeSnap(), 49)).toEqual([
      "╭─────────────────────────────────────────────╮",
      "│ Opus 5.5 · max · v2.1.294    mcp ✗  ● 02:41 │",
      "│ 遷移 statusline 到 mod pane 的討論與實作    │",
      "│ 1hr 20min                                   │",
      "╰─────────────────────────────────────────────╯",
      "╭─────────────────────────────────────────────╮",
      "│ CONTEXT                                  3% │",
      "│ █▎░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │",
      "│ used 32.0K / 1.0M                 compact 0 │",
      "│ 達 60% 建議 /compact                        │",
      "╰─────────────────────────────────────────────╯",
      "╭─────────────────────╮ ╭─────────────────────╮",
      "│ 5H              23% │ │ 7D              61% │",
      "│ ████▍░░░░░░░░░░░░░░ │ │ ███████████▋░░░░░░░ │",
      "│ resets        2h10m │ │ resets         3d4h │",
      "│               04:51 │ │           Mon 06:41 │",
      "╰─────────────────────╯ ╰─────────────────────╯",
      "╭──────────────────────╮ ╭────────────────────╮",
      "│ COST     sess  total │ │ GIT                │",
      "│ ──────────────────── │ │ branch        main │",
      "│ $        3.20  12.34 │ │ dir      ~/project │",
      "│ tok   230.0K≈  1.2M≈ │ │ lines   +120 −45 ≈ │",
      "│                      │ │ state   ✗ +1 ~3 ?2 │",
      "╰──────────────────────╯ ╰────────────────────╯",
      "╭─────────────────────────────────────────────╮",
      "│ ACTIVITY                                    │",
      "│ agents                       general-purp ○ │",
      "│                          Explore ✓×3 5m ago │",
      "│ edited             register.tsx → SPEC.md → │",
      "│                               settings.json │",
      "╰─────────────────────────────────────────────╯",
      "╭─────────────────────────────────────────────╮",
      "│ SYSTEM                                      │",
      "│                        ░░░░░░░▃█▂░░░░░░     │",
      "│ cpu                    ▁▁▁▂▄▆████▅▂▁▁▁▂ 12% │",
      "│ ram                          45%  7.0/15.6G │",
      "│ mcp                           5/6  notion ✗ │",
      "│ memory           global · project · 3 rules │",
      "╰─────────────────────────────────────────────╯",
    ])
  })

  test("wide, w=87 (bodyColumns 89): the header on two rows, three cards across twice, the system card across the width", () => {
    expect(textAt(makeSnap(), 89)).toEqual([
      "╭─────────────────────────────────────────────────────────────────────────────────────╮",
      "│ Opus 5.5 · max · v2.1.294                                            mcp ✗  ● 02:41 │",
      "│ 遷移 statusline 到 mod pane 的討論與實作 · 1hr 20min                                │",
      "╰─────────────────────────────────────────────────────────────────────────────────────╯",
      "╭───────────────────────────╮ ╭──────────────────────────╮ ╭──────────────────────────╮",
      "│ CONTEXT                3% │ │ 5H                   23% │ │ 7D                   61% │",
      "│ ▊░░░░░░░░░░░░░░░░░░░░░░░░ │ │ █████▌░░░░░░░░░░░░░░░░░░ │ │ ██████████████▋░░░░░░░░░ │",
      "│ used         32.0K / 1.0M │ │ resets    2h 10m · 04:51 │ │ resets             3d 4h │",
      "│ compact                 0 │ │                          │ │                Mon 06:41 │",
      "│ 達 60% 建議 /compact      │ │                          │ │                          │",
      "╰───────────────────────────╯ ╰──────────────────────────╯ ╰──────────────────────────╯",
      "╭───────────────────────────╮ ╭──────────────────────────╮ ╭──────────────────────────╮",
      "│ COST       session  total │ │ GIT                      │ │ ACTIVITY                 │",
      "│ ───────────────────────── │ │ branch              main │ │ agents    general-purp ○ │",
      "│ $             3.20  12.34 │ │ dir            ~/project │ │              Explore ✓×3 │",
      "│ tokens     230.0K≈  1.2M≈ │ │ lines         +120 −45 ≈ │ │                   5m ago │",
      "│                           │ │ state         ✗ +1 ~3 ?2 │ │ edited    register.tsx → │",
      "│                           │ │                          │ │                SPEC.md → │",
      "│                           │ │                          │ │            settings.json │",
      "╰───────────────────────────╯ ╰──────────────────────────╯ ╰──────────────────────────╯",
      "╭─────────────────────────────────────────────────────────────────────────────────────╮",
      "│ SYSTEM                                                                              │",
      "│                                                                ░░░░░░░▃█▂░░░░░░     │",
      "│ cpu                                                            ▁▁▁▂▄▆████▅▂▁▁▁▂ 12% │",
      "│ ram                                                                  45%  7.0/15.6G │",
      "│ mcp                                                                   5/6  notion ✗ │",
      "│ memory                                                   global · project · 3 rules │",
      "╰─────────────────────────────────────────────────────────────────────────────────────╯",
    ])
  })

  test("medium on a surface with no Raster: the same pane, the sparkline in the CPU row", () => {
    expect(textAt(makeSnap(), 49, { raster: false })).toEqual([
      "╭─────────────────────────────────────────────╮",
      "│ Opus 5.5 · max · v2.1.294    mcp ✗  ● 02:41 │",
      "│ 遷移 statusline 到 mod pane 的討論與實作    │",
      "│ 1hr 20min                                   │",
      "╰─────────────────────────────────────────────╯",
      "╭─────────────────────────────────────────────╮",
      "│ CONTEXT                                  3% │",
      "│ █▎░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │",
      "│ used 32.0K / 1.0M                 compact 0 │",
      "│ 達 60% 建議 /compact                        │",
      "╰─────────────────────────────────────────────╯",
      "╭─────────────────────╮ ╭─────────────────────╮",
      "│ 5H              23% │ │ 7D              61% │",
      "│ ████▍░░░░░░░░░░░░░░ │ │ ███████████▋░░░░░░░ │",
      "│ resets        2h10m │ │ resets         3d4h │",
      "│               04:51 │ │           Mon 06:41 │",
      "╰─────────────────────╯ ╰─────────────────────╯",
      "╭──────────────────────╮ ╭────────────────────╮",
      "│ COST     sess  total │ │ GIT                │",
      "│ ──────────────────── │ │ branch        main │",
      "│ $        3.20  12.34 │ │ dir      ~/project │",
      "│ tok   230.0K≈  1.2M≈ │ │ lines   +120 −45 ≈ │",
      "│                      │ │ state   ✗ +1 ~3 ?2 │",
      "╰──────────────────────╯ ╰────────────────────╯",
      "╭─────────────────────────────────────────────╮",
      "│ ACTIVITY                                    │",
      "│ agents                       general-purp ○ │",
      "│                          Explore ✓×3 5m ago │",
      "│ edited             register.tsx → SPEC.md → │",
      "│                               settings.json │",
      "╰─────────────────────────────────────────────╯",
      "╭─────────────────────────────────────────────╮",
      "│ SYSTEM                                      │",
      "│ cpu                    ▁▁▂▂▃▃▅▆█▅▃▂▁▁▂▂ 12% │",
      "│ ram                          45%  7.0/15.6G │",
      "│ mcp                           5/6  notion ✗ │",
      "│ memory           global · project · 3 rules │",
      "╰─────────────────────────────────────────────╯",
    ])
  })
})

describe('the narrowest panes in a directory that is no repository', () => {
  const NONE = makeSnap({
    model: { ok: true, v: { name: 'Opus 5.5', version: '2.1.295', effort: 'xhigh' } },
    git: { ok: true, v: { branch: '', repo: '', status: { ok: true, v: { added: 0, modified: 0, untracked: 0 } }, notRepo: true } },
    quota: { ok: true, v: { five: { pct: null, resetSec: null }, seven: { pct: 69, resetSec: 2 * 86_400 + 16 * 3600 } } },
    cpu: { ok: true, v: 1 },
    dir: { ok: true, v: '/project' },
  })

  test('GIT says why it has no branch and has no state row', () => {
    const body = card(NONE, 89, 'GIT').body
    expect(body).toEqual([pair('branch', 'not a git repo', 24), pair('dir', '/project', 24), pair('lines', '+120 −45 ≈', 24)])
    const dim = nodesOf(treeAt(NONE, 89), 'Text').find(t => textOf(t) === 'not a git repo')!
    expect(dim.props).toMatchObject({ dimColor: true })
  })

  test('the header breaks only between segments, so no row starts or ends with the separator, at any width from 20 to 60', () => {
    const models = [
      { name: 'Opus 5.5', version: '2.1.295', effort: 'xhigh' },
      { name: 'Opus 5.5 [1m]', version: '2.1.295', effort: 'medium' },
      { name: 'Mx'.repeat(30), version: '2.1.295', effort: 'max' },
      { name: 'Opus 5.5', version: '', effort: null },
    ]
    for (const v of models) {
      for (let columns = MIN_W + 2; columns <= 62; columns++) {
        for (const errors of [0, 3]) {
          const header = partsAt(makeSnap({ model: { ok: true, v }, errors }), columns).cards[0]!.body
          for (const row of header) {
            expect(row.trim().startsWith('·'), `${columns} "${row}"`).toBe(false)
            expect(row.trim().endsWith('·'), `${columns} "${row}"`).toBe(false)
          }
        }
      }
    }
    // the case of the report: the model row and the liveness need more than the 32 cells inside
    const body = partsAt(calm({ model: { ok: true, v: models[0]! } }), 24).cards[0]!.body
    expect(body.slice(0, 2)).toEqual(['Opus 5.5 · xhigh', `v2.1.295${' '.repeat(18 - 8 - 7)}● 02:41`])
  })




  test('cpu with no share yet is a dash, and a plain number where there is no history', () => {
    expect(card(makeSnap({ cpu: { ok: true, v: null } }), 49, 'SYSTEM').body[0]).toBe(pair('cpu', '—', 43))
    expect(card(NONE, 49, 'SYSTEM', { cpuHist: [] }).body[0]).toBe(pair('cpu', '1%', 43))
  })

  test('goldens at w=32, w=34 and w=22, framed, in a directory that is no repository', () => {
    expect(textAt(NONE, 34)).toEqual([
      "╭──────────────────────────────╮",
      "│ Opus 5.5 · xhigh · v2.1.295  │",
      "│               mcp ✗  ● 02:41 │",
      "│ 遷移 statusline 到 mod pane  │",
      "│ 的討論與實作 · 1hr 20min     │",
      "╰──────────────────────────────╯",
      "",
      "╭──────────────────────────────╮",
      "│ CONTEXT                   3% │",
      "│ ▉░░░░░░░░░░░░░░░░░░░░░░░░░░░ │",
      "│ used            32.0K / 1.0M │",
      "│ compact                    0 │",
      "│ 達 60% 建議 /compact         │",
      "╰──────────────────────────────╯",
      "",
      "╭──────────────────────────────╮",
      "│ 5H                         — │",
      "│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │",
      "╰──────────────────────────────╯",
      "",
      "╭──────────────────────────────╮",
      "│ 7D                       69% │",
      "│ ███████████████████▍░░░░░░░░ │",
      "│ resets     2d16h · Sun 18:41 │",
      "╰──────────────────────────────╯",
      "",
      "╭──────────────────────────────╮",
      "│ COST          session  total │",
      "│ ──────────────────────────── │",
      "│ $                3.20  12.34 │",
      "│ tokens        230.0K≈  1.2M≈ │",
      "╰──────────────────────────────╯",
      "",
      "╭──────────────────────────────╮",
      "│ GIT                          │",
      "│ branch        not a git repo │",
      "│ dir                 /project │",
      "│ lines             +120 −45 ≈ │",
      "╰──────────────────────────────╯",
      "",
      "╭──────────────────────────────╮",
      "│ ACTIVITY                     │",
      "│ agents                       │",
      "│ general-purp               ○ │",
      "│ Explore               ✓×3 5m │",
      "│ edited                       │",
      "│                settings.json │",
      "│                      SPEC.md │",
      "│                 register.tsx │",
      "╰──────────────────────────────╯",
      "",
      "╭──────────────────────────────╮",
      "│ SYSTEM                       │",
      "│          ░░░░░░░▃█▂░░░░░░    │",
      "│ cpu      ▁▁▁▂▄▆████▅▂▁▁▁▂ 1% │",
      "│ ram           45%  7.0/15.6G │",
      "│ mcp            5/6  notion ✗ │",
      "│ memory    global · project · │",
      "│                      3 rules │",
      "╰──────────────────────────────╯",
    ])
    expect(textAt(NONE, 36)).toEqual([
      "╭────────────────────────────────╮",
      "│ Opus 5.5 · xhigh · v2.1.295    │",
      "│                 mcp ✗  ● 02:41 │",
      "│ 遷移 statusline 到 mod pane    │",
      "│ 的討論與實作 · 1hr 20min       │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ CONTEXT                     3% │",
      "│ ▉░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │",
      "│ used 32.0K / 1.0M    compact 0 │",
      "│ 達 60% 建議 /compact           │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ 5H                           — │",
      "│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ 7D                         69% │",
      "│ ████████████████████▊░░░░░░░░░ │",
      "│ resets       2d16h · Sun 18:41 │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ COST            session  total │",
      "│ ────────────────────────────── │",
      "│ $                  3.20  12.34 │",
      "│ tokens          230.0K≈  1.2M≈ │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ GIT                            │",
      "│ branch          not a git repo │",
      "│ dir                   /project │",
      "│ lines               +120 −45 ≈ │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ ACTIVITY                       │",
      "│ agents                         │",
      "│ general-purp                 ○ │",
      "│ Explore                 ✓×3 5m │",
      "│ edited                         │",
      "│                  settings.json │",
      "│                        SPEC.md │",
      "│                   register.tsx │",
      "╰────────────────────────────────╯",
      "",
      "╭────────────────────────────────╮",
      "│ SYSTEM                         │",
      "│            ░░░░░░░▃█▂░░░░░░    │",
      "│ cpu        ▁▁▁▂▄▆████▅▂▁▁▁▂ 1% │",
      "│ ram             45%  7.0/15.6G │",
      "│ mcp              5/6  notion ✗ │",
      "│ memory      global · project · │",
      "│                        3 rules │",
      "╰────────────────────────────────╯",
    ])
    expect(textAt(NONE, 24)).toEqual([
      "╭────────────────────╮",
      "│ Opus 5.5 · xhigh   │",
      "│ v2.1.295           │",
      "│     mcp ✗  ● 02:41 │",
      "│ 遷移 statusline 到 │",
      "│ mod pane 的討論與… │",
      "│ 1hr 20min          │",
      "╰────────────────────╯",
      "",
      "╭────────────────────╮",
      "│ CONTEXT         3% │",
      "│ ▌░░░░░░░░░░░░░░░░░ │",
      "│ used  32.0K / 1.0M │",
      "│ compact          0 │",
      "│ 達 60% 建議        │",
      "│ /compact           │",
      "╰────────────────────╯",
      "",
      "╭────────────────────╮",
      "│ 5H               — │",
      "│ ░░░░░░░░░░░░░░░░░░ │",
      "╰────────────────────╯",
      "",
      "╭────────────────────╮",
      "│ 7D             69% │",
      "│ ████████████▍░░░░░ │",
      "│ resets       2d16h │",
      "│          Sun 18:41 │",
      "╰────────────────────╯",
      "",
      "╭────────────────────╮",
      "│ COST               │",
      "│ $ session     3.20 │",
      "│ tok session        │",
      "│            230.0K≈ │",
      "│ $ total      12.34 │",
      "│ tok total    1.2M≈ │",
      "╰────────────────────╯",
      "",
      "╭────────────────────╮",
      "│ GIT                │",
      "│ branch             │",
      "│     not a git repo │",
      "│ dir       /project │",
      "│ lines   +120 −45 ≈ │",
      "╰────────────────────╯",
      "",
      "╭────────────────────╮",
      "│ ACTIVITY           │",
      "│ agents             │",
      "│ general-purp     ○ │",
      "│ Explore     ✓×3 5m │",
      "│ edited             │",
      "│      settings.json │",
      "│            SPEC.md │",
      "│       register.tsx │",
      "╰────────────────────╯",
      "",
      "╭────────────────────╮",
      "│ SYSTEM             │",
      "│     ░░▃█▂░░░░░░    │",
      "│ cpu ▆████▅▂▁▁▁▂ 1% │",
      "│ ram                │",
      "│     45%  7.0/15.6G │",
      "│ mcp  5/6  notion ✗ │",
      "│ memory    global · │",
      "│          project · │",
      "│            3 rules │",
      "╰────────────────────╯",
    ])
  })

})


describe('narrow ACTIVITY and the least gap between a label and its value', () => {
  const agentsAt = (v: Snap['agents'], edited: Snap['edited'] = { ok: true, v: [] }) => card(makeSnap({ agents: v, edited }), 36, 'ACTIVITY').body

  test('an agent is one row: the name, then the status and a compact age against the right edge', () => {
    const body = agentsAt({
      ok: true,
      v: [
        { name: 'general-purpose', running: 0, done: 1, latest: MOCKUP_AT - 60_000 },
        { name: 'Explore', running: 0, done: 3, latest: MOCKUP_AT - 14 * 3_600_000 },
        { name: 'Plan', running: 2, done: 0, latest: 0 },
      ],
    })
    expect(body).toEqual(['agents', pair('general-purp', '✓ 1m', 30), pair('Explore', '✓×3 14h', 30), pair('Plan', '○×2', 30), pair('edited', 'idle', 30)])
  })

  test('at most three agents, then how many more', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `a${i}`, running: 1, done: 0, latest: 0 }))
    expect(agentsAt({ ok: true, v: many }).slice(0, 5)).toEqual(['agents', pair('a0', '○', 30), pair('a1', '○', 30), pair('a2', '○', 30), right('+2 more', 30)])
  })

  test('the files are basenames, newest first, one a row, three at most and then how many more', () => {
    const files = ['/r/old.md', '/r/src/mid.ts', '/r/docs/new-20261009.md', '/r/a.ts', '/r/b.ts']
    const body = agentsAt({ ok: true, v: [] }, { ok: true, v: files })
    expect(body).toEqual([pair('agents', 'idle', 30), 'edited', right('b.ts', 30), right('a.ts', 30), right('new-20261009.md', 30), right('+2 more', 30)])
  })

  test('a name wider than the pane alone is cut in the middle, its ends kept', () => {
    const long = `/r/${'x'.repeat(20)}-final-report-${'y'.repeat(20)}.md`
    const row = agentsAt({ ok: true, v: [] }, { ok: true, v: [long] }).at(-1)!
    expect(dw(row)).toBe(30)
    expect(row.trim()).toMatch(/^x+.*…[y.]*md$/)
    expect(row.trim().startsWith('x')).toBe(true)
  })

  test('between a label and its value there are always two cells, or the value goes under the label, at every width from 20 to 60', () => {
    const snaps = [makeSnap(), makeSnap({ errors: 3 }), makeSnap({ git: { ok: true, v: { branch: 'feature/long-branch-name', repo: '', status: { ok: true, v: { added: 12, modified: 345, untracked: 6789 } } } } })]
    for (const snap of snaps) {
      for (let columns = MIN_W + 2; columns <= 62; columns++) {
        {
          for (const c of cardsOf(layoutAt(snap, columns))) {
            const inner = c.width - 4
            c.rows.forEach((row, i) => {
              // the title row and the rows of the two pairs of CONTEXT keep their own spacing
              if (i === 0 || row.kind !== 'split' || row.parts.length !== 2 || row.parts[0]!.length === 0 || row.parts[1]!.length === 0) return
              if (c.id === 'context' || c.id === 'header') return
              const free = inner - widthOf2(row.parts[0]!) - widthOf2(row.parts[1]!)
              expect(free, `${c.id} at ${columns}: ${JSON.stringify(row.parts)}`).toBeGreaterThanOrEqual(2)
            })
          }
        }
      }
    }
  })
})
const widthOf2 = (line: { text: string }[]): number => line.reduce((n, s) => n + dw(s.text), 0)


describe('the header carries what must not be missed when the cards below are off the screen', () => {
  const header = (snap: Snap, columns = 89) => partsAt(snap, columns).cards[0]!.body
  const DOWN = { ok: true as const, v: { total: 3, healthy: 2, bad: [{ name: 'a', isAuth: false }] } }
  const AUTH = { ok: true as const, v: { total: 3, healthy: 2, bad: [{ name: 'a', isAuth: true }] } }

  test('errors and a server that is down sit left of the liveness, in red', () => {
    expect(header(calm({ errors: 2 }))[0]).toMatch(/^Opus 5\.5 · max · v2\.1\.294 +2 errors {2}● \d\d:\d\d$/)
    expect(header(calm({ errors: 1 }))[0]).toMatch(/ 1 error {2}● /)
    expect(header(calm({ mcp: DOWN }))[0]).toMatch(/^Opus 5\.5 · max · v2\.1\.294 +mcp ✗ {2}● \d\d:\d\d$/)
    expect(header(calm({ mcp: DOWN, errors: 3 }))[0]).toMatch(/ mcp ✗ {2}3 errors {2}● /)
    const tree = treeAt(calm({ mcp: DOWN, errors: 3 }), 89)
    expect(nodesOf(tree, 'Text').find(t => textOf(t) === '3 errors')!.props).toMatchObject({ color: PALETTE.red })
    expect(nodesOf(tree, 'Text').find(t => textOf(t) === '✗' && t.props?.color === 'red')).toBeDefined()
  })

  test('a server that needs auth is a yellow △, nothing wrong shows nothing, and the toggle that hides the mcp row hides it', () => {
    expect(header(calm({ mcp: AUTH }))[0]).toMatch(/ mcp △ {2}● /)
    expect(nodesOf(treeAt(calm({ mcp: AUTH }), 89), 'Text').find(t => textOf(t) === '△')!.props).toMatchObject({ color: 'yellow' })
    expect(header(calm())[0]).not.toMatch(/mcp|error/)
    expect(header(calm({ mcp: DOWN, toggles: without('memory_mcp').toggles }))[0]).not.toContain('mcp')
  })

  test('they share the liveness row to the last cell, and a cell less sends them to rows of their own', () => {
    // 20 columns are 16 cells inside: '1 error  ● 02:41' is exactly 16
    expect(header(calm({ errors: 1 }), 20)).toContain('1 error  ● 02:41')
    expect(header(calm({ errors: 10 }), 20).join('\n')).not.toContain('10 errors  ●')
    // 24 columns are 18 inside: 'mcp ✗  2 errors  ● 02:41' is 24, so the flags take a row, packed two cells apart
    const body = header(calm({ mcp: DOWN, errors: 2 }), 24)
    expect(body.some(r => /^ +mcp ✗  2 errors$/.test(r))).toBe(true)
    expect(body.some(r => /^ +● \d\d:\d\d$/.test(r) || /● \d\d:\d\d$/.test(r))).toBe(true)
  })

  test('they stay in the header at every width, on the model row, the summary row or a row of their own', () => {
    for (let columns = MIN_W + 2; columns <= 62; columns++) {
      const body = header(calm({ mcp: DOWN, errors: 2 }), columns).join('\n')
      expect(body, `${columns}`).toContain('2 errors')
      expect(body, `${columns}`).toContain('mcp ✗')
      expect(body, `${columns}`).toMatch(/● \d\d:\d\d/)
    }
  })
})

describe('cards are framed at every width, in every room', () => {
  test('never borderless at any width from 20 to 122 and any room from 5 to 60 rows', () => {
    for (let columns = MIN_W + 2; columns <= 122; columns += 3) {
      for (let rows = 5; rows <= 60; rows += 11) {
        for (const snap of [makeSnap(), makeSnap({ errors: 2 })]) {
          const view = { columns, nowMs: MOCKUP_AT, tzMin: 0, raster: true, cpuHist: HIST, rows } as PaneView
          const lines = renderTree(layoutTree(paneLayout(snap, view), FAKE_ELS) as unknown as Node, columns)
          expect(lines.some(l => l.includes('↓ more')), `${columns} x ${rows}`).toBe(false)
          expect(lines.filter(l => l.includes('╭')).length, `${columns} x ${rows}`).toBe(lines.filter(l => l.includes('╰')).length)
          expect(lines.filter(l => l.includes('╭')).length).toBeGreaterThanOrEqual(4)
          expect(lines).toEqual(textAt(snap, columns))
        }
      }
    }
  })

  test('the narrow tier leaves one blank row between its cards, and the medium and wide tiers none', () => {
    const blanks = (columns: number) => textAt(makeSnap(), columns).filter(l => l === '').length
    expect(blanks(36)).toBe(7)
    expect(blanks(38)).toBe(7)
    expect(blanks(49)).toBe(0)
    expect(blanks(89)).toBe(0)
    const lines = textAt(makeSnap(), 36)
    lines.forEach((l, i) => {
      if (l === '') {
        expect(lines[i - 1]!.startsWith('╰')).toBe(true)
        expect(lines[i + 1]!.startsWith('╭')).toBe(true)
      }
    })
  })
})


describe('the reset clock: the countdown run forward from the snapshot, on the clock of the liveness', () => {
  const FRI = (hh: number, mm: number) => Date.UTC(2026, 9, 9, hh, mm, 0)
  const snapAt = (at: number, fiveSec: number | null, sevenSec: number | null, fiveP: number | null = 20) =>
    makeSnap({ at, quota: { ok: true, v: { five: { pct: fiveP, resetSec: fiveSec }, seven: { pct: 60, resetSec: sevenSec } } } })
  // 38 columns are a card with 32 cells inside, room for the countdown and the clock on one row
  const five = (snap: Snap, columns = 38, over?: Partial<PaneView>) => card(snap, columns, '5H', over).body
  const seven = (snap: Snap, columns = 38, over?: Partial<PaneView>) => card(snap, columns, '7D', over).body

  test('5H on the day of the snapshot is the time alone, with the countdown it was run from', () => {
    expect(five(makeSnap())[1]).toBe(pair('resets', '2h10m · 04:51', 32))
    expect(five(snapAt(FRI(9, 5), 20 * 60, 3600))[1]).toBe(pair('resets', '0h20m · 09:25', 32))
  })

  test('5H that falls on a later date names the weekday', () => {
    expect(five(snapAt(FRI(23, 30), 3 * 3600, 86_400))[1]).toBe(pair('resets', '3h0m · Sat 02:30', 32))
  })

  test('across midnight: one minute short of it is still today, the minute itself is the next day', () => {
    expect(five(snapAt(FRI(23, 58), 60, 86_400))[1]).toBe(pair('resets', '0h1m · 23:59', 32))
    expect(five(snapAt(FRI(23, 58), 120, 86_400))[1]).toBe(pair('resets', '0h2m · Sat 00:00', 32))
    expect(five(snapAt(FRI(0, 0), 5 * 3600 - 1, 86_400))[1]).toBe(pair('resets', '4h59m · 04:59', 32))
  })

  test('the seconds of the snapshot and of the countdown are carried: 10:59:50 and 20 s is 11:00', () => {
    const at = Date.UTC(2026, 9, 9, 10, 59, 50)
    expect(five(snapAt(at, 20, 86_400))[1]).toBe(pair('resets', '0h0m · 11:00', 32))
    expect(five(snapAt(at, 9, 86_400))[1]).toBe(pair('resets', '0h0m · 10:59', 32))
  })

  test('7D always names its weekday, on the day of the snapshot too', () => {
    expect(seven(makeSnap())[1]).toBe(pair('resets', '3d4h · Mon 06:41', 32))
    expect(seven(snapAt(FRI(2, 0), 300, 3600))[1]).toBe(pair('resets', '0d1h · Fri 03:00', 32))
    expect(seven(snapAt(FRI(2, 0), 300, 3 * 86_400 + 4 * 3600))[1]).toBe(pair('resets', '3d4h · Mon 06:00', 32))
  })

  test('the clock is in the zone the liveness is in', () => {
    expect(five(makeSnap(), 38, { tzMin: 480 })[1]).toBe(pair('resets', '2h10m · 12:51', 32))
    // 23:30 UTC is already Saturday 07:30 at +8, and 3 h later is the same day there
    expect(five(snapAt(FRI(23, 30), 3 * 3600, 86_400), 38, { tzMin: 480 })[1]).toBe(pair('resets', '3h0m · 10:30', 32))
    expect(five(snapAt(FRI(23, 30), 3 * 3600, 86_400), 38, { tzMin: -300 })[1]).toBe(pair('resets', '3h0m · 21:30', 32))
    // the liveness and the clock read the same offset
    expect(partsAt(makeSnap(), 38, { tzMin: 480 }).cards[0]!.body.join(' ')).toContain('● 10:41')
  })

  test('a countdown that wrapped by its period is run forward as it is drawn, so the two agree', () => {
    // 4 h 0 m is what a 5 h window that reset an hour ago draws, and 6 d 0 h for the 7 d one that reset a day ago
    expect(five(snapAt(FRI(2, 41), 4 * 3600, 6 * 86_400, null))[1]).toBe(pair('resets', '4h0m · 06:41', 32))
    expect(seven(snapAt(FRI(2, 41), 4 * 3600, 6 * 86_400, null))[1]).toBe(pair('resets', '6d0h · Thu 02:41', 32))
  })

  test('the clock goes under the countdown, against the right edge, when the two do not fit with the label gap', () => {
    // '2h10m · 04:51' is 13 and the label with its two cells is 8: 21 cells hold it, 20 do not
    expect(five(makeSnap(), 27).slice(1)).toEqual([pair('resets', '2h10m · 04:51', 21)])
    expect(five(makeSnap(), 26).slice(1)).toEqual([pair('resets', '2h10m', 20), right('04:51', 20)])
    // medium and wide cards follow the same rule
    expect(five(makeSnap(), 49).slice(1)).toEqual([pair('resets', '2h10m', 19), right('04:51', 19)])
    expect(seven(makeSnap(), 89).slice(1)).toEqual([pair('resets', '3d 4h', 24), right('Mon 06:41', 24)])
    expect(five(makeSnap(), 89).slice(1)).toEqual([pair('resets', '2h 10m · 04:51', 24)])
  })

  test('the countdown and the clock are bright, the separator and the label dim', () => {
    const tree = treeAt(makeSnap(), 38)
    // the row of the 5H card that holds the countdown: its Texts are the countdown, the separator and the clock
    const row = nodesOf(tree, 'Box').find(b => kidsOf(b).filter(isNode).some(k => textOf(k) === '2h10m'))!
    const texts = nodesOf(row, 'Text')
    expect(texts.map(textOf)).toEqual(['2h10m', ' · ', '04:51'])
    expect(texts.map(n => n.props?.dimColor === true)).toEqual([false, true, false])
    const text = (t: string) => nodesOf(tree, 'Text').find(n => textOf(n) === t)!
    expect(nodesOf(tree, 'Text').filter(n => textOf(n) === 'resets').every(n => n.props?.dimColor === true)).toBe(true)
  })

  test('no reset time is no clock: the bar alone, an unknown reading or not', () => {
    expect(five(snapAt(FRI(2, 41), null, null)).length).toBe(1)
    expect(seven(snapAt(FRI(2, 41), null, null)).join(' ')).not.toMatch(/\d\d:\d\d/)
    const unknown = snapAt(FRI(2, 41), null, null, null)
    expect(card(unknown, 38, '5H').value).toBe('—')
    expect(five(unknown).join(' ')).not.toMatch(/resets|\d\d:\d\d/)
  })

  test('the tail has no clock', () => {
    expect(tailText(makeSnap(), MOCKUP_AT, 0)).toBe('ctx 3% · 5h 23% · 7d 61% · $3.20 · 02:41')
  })
})
