import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'

import { MOCKUP_AT, NOW_SEC, SID, boot, mountPane, pinSyncOff, setUsage } from './fixture'
import type { World } from './fixture'
import { decodeCells, findOverflow, paneParts, renderTree } from './tree'
import type { Node } from './tree'

const SURFACES: RenderSurface[] = ['terminal', 'desktop', 'vscode', 'mobile']
const NOT_TERMINAL: RenderSurface[] = ['desktop', 'vscode', 'mobile']
const ROWS_FILE = '/root/.claude/cc-statusline-rows.json'

// the colours the gauges are drawn in, as 0xRRGGBB
const GREEN = 0x3fb950
const YELLOW = 0xd29922
const RED = 0xf85149
const TRACK = 0x30363d

type Mounted = Awaited<ReturnType<typeof mountPane>>

/** The cells of the Raster with this key, as `[glyph, foreground, background]`. */
const cellsOf = async (ui: Mounted, key: string) => {
  const found = await ui.find({ type: 'Raster', key })
  if (!found) throw new Error(`no Raster ${key}`)
  return { props: found.props, cells: decodeCells(String(found.props.cells)).map(c => [c.glyph, c.fg, c.bg] as const) }
}

const BREAKPOINTS = [
  {
    columns: 36,
    name: 'narrow',
    cards: [['', 34], ['PROGRESS', 34], ['CONTEXT', 34], ['5H', 34], ['7D', 34], ['COST', 34], ['GIT', 34], ['ACTIVITY', 34], ['SYSTEM', 34]],
  },
  {
    columns: 49,
    name: 'medium',
    cards: [['', 47], ['PROGRESS', 47], ['CONTEXT', 47], ['5H', 23], ['7D', 23], ['COST', 24], ['GIT', 22], ['ACTIVITY', 47], ['SYSTEM', 47]],
  },
  {
    columns: 89,
    name: 'wide',
    cards: [['', 87], ['PROGRESS', 87], ['CONTEXT', 29], ['5H', 28], ['7D', 28], ['COST', 29], ['GIT', 28], ['ACTIVITY', 28], ['SYSTEM', 87]],
  },
] as const

describe('the kit mounts the pane on every surface at the three breakpoints', () => {
  // one boot and two mounts per test: a mount costs about 0.15 s, so the four surfaces are split in two
  for (const { columns, name, cards } of BREAKPOINTS) {
    for (const [half, surfaces] of [['terminal and desktop', SURFACES.slice(0, 2)], ['vscode and mobile', SURFACES.slice(2)]] as const) {
      // load 68 in the whole-suite run: 3.8 s (5 s limit); 15 s here, the assertions are unchanged
      test(`bodyColumns ${columns} (${name}), ${half}: the tree validates and holds the cards of that breakpoint`, { timeoutMs: 15_000 }, async ($, on) => {
        await boot($, on)
        for (const surface of surfaces) {
          // the mount resolves only when the surface's table accepts every element and prop of the tree
          const ui = await mountPane($, columns, surface)
          const root = await ui.drawn()
          expect(root).toMatchObject({ type: 'Box', props: { flexDirection: 'column', paddingX: 1 } })
          expect(paneParts(root, columns).cards.map(c => [c.title, c.width])).toEqual(cards)
          await ui.unmount()
        }
      })
    }
  }

  test('the cards are real Boxes with a round dim border and a title row, not lines of text', async ($, on) => {
    await boot($, on)
    for (const surface of SURFACES) {
      const ui = await mountPane($, 89, surface)
      const boxes = (await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle !== undefined)
      expect(boxes.map(b => b.props)).toHaveLength(9)
      for (const props of boxes.map(b => b.props)) {
        expect(props).toMatchObject({ borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexDirection: 'column' })
      }
      const titles = (await ui.findAll({ type: 'Box' })).filter(b => b.props.justifyContent === 'space-between')
      expect(titles.length).toBeGreaterThanOrEqual(9)
      await ui.unmount()
    }
  })
})

describe('cards come and go with the toggles, at every breakpoint', () => {
  const ALL = ['CONTEXT', '5H', '7D', 'COST', 'GIT', 'ACTIVITY', 'SYSTEM']
  // [rows file, cards gone, cards that stay under another title]: cost off leaves the tokens row, so COST is TOKENS
  const CASES: [string, string[], Record<string, string>?][] = [
    ['{"usage":false}', ['CONTEXT']],
    ['{"quota":false}', ['5H', '7D']],
    ['{"cost":false}', [], { COST: 'TOKENS' }],
    ['{"cost":false,"usage":false}', ['CONTEXT', 'COST']],
    ['{"dir":false,"repo":false}', ['GIT']],
    ['{"dir":false}', []],
    ['{"agents":false,"edited":false}', ['ACTIVITY']],
    ['{"agents":false}', []],
    ['{"sys":false}', []],
    ['{"sys":false,"memory_mcp":false}', ['SYSTEM']],
    ['{"progress":false}', ['PROGRESS']],
    ['{"usage":false,"quota":false,"cost":false,"dir":false,"repo":false,"agents":false,"edited":false,"sys":false,"memory_mcp":false,"progress":false}', ['PROGRESS', ...ALL]],
  ]
  for (const [rows, gone, renamed = {}] of CASES) {
    test(`${rows}`, async ($, on) => {
      await boot($, on, w => w.files.set(ROWS_FILE, pinSyncOff(JSON.stringify({ ...JSON.parse(rows), waiting: false }))))
      for (const { columns, cards } of BREAKPOINTS) {
        const expected = cards
          .map(c => c[0])
          .filter(title => !gone.includes(title))
          .map(title => renamed[title] ?? title)
        for (const surface of ['terminal', 'desktop'] as const) {
          const ui = await mountPane($, columns, surface)
          expect(paneParts(await ui.drawn(), columns).cards.map(c => c.title)).toEqual(expected)
          await ui.unmount()
        }
      }
    })
  }

  test('the master switch leaves one card on every surface and breakpoint', async ($, on) => {
    await boot($, on, w => w.files.set(ROWS_FILE, '{"enabled":false}'))
    for (const { columns } of BREAKPOINTS) {
      // the file name is one word of 33 cells, and the narrow card holds 30: it is broken at the hyphen, over two rows
      const text = columns === 36 ? 'disabled by ~/.claude/cc-statusline- rows.json' : 'disabled by ~/.claude/cc-statusline-rows.json'
      for (const surface of SURFACES) {
        const ui = await mountPane($, columns, surface)
        const parts = paneParts(await ui.drawn(), columns)
        expect(parts.cards).toHaveLength(1)
        expect(parts.cards[0]?.body.join(' ')).toBe(text)
        expect(parts.footer).toEqual([])
        await ui.unmount()
      }
    }
  })
})

describe('the gauges are Rasters on the terminal', () => {
  // [percent, CONTEXT (25 cells): full cells and the partial glyph, 5H and 7D (24 cells): the same, the fill colour]
  const GAUGES: { pct: number; c25: [number, string]; c24: [number, string]; tone: number | null }[] = [
    { pct: 0, c25: [0, ''], c24: [0, ''], tone: null },
    { pct: 49, c25: [12, '▎'], c24: [11, '▊'], tone: GREEN },
    { pct: 50, c25: [12, '▌'], c24: [12, ''], tone: YELLOW },
    { pct: 79, c25: [19, '▊'], c24: [19, ''], tone: YELLOW },
    { pct: 80, c25: [20, ''], c24: [19, '▎'], tone: RED },
    { pct: 100, c25: [25, ''], c24: [24, ''], tone: RED },
  ]
  /** What a bar of `columns` cells holds: full cells, the partial one, the rest track. */
  const bar = (columns: number, [full, partial]: [number, string], tone: number | null) => [
    ...Array.from({ length: full }, () => ['█', tone, TRACK]),
    ...(partial ? [[partial, tone, TRACK]] : []),
    ...Array.from({ length: columns - full - (partial ? 1 : 0) }, () => ['█', TRACK, TRACK]),
  ]

  test('at 0, 49, 50, 79, 80 and 100 percent: the fill length, its colour, the partial glyph and the track', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    const reset = new Date((NOW_SEC + 7800) * 1000).toISOString()
    for (const { pct, c25, c24, tone } of GAUGES) {
      setUsage(world, {
        context: { tokens: 32_000, window: 1_000_000, percent: pct },
        rateLimits: [
          { kind: 'five_hour', percentUsed: pct, resetsAt: reset },
          { kind: 'seven_day', percentUsed: pct, resetsAt: reset },
        ],
      })
      await advance(30_000)
      await clock.settle()

      const ui = await mountPane($, 89, 'terminal')
      const context = await cellsOf(ui, 'gauge-context')
      expect(context.props).toMatchObject({ columns: 25, rows: 1 })
      expect(context.cells, `CONTEXT at ${pct}%`).toEqual(bar(25, c25, tone))
      for (const key of ['gauge-5h', 'gauge-7d']) {
        const gauge = await cellsOf(ui, key)
        expect(gauge.props).toMatchObject({ columns: 24, rows: 1 })
        expect(gauge.cells, `${key} at ${pct}%`).toEqual(bar(24, c24, tone))
      }
      await ui.unmount()
    }
  })

  test('the value in the title takes the same tone as the fill', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    for (const [pct, color] of [[49, '#3fb950'], [50, '#d29922'], [79, '#d29922'], [80, '#f85149']] as const) {
      setUsage(world, { context: { tokens: 32_000, window: 1_000_000, percent: pct } })
      await advance(30_000)
      await clock.settle()
      const ui = await mountPane($, 89, 'terminal')
      expect((await ui.find({ type: 'Text', text: `${pct}%` }))?.props).toMatchObject({ color })
      await ui.unmount()
    }
  })

  test('a Raster spans the card inside its border and padding, one row tall', async ($, on) => {
    await boot($, on)
    for (const { columns, cards } of BREAKPOINTS) {
      const ui = await mountPane($, columns, 'terminal')
      const widths = Object.fromEntries(cards.map(([title, width]) => [title, width - 4]))
      const gauges = await ui.findAll({ type: 'Raster' })
      expect(gauges.map(g => [g.key, g.props.columns, g.props.rows])).toEqual([
        ['gauge-context', widths.CONTEXT, 1],
        ['gauge-5h', widths['5H'], 1],
        ['gauge-7d', widths['7D'], 1],
      ])
      await ui.unmount()
    }
  })

  test('no other surface is given a Raster: the gauge is text, the fill in its tone and the track dim', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    setUsage(world, { context: { tokens: 32_000, window: 1_000_000, percent: 49 } })
    await advance(30_000)
    await clock.settle()
    for (const surface of NOT_TERMINAL) {
      const ui = await mountPane($, 89, surface)
      expect(await ui.findAll({ type: 'Raster' })).toEqual([])
      expect((await ui.find({ type: 'Text', text: `${'█'.repeat(12)}▎` }))?.props).toMatchObject({ color: '#3fb950' })
      expect((await ui.find({ type: 'Text', text: '░'.repeat(12) }))?.props).toMatchObject({ dimColor: true })
      await ui.unmount()
    }
  })
})

describe('the CPU history chart', () => {
  const STAT = (idle: number, busy: number) => `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 1 1 1 1 1 1 0 0 0\n`
  const withReadings = async ($: Engine, on: Parameters<typeof boot>[1], shares: number[]) => {
    const up = await boot($, on, w => w.files.set('/proc/stat', STAT(1000, 0)))
    let idle = 1000
    let busy = 0
    for (const share of shares) {
      idle += 100 - share
      busy += share
      up.world.files.set('/proc/stat', STAT(idle, busy))
      await up.advance(30_000)
      await up.clock.settle()
    }
    return up
  }

  test('on the terminal a 16 by 2 Raster: a column a reading, the newest at the right, a tone for each', async ($, on) => {
    await withReadings($, on, [50, 100])
    const ui = await mountPane($, 49, 'terminal')
    const chart = await cellsOf(ui, 'cpu-chart')
    expect(chart.props).toMatchObject({ columns: 16, rows: 2 })
    const top = chart.cells.slice(0, 16)
    const bottom = chart.cells.slice(16)
    const empty = ['█', TRACK, TRACK]
    // 50% is eight sixteenths (the bottom row full, yellow), 100% is both rows full (red)
    expect(top).toEqual([...Array.from({ length: 15 }, () => empty), ['█', RED, TRACK]])
    expect(bottom).toEqual([...Array.from({ length: 14 }, () => empty), ['█', YELLOW, TRACK], ['█', RED, TRACK]])
    await ui.unmount()
  })

  test('no chart before the first reading that has a share', async ($, on) => {
    await boot($, on)
    const ui = await mountPane($, 49, 'terminal')
    expect(await ui.find({ type: 'Raster', key: 'cpu-chart' })).toBeUndefined()
    await ui.unmount()
  })

  test('a surface with no Raster gets the history as text, a glyph a reading', async ($, on) => {
    await withReadings($, on, [50, 100])
    for (const surface of NOT_TERMINAL) {
      const ui = await mountPane($, 49, surface)
      expect(await ui.findAll({ type: 'Raster' })).toEqual([])
      expect((await ui.find({ type: 'Text', text: '▅█' }))?.props).toMatchObject({ dimColor: true })
      await ui.unmount()
    }
  })
})

describe('completeness through the kit: every field of the old pane is in the tree at every breakpoint', () => {
  const pad = (n: number) => String(n).padStart(2, '0')
  const HM = `${pad(new Date(MOCKUP_AT).getHours())}:${pad(new Date(MOCKUP_AT).getMinutes())}`
  /** [card, the value texts of its fields]; the countdowns are written without a blank below wide. */
  const fields = (wide: boolean): [string, string[]][] => [
    ['', ['遷移 statusline 到 mod pane 的討論與實作', 'Opus 5.5', 'max', 'v2.1.294', '1hr 20min', `● ${HM}`]],
    ['CONTEXT', ['3%', 'used', '32.0K / 1.0M', 'compact', '2']],
    ['5H', ['23%', 'resets', wide ? '2h 10m' : '2h10m']],
    ['7D', ['61%', 'resets', wide ? '3d 4h' : '3d4h']],
    ['COST', ['sess', 'total', '$', '3.50', '10.25', 'tok', '32.0K≈', '33.5K≈']],
    ['GIT', ['branch main', 'dir ~/project', 'lines +200 −4 ≈', 'state ✗ +1 ~3 ?2']],
    ['ACTIVITY', ['agents', 'general-purp', 'Explore', '✓×2', '5m', 'edited', 'register.tsx', 'SPEC.md', 'settings.json']],
    ['SYSTEM', ['cpu', '16%', 'ram', '45%', '7.0/15.6G', 'mcp', '2/3', 'figma ✗', 'memory', 'global · project · 3 rules']],
  ]
  const said = (parts: ReturnType<typeof paneParts>, title: string): string => {
    const card = parts.cards.find(c => c.title === title)
    return [card?.title, card?.value, ...(card?.body ?? [])].join(' ').replace(/\s+/g, ' ')
  }

  for (const surface of SURFACES) {
    test(`on ${surface}, at w=34, 47 and 87`, async ($, on) => {
      // the first reading of the CPU has a baseline too, so the card has a share to show and a chart to draw
      await boot($, on, w => w.readOnce.set('cpu', { idle: 0, total: 0 }))
      for (const columns of [36, 49, 89]) {
        const ui = await mountPane($, columns, surface)
        const parts = paneParts(await ui.drawn(), columns)
        for (const [title, values] of fields(columns >= 82)) {
          for (const value of values) expect(said(parts, title), `${surface} ${title || 'header'} at w=${columns - 2}: ${value}`).toContain(value)
        }
        const chart = await ui.find({ type: 'Raster', key: 'cpu-chart' })
        if (surface === 'terminal') expect(chart?.props).toMatchObject({ columns: 16, rows: 2 })
        else expect(chart).toBeUndefined()
        await ui.unmount()
      }
    })
  }
})

describe('no Text passes its box at any width from 20 to 120, through the kit', () => {
  const FIRST = 22
  const LAST = 122
  type On = Parameters<typeof boot>[1]

  // one sweep per test nears the 5 s per-test limit under load, so each scenario is cut in six
  const sweep = async ($: Engine, from: number, to: number) => {
    for (const surface of ['terminal', 'desktop'] as const) {
      for (let columns = from; columns <= to; columns++) {
        const ui = await mountPane($, columns, surface)
        const problems = findOverflow((await ui.drawn()) as Node, columns)
        await ui.unmount()
        expect(problems, `${surface} at bodyColumns ${columns}`).toEqual([])
      }
    }
  }

  test('a healthy session, widths 22 to 40', async ($, on) => {
    await boot($, on)
    await sweep($, 22, 40)
  })

  test('a healthy session, widths 41 to 58', async ($, on) => {
    await boot($, on)
    await sweep($, 41, 58)
  })

  test('a healthy session, widths 59 to 77', async ($, on) => {
    await boot($, on)
    await sweep($, 59, 77)
  })

  // load 68 in the whole-suite run: 2.6 s (5 s limit); 15 s here, the assertions are unchanged
  test('a healthy session, widths 78 to 96', { timeoutMs: 15_000 }, async ($, on) => {
    await boot($, on)
    await sweep($, 78, 96)
  })

  test('a healthy session, widths 97 to 109', async ($, on) => {
    await boot($, on)
    await sweep($, 97, 109)
  })

  test('a healthy session, widths 110 to 122', async ($, on) => {
    await boot($, on)
    await sweep($, 110, 122)
  })

  const longText = async ($: Engine, on: On, from: number, to: number) => {
    await boot($, on, (w: World) => {
      w.files.set(`/tmp/claude-summary-${SID}.txt`, '遷移'.repeat(60))
      w.session.cwd = '/very/long/path/that/goes/on/and/on/and/on/to/QCIDiag/S8P_host_GB300/目錄/目錄'
      w.procs.set('git rev-parse --abbrev-ref HEAD', { stdout: `feature/${'x'.repeat(60)}\n` })
      w.files.set(`/tmp/claude-cum-${SID}.json`, '{"cost":')
      w.files.delete('/proc/meminfo')
      w.usage = new Error('usage refused by a very long and wordy reason that runs on')
    })
    await sweep($, from, to)
  }
  test('a session with long text, wide characters and a failure behind every card, widths 22 to 40', async ($, on) => longText($, on, 22, 40))
  test('a session with long text, wide characters and a failure behind every card, widths 41 to 58', async ($, on) => longText($, on, 41, 58))
  test('a session with long text, wide characters and a failure behind every card, widths 59 to 77', async ($, on) => longText($, on, 59, 77))
  test('a session with long text, wide characters and a failure behind every card, widths 78 to 96', async ($, on) => longText($, on, 78, 96))
  test('a session with long text, wide characters and a failure behind every card, widths 97 to 109', async ($, on) => longText($, on, 97, 109))
  test('a session with long text, wide characters and a failure behind every card, widths 110 to 122', async ($, on) => longText($, on, 110, 122))
})
