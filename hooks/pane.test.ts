import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  EDIT_CALL,
  HEADER_89_DETAIL,
  HEADER_89_MODEL,
  MOCKUP_AT,
  SID,
  START,
  TURN_DONE,
  WORLD_49,
  WORLD_89,
  boot,
  cardOf,
  cpuHistory,
  editResult,
  headerOf,
  hintText,
  installWorld,
  makeWorld,
  mountPane,
  paneText,
  paneView,
  pair,
  pinSyncOff,
  right,
  summarize,
  without,
} from './fixture'
import type { World } from './fixture'
import { PALETTE } from './pane'
import { paneParts } from './tree'
import type { PaneParts } from './tree'

const ROWS_FILE = '/root/.claude/cc-statusline-rows.json'
const EFFORT_FILE = '/root/.claude/effort-current.txt'

const pad = (n: number) => String(n).padStart(2, '0')
/** The clock of the fixture's snapshot in the local time of this machine, as the header and the tail show it. */
const HM = (() => {
  const d = new Date(MOCKUP_AT)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
})()

const COMMAND = {
  command: 'status-pane',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 200 },
} as const

describe('#11 /status-pane', () => {
  test('opens the pane under its id and says it was placed', async ($, on) => {
    const world = makeWorld()
    installWorld(on, world)
    on('command.run', () => ({ text: 'NOT HANDLED' }))

    const ran = await $.command.run(COMMAND)

    expect(world.opened).toEqual([{ id: 'status-pane', title: 'Status' }])
    expect(ran.text).toContain('placed')
    expect(ran.text).not.toContain('not placed')
    expect(ran.text).not.toContain('NOT HANDLED')
  })

  test('when the surface cannot seat it, the text carries the reason', async ($, on) => {
    const world = makeWorld()
    world.openResult = { isPlaced: false, reason: 'terminal is 90 columns, the dock needs 110' }
    installWorld(on, world)
    on('command.run', () => ({ text: 'NOT HANDLED' }))

    const ran = await $.command.run(COMMAND)

    expect(world.opened.map(o => o.id)).toEqual(['status-pane'])
    expect(ran.text).toContain('not placed')
    expect(ran.text).toContain('terminal is 90 columns, the dock needs 110')
  })
})

describe('session.start', () => {
  test('registers the command, opens the pane unasked, arms the 30 s timer, and does not wait for the first refresh', async ($, on) => {
    const world = makeWorld()
    world.hang.add('session.usage')
    installWorld(on, world)

    await $.session.start(START)

    expect(world.registered).toEqual(['status-pane', 'progress', 'keeplist'])
    expect(world.opened).toEqual([{ id: 'status-pane', title: 'Status' }])
    expect(world.armed).toEqual([30_000])
  })
})

describe('#10 pane through the engine', () => {
  test('the first refresh fills every card, on every surface, wide and medium', async ($, on) => {
    await boot($, on)

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const wide = await paneView($, 89, surface)
      expect(summarize(wide)).toEqual(WORLD_89)
      expect(headerOf(wide).body[0]).toMatch(HEADER_89_MODEL)
      expect(headerOf(wide).body[1]).toBe(HEADER_89_DETAIL)
      const medium = await paneView($, 49, surface)
      expect(summarize(medium)).toEqual(WORLD_49)
      for (const parts of [wide, medium]) {
        expect([...parts.footer, ...parts.cards.flatMap(c => c.body)].filter(l => l.includes('n/a ('))).toEqual([])
      }
    }
  })

  test('narrow stacks every card full width', async ($, on) => {
    await boot($, on)
    const parts = await paneView($, 36)
    expect(parts.cards.map(c => [c.title, c.width])).toEqual([
      ['', 34],
      ['PROGRESS', 34],
      ['CONTEXT', 34],
      ['5H', 34],
      ['7D', 34],
      ['COST', 34],
      ['GIT', 34],
      ['ACTIVITY', 34],
      ['SYSTEM', 34],
    ])
    expect(cardOf(parts, 'COST').body).toEqual(['─'.repeat(30), `$${' '.repeat(14)}   3.50   10.25`, `tokens${' '.repeat(9)} 32.0K≈  33.5K≈`])
  })

  test('the header and the tail tell local time', async ($, on) => {
    await boot($, on)
    expect(headerOf(await paneView($)).body[0]).toMatch(new RegExp(`● ${HM}$`))
    expect(await hintText($)).toMatch(new RegExp(` · ${HM}$`))
  })

  test('before the first refresh the pane says it is waiting', async ($, on) => {
    installWorld(on, makeWorld())
    const parts = await paneView($)
    expect(parts.cards.map(c => c.body)).toEqual([['waiting for the first refresh']])
    expect(parts.footer).toEqual([])
  })

  test('the timer draws a new snapshot every 30 s', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    expect(world.usageCalls).toBe(1)

    await advance(30_000)
    await clock.settle()
    expect(world.usageCalls).toBe(2)

    await advance(30_000)
    await clock.settle()
    expect(world.usageCalls).toBe(3)
  })
})

describe('the CPU history', () => {
  const STAT = (idle: number, busy: number) => `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 1 1 1 1 1 1 0 0 0\n`
  /** A machine whose counters start at a known place, and a way to let `share` percent of the next 100 ticks be busy. */
  const machine = (world: World, clock: { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }) => {
    let idle = 1000
    let busy = 0
    return {
      start: () => world.files.set('/proc/stat', STAT(idle, busy)),
      read: async (share: number) => {
        idle += 100 - share
        busy += share
        world.files.set('/proc/stat', STAT(idle, busy))
        // one 30 s step: the fixture's 1 s steps only add work, and the refresh tick falls on this mark
        world.now += 30_000
        await clock.advance(30_000)
        await clock.settle()
      },
    }
  }
  const boot0 = async ($: Engine, on: Parameters<typeof boot>[1]) => {
    const up = await boot($, on, w => w.files.set('/proc/stat', STAT(1000, 0)))
    return { ...up, cpu: machine(up.world, up.clock) }
  }
  /** The chart's two rows in the SYSTEM card at `columns`: the row above the label line, and the label line itself. */
  const chart = async ($: Engine, columns = 49) => {
    const body = cardOf(await paneView($, columns), 'SYSTEM').body
    const at = body.findIndex(l => l.startsWith('cpu'))
    return { top: body[at - 1] ?? '', line: body[at] ?? '' }
  }
  const systemOf = async ($: Engine, columns = 49, surface: 'terminal' | 'desktop' = 'terminal') => cardOf(await paneView($, columns, surface), 'SYSTEM').body

  test('the first reading has no share to draw and adds no sample; each reading after adds the one it made', async ($, on) => {
    const { world, cpu } = await boot0($, on)
    expect(cpuHistory(world)).toEqual([])
    expect(world.stateSets.filter(k => k === 'cpuHist')).toEqual([])
    expect((await systemOf($))[0]).toBe(pair('cpu', '—', 43))

    await cpu.read(50)
    expect(cpuHistory(world)).toEqual([50])
    await cpu.read(20)
    await cpu.read(100)
    expect(cpuHistory(world)).toEqual([50, 20, 100])
    expect(world.stateSets.filter(k => k === 'cpuHist')).toHaveLength(3)
  })

  test('the chart draws the ring on a 0..100 axis: two rows, the newest at the right, empty columns before', async ($, on) => {
    const { cpu } = await boot0($, on)
    await cpu.read(50)
    await cpu.read(20)
    await cpu.read(100)

    const { top, line } = await chart($)
    // 50 is eight sixteenths (the bottom row full), 20 is three, 100 is both rows full; the chart is 16 columns beside the value
    expect(line).toBe(pair('cpu', '░░░░░░░░░░░░░█▃█ 100%', 43))
    expect(top).toBe(`${' '.repeat(22)}${'░'.repeat(15)}█`)
  })

  test('a reading that failed adds no sample, and the next one is measured from the last that worked', async ($, on) => {
    const { world, advance, clock, cpu } = await boot0($, on)
    await cpu.read(50)

    world.denyRead.add('/proc/stat')
    await advance(30_000)
    await clock.settle()
    expect(cpuHistory(world)).toEqual([50])
    expect((await systemOf($)).some(l => l.includes('cpu n/a (EACCES'))).toBe(true)

    world.denyRead.delete('/proc/stat')
    await cpu.read(100)
    expect(cpuHistory(world)).toEqual([50, 100])
    expect((await chart($)).line).toBe(pair('cpu', '░░░░░░░░░░░░░░██ 100%', 43))
  })

  test('the ring keeps the last 16 readings', async ($, on) => {
    const { world, cpu } = await boot0($, on)
    for (let i = 1; i <= 20; i++) await cpu.read(i * 5)

    expect(cpuHistory(world)).toEqual(Array.from({ length: 16 }, (_, i) => (i + 5) * 5))
    expect((await chart($)).line).toMatch(/^cpu {2,}\S{16} 100%$/)
  })

  test('a history that cannot be written costs the chart and nothing else', async ($, on) => {
    const { world, cpu } = await boot0($, on)
    world.denyState.add('cpuHist')
    await cpu.read(50)

    expect(cpuHistory(world)).toEqual([])
    const parts = await paneView($, 49)
    expect(Object.keys(summarize(parts).cards)).toEqual(Object.keys(WORLD_49.cards))
    expect(cardOf(parts, 'CONTEXT').body).toEqual(WORLD_49.cards.CONTEXT?.body)
    expect(cardOf(parts, 'SYSTEM').body[0]).toBe(pair('cpu', '50%', 43))
  })

  test('a history that cannot be read costs the chart and nothing else', async ($, on) => {
    const { world, cpu } = await boot0($, on)
    await cpu.read(50)
    world.denyGet.add('cpuHist')

    const parts = await paneView($, 49)
    expect(Object.keys(summarize(parts).cards)).toEqual(Object.keys(WORLD_49.cards))
    expect(cardOf(parts, 'CONTEXT').body).toEqual(WORLD_49.cards.CONTEXT?.body)
    expect(cardOf(parts, 'SYSTEM').body[0]).toBe(pair('cpu', '50%', 43))
  })

  test('a surface with no Raster draws the history as a sparkline in the line', async ($, on) => {
    const { cpu } = await boot0($, on)
    await cpu.read(50)
    await cpu.read(100)
    expect((await systemOf($, 49, 'desktop'))[0]).toBe(pair('cpu', '▅█ 100%', 43))
  })
})

describe('#8 row toggles through the rows file', () => {
  test('enabled:false leaves one card naming the rows file, and the tail untouched', async ($, on) => {
    await boot($, on, w => w.files.set(ROWS_FILE, '{"enabled":false}'))

    const parts = await paneView($)
    expect(parts.cards.map(c => c.body)).toEqual([['disabled by ~/.claude/cc-statusline-rows.json']])
    expect(parts.footer).toEqual([])
    expect(await hintText($, 'esc to interrupt')).toBe('? for shortcuts|esc to interrupt')
    expect(await hintText($)).toBe('? for shortcuts|')
  })

  test('enabled:false is the master switch: nothing is collected or written, as statusline.js L31 returns before anything', async ($, on) => {
    const { world, advance, clock } = await boot($, on, w => w.files.set(ROWS_FILE, '{"enabled":false}'))
    world.toolResult = () => editResult(['+a'])

    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await $.turn.complete(TURN_DONE)
    await advance(30_000)
    await clock.settle()

    expect(world.ran).toEqual([])
    expect(world.writes).toEqual([])
    expect(world.moves).toEqual([])
    expect(world.usageCalls).toBe(0)
    expect(world.settingsCalls).toBe(0)
    expect([...new Set(world.reads)]).toEqual([ROWS_FILE])
    expect((await paneView($)).cards.map(c => c.body)).toEqual([['disabled by ~/.claude/cc-statusline-rows.json']])
    expect(await hintText($, 'esc to interrupt')).toBe('? for shortcuts|esc to interrupt')

    // switched on again, the next refresh collects, and the lines counted meanwhile are persisted
    world.files.set(ROWS_FILE, '{}')
    await advance(30_000)
    await clock.settle()
    expect(cardOf(await paneView($), 'GIT').body[2]).toBe(pair('lines', '+201 −4 ≈', 24))
  })

  test('a single key off removes only that card, and its segments leave the tail', async ($, on) => {
    await boot($, on, w => w.files.set(ROWS_FILE, pinSyncOff('{"quota":false,"waiting":false}')))

    const parts = await paneView($)
    // 5H and 7D gone, CONTEXT has the whole width to itself
    expect(parts.cards.map(c => [c.title, c.width])).toEqual([['', 87], ['PROGRESS', 87], ['CONTEXT', 87], ['COST', 29], ['GIT', 28], ['ACTIVITY', 28], ['SYSTEM', 87]])
    expect(summarize(parts).cards).toMatchObject(without(WORLD_89.cards, '5H', '7D', 'CONTEXT'))
    expect(cardOf(parts, 'CONTEXT').value).toBe('3%')
    expect(parts.footer).toEqual(WORLD_89.footer)
    expect(await hintText($)).toMatch(/^\? for shortcuts\|ctx 3% · \$3\.50 · \d\d:\d\d$/)
  })

  test('the file as it stands on this machine keeps every card', async ($, on) => {
    const real = `{ "enabled": true, "summary": true, "dir": true, "repo": true, "model": true, "cost": true,
      "usage": true, "quota": true, "agents": true, "memory_mcp": true, "edited": true, "history": true,
      "summaryInterval": 30 }`
    await boot($, on, w => w.files.set(ROWS_FILE, pinSyncOff(JSON.stringify({ ...JSON.parse(real), waiting: false }))))
    expect(summarize(await paneView($))).toEqual(WORLD_89)
  })

  test('rows that are off are not collected: no git for dir and repo, no /proc for sys', async ($, on) => {
    const { world } = await boot($, on, w => w.files.set(ROWS_FILE, pinSyncOff('{"dir":false,"repo":false,"sys":false,"waiting":false}')))

    expect(world.ran.filter(r => r.argv[0] === 'git')).toEqual([])
    expect(world.reads).not.toContain('/proc/stat')
    expect(world.reads).not.toContain('/proc/meminfo')
    const parts = await paneView($)
    expect(parts.cards.map(c => c.title)).toEqual(['', 'PROGRESS', 'CONTEXT', '5H', '7D', 'COST', 'ACTIVITY', 'SYSTEM'])
    expect(cardOf(parts, 'SYSTEM').body).toEqual([pair('mcp', '2/3  figma ✗', 83), pair('memory', 'global · project · 3 rules', 83)])
    expect(parts.footer).toEqual([])
  })

  test('a pair with one side off gives the other the full width', async ($, on) => {
    await boot($, on, w => w.files.set(ROWS_FILE, pinSyncOff('{"dir":false,"repo":false,"waiting":false}')))
    const parts = await paneView($, 49)
    expect(parts.cards.map(c => [c.title, c.width])).toEqual([
      ['', 47],
      ['PROGRESS', 47],
      ['CONTEXT', 47],
      ['5H', 23],
      ['7D', 23],
      ['COST', 47],
      ['ACTIVITY', 47],
      ['SYSTEM', 47],
    ])
  })

  test('cost off leaves the tokens row, usage off the $ row: the card is TOKENS or COST, and with both off it is gone', async ($, on) => {
    await boot($, on, w => w.files.set(ROWS_FILE, pinSyncOff('{"cost":false,"waiting":false}')))
    const costOff = await paneView($)
    expect(costOff.cards.map(c => c.title)).toEqual(['', 'PROGRESS', 'CONTEXT', '5H', '7D', 'TOKENS', 'GIT', 'ACTIVITY', 'SYSTEM'])
    expect(cardOf(costOff, 'TOKENS').body).toEqual(['─'.repeat(25), `tokens${' '.repeat(4)} 32.0K≈  33.5K≈`])
    expect(cardOf(costOff, 'TOKENS').value).toBe('session   total')
  })

  test('usage off leaves the $ row under COST, and takes CONTEXT with it', async ($, on) => {
    await boot($, on, w => w.files.set(ROWS_FILE, pinSyncOff('{"usage":false,"waiting":false}')))
    const usageOff = await paneView($)
    expect(usageOff.cards.map(c => c.title)).toEqual(['', 'PROGRESS', '5H', '7D', 'COST', 'GIT', 'ACTIVITY', 'SYSTEM'])
    expect(cardOf(usageOff, 'COST').body).toEqual(['─'.repeat(25), `$${' '.repeat(10)}   3.50  10.25`])
  })

  test('with cost and usage both off there is no COST or TOKENS card', async ($, on) => {
    await boot($, on, w => w.files.set(ROWS_FILE, pinSyncOff('{"cost":false,"usage":false,"waiting":false}')))
    const both = await paneView($)
    expect(both.cards.map(c => c.title)).toEqual(['', 'PROGRESS', '5H', '7D', 'GIT', 'ACTIVITY', 'SYSTEM'])
  })
})

describe('#10 what the pane hands the surface', () => {
  test('a column Box with one cell of padding either side; cards that are Boxes with a round border', async ($, on) => {
    await boot($, on)
    const ui = await mountPane($)

    const root = await ui.drawn()
    expect(root).toMatchObject({ type: 'Box', props: { flexDirection: 'column', paddingX: 1 } })
    const parts = paneParts(root, 89)
    for (const card of parts.cards) {
      expect(card.node.props).toMatchObject({ borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexDirection: 'column' })
    }
    expect(parts.cards.map(c => c.width)).toEqual([87, 87, 29, 28, 28, 29, 28, 28, 87])
    await ui.unmount()
  })

  test('Texts carry the colours: cyan on the model and the titles, the tone on the value in a title, dim on a label', async ($, on) => {
    await boot($, on)
    const ui = await mountPane($)

    expect((await ui.findAll({ type: 'Text', text: 'Opus 5.5' })).map(t => t.props)).toEqual([
      { color: 'cyan', bold: true, wrap: 'truncate-end' },
    ])
    expect((await ui.find({ type: 'Text', text: 'max' }))?.props).toMatchObject({ color: 'red' })
    expect((await ui.find({ type: 'Text', text: 'CONTEXT' }))?.props).toMatchObject({ bold: true, color: 'cyan' })
    expect((await ui.find({ type: 'Text', text: '3%' }))?.props).toMatchObject({ color: PALETTE.green })
    expect((await ui.find({ type: 'Text', text: 'used' }))?.props).toMatchObject({ dimColor: true })
    // the session column of the COST matrix is bold, its total is not
    expect((await ui.find({ type: 'Text', text: '   3.50' }))?.props).toMatchObject({ bold: true })
    expect((await ui.find({ type: 'Text', text: ' 10.25' }))?.props?.bold).toBeUndefined()
    await ui.unmount()
  })
})

describe('#9 prompt tail through the engine', () => {
  test('an upstream tail is kept and ours follows; the hint is not rewritten', async ($, on) => {
    await boot($, on)

    expect(await hintText($, 'esc to interrupt')).toMatch(
      /^\? for shortcuts\|esc to interrupt · ctx 3% · 5h 23% · 7d 61% · \$3\.50 · \d\d:\d\d$/,
    )
    expect(await hintText($)).toMatch(/^\? for shortcuts\|ctx 3% · 5h 23% · 7d 61% · \$3\.50 · \d\d:\d\d$/)
  })

  test('before the first refresh the tail is left as the engine drew it', async ($, on) => {
    installWorld(on, makeWorld())
    expect(await hintText($, 'esc to interrupt')).toBe('? for shortcuts|esc to interrupt')
  })
})

describe('#12 liveness', () => {
  /** The liveness dot of the header and the word after it. */
  const live = async (ui: Awaited<ReturnType<typeof mountPane>>) => {
    const dot = await ui.find({ type: 'Text', text: '●' })
    const stale = await ui.find({ type: 'Text', text: / stale / })
    return { dot: dot?.props.color, stale: stale?.text, staleColor: stale?.props.color }
  }

  test('the header ages: a green dot with the time, a yellow one with the age at 120 s, a red one at 400 s', async ($, on) => {
    const { world } = await boot($, on)
    const look = async () => {
      const ui = await mountPane($)
      const seen = await live(ui)
      await ui.unmount()
      return seen
    }

    expect(await look()).toEqual({ dot: PALETTE.green, stale: undefined, staleColor: undefined })
    world.now += 120_000
    expect(await look()).toEqual({ dot: PALETTE.yellow, stale: ' stale 120s', staleColor: PALETTE.yellow })
    world.now += 280_000
    expect(await look()).toEqual({ dot: PALETTE.red, stale: ' stale 400s', staleColor: PALETTE.red })
    expect(headerOf(await paneView($)).body[0]).toMatch(/● stale 400s$/)
  })

  test('the tail says stale in place of the time once the snapshot is past 90 s', async ($, on) => {
    const { world } = await boot($, on)
    world.now += 91_000
    expect(await hintText($)).toBe('? for shortcuts|ctx 3% · 5h 23% · 7d 61% · $3.50 · stale')
  })

  test('a turn that ends after 90 s without a refresh arms the timer again and refreshes at once', async ($, on) => {
    const { world, clock } = await boot($, on)
    expect(world.armed).toEqual([30_000])
    expect(world.usageCalls).toBe(1)

    world.now += 100_000
    await $.turn.complete(TURN_DONE)
    await clock.settle()

    expect(world.armed).toEqual([30_000, 30_000])
    expect(world.usageCalls).toBe(2)
    expect(headerOf(await paneView($)).body[0]).not.toContain('stale')

    world.now += 10_000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    expect(world.armed).toHaveLength(2)
    expect(world.usageCalls).toBe(3)
  })
})

describe('#13 a collector that fails', () => {
  /** The errors chip: the last row of the SYSTEM card, or alone under the cards when that card is off. */
  const errors = (parts: PaneParts) => cardOf(parts, 'SYSTEM').body.at(-1) ?? parts.footer.at(-1)

  test('/proc/stat unreadable: cpu says why on a line of its own, every other card draws, the footer counts one error', async ($, on) => {
    await boot($, on, w => w.denyRead.add('/proc/stat'))

    const parts = await paneView($)
    expect(without(summarize(parts).cards, 'SYSTEM')).toEqual(without(WORLD_89.cards, 'SYSTEM'))
    expect(cardOf(parts, 'SYSTEM').body).toEqual([
      "cpu n/a (EACCES: permission denied, open '/proc/stat')",
      pair('ram', '45%  7.0/15.6G', 83),
      pair('mcp', '2/3  figma ✗', 83),
      pair('memory', 'global · project · 3 rules', 83),
      right('1 error', 83),
    ])
  })

  test('usage() rejecting: the cards that need it say why, lines and the rest still draw (R19)', async ($, on) => {
    await boot($, on, w => {
      w.usage = new Error('usage unavailable')
    })

    const parts = await paneView($)
    const why = 'n/a (usage unavailable)'
    const { cards } = summarize(parts)
    expect(cards.CONTEXT).toEqual({ value: '', body: [why] })
    expect(cards['5H']).toEqual({ value: '', body: [why] })
    expect(cards['7D']).toEqual({ value: '', body: [why] })
    // the matrix keeps its two rows with a dash in each cell, and each says why
    const dashes = `${' '.repeat(6)}—  ${' '.repeat(4)}—`
    expect(cards.COST).toEqual({
      value: 'session  total',
      body: ['─'.repeat(25), `$${' '.repeat(10)}${dashes}`, `tokens${' '.repeat(5)}${dashes}`, 'cost n/a (usage', 'unavailable)', 'tokens n/a (usage', 'unavailable)'],
    })
    // the lines come from the cum file alone, and the rest never asked usage()
    expect(cards.GIT).toEqual(WORLD_89.cards.GIT)
    expect(cards.ACTIVITY).toEqual(WORLD_89.cards.ACTIVITY)
    expect(errors(parts)?.trim()).toBe('4 errors')
  })

  test('a failure behind rows that are switched off is not counted: with cost and usage off only the lines show it', async ($, on) => {
    await boot($, on, w => {
      w.files.set(ROWS_FILE, pinSyncOff('{"cost":false,"usage":false}'))
      w.denyWrite.add('/tmp/claude-cum-c07353bf22c447df82966f2d.json')
    })

    const parts = await paneView($)
    expect(parts.cards.map(c => c.title)).not.toContain('COST')
    expect(parts.cards.map(c => c.title)).not.toContain('TOKENS')
    // only the lines show the cum file's failure; the cost and the tokens are behind rows that are off
    expect(parts.cards.flatMap(c => c.body).filter(l => l.includes('n/a (EACCES'))).toHaveLength(1)
    expect(errors(parts)?.trim()).toBe('1 error')
  })

  test('the tokens row is the usage toggle\'s: with cost off it still shows its failure and counts it', async ($, on) => {
    await boot($, on, w => {
      w.files.set(ROWS_FILE, pinSyncOff('{"cost":false}'))
      w.denyWrite.add('/tmp/claude-cum-c07353bf22c447df82966f2d.json')
    })

    const parts = await paneView($)
    const tokens = cardOf(parts, 'TOKENS')
    expect(tokens.value).toBe('session  total')
    expect(tokens.body[1]).toBe(`tokens${' '.repeat(5)}${' '.repeat(6)}—  ${' '.repeat(4)}—`)
    expect(tokens.body.filter(l => l.startsWith('tokens n/a (EACCES'))).toHaveLength(1)
    // the lines and the tokens
    expect(errors(parts)?.trim()).toBe('2 errors')
  })

  test('a git status that never answers is given up on after its own budget and the branch stays (R24)', async ($, on) => {
    const { advance, clock } = await boot($, on, w => w.hang.add('process.run:git status --porcelain'))
    expect((await paneView($)).cards.map(c => c.body)).toEqual([['waiting for the first refresh']])

    await advance(3900)
    await clock.settle()
    expect((await paneView($)).cards.map(c => c.body)).toEqual([['waiting for the first refresh']])

    await advance(600)
    await clock.settle()

    const parts = await paneView($)
    expect(cardOf(parts, 'GIT').body).toEqual([pair('branch', 'main', 24), pair('dir', '~/project', 24), pair('lines', '+200 −4 ≈', 24), 'git n/a (timeout)'])
    expect(errors(parts)?.trim()).toBe('1 error')
  })

  test('a git call that never answers is given up on after its 2 s plus the guard slack, and costs only the git part', async ($, on) => {
    const { advance, clock } = await boot($, on, w => w.hang.add('process.run:git rev-parse --abbrev-ref HEAD'))
    expect((await paneView($)).cards.map(c => c.body)).toEqual([['waiting for the first refresh']])

    await advance(2400)
    await clock.settle()
    expect((await paneView($)).cards.map(c => c.body)).toEqual([['waiting for the first refresh']])

    await advance(200)
    await clock.settle()

    const parts = await paneView($)
    expect(cardOf(parts, 'GIT').body).toEqual(['git n/a (timeout)', pair('dir', '~/project', 24), pair('lines', '+200 −4 ≈', 24)])
    expect(summarize(parts).cards).toMatchObject(without(WORLD_89.cards, 'GIT', 'SYSTEM'))
    expect(errors(parts)?.trim()).toBe('1 error')
  })
})

describe('#14 effort', () => {
  /** The first row of the header: the model, the effort, the version. */
  const modelRow = async ($: Engine) => (await paneView($)).cards[0]!.body[0]!.replace(/ {2,}.*$/, '')
  const postToolUse = (extra: Record<string, unknown>) =>
    ({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'u1', ...extra }) as const
  const noEnv = (w: World) => {
    delete w.env.CLAUDE_EFFORT
  }
  /** No live source and the settings name a level: the case of a session that has had no prompt. */
  const configured = (settings: Record<string, unknown>) => (w: World) => {
    noEnv(w)
    w.settings = { ...w.settings, ...settings }
  }
  const effortText = async ($: Engine, text: string | RegExp) => {
    const ui = await mountPane($)
    const node = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return node?.props
  }

  test('a CLAUDE_EFFORT the engine refuses to give leaves the model up, the level left out', async ($, on) => {
    await boot($, on, w => w.denyEnv.add('CLAUDE_EFFORT'))
    expect(await modelRow($)).toBe('Opus 5.5 · v2.1.294')
  })

  test('with no hook input, no CLAUDE_EFFORT and nothing configured the level and its separator are left out, with no ? (L2)', async ($, on) => {
    const { world } = await boot($, on, noEnv)
    expect(await modelRow($)).toBe('Opus 5.5 · v2.1.294')
    for (const columns of [36, 49, 89]) expect(headerOf(await paneView($, columns)).body.join('\n')).not.toContain('?')
    expect(await effortText($, /^\?$/)).toBeUndefined()
    // the global cache file said `low` here, and it must not be read
    expect(world.reads).not.toContain(EFFORT_FILE)
  })

  test('a classic hook input carries the level, and the newest one wins', async ($, on) => {
    const { advance, clock } = await boot($, on, noEnv)

    await $.classic.PostToolUse(postToolUse({ effort: { level: 'xhigh' } }))
    await advance(30_000)
    await clock.settle()
    expect(await modelRow($)).toBe('Opus 5.5 · xhigh · v2.1.294')

    await $.classic.Stop({ stop_hook_active: false, effort: { level: 'High' } })
    await advance(30_000)
    await clock.settle()
    expect(await modelRow($)).toBe('Opus 5.5 · high · v2.1.294')
  })

  test('a hook input beats CLAUDE_EFFORT, which answers when no hook input has', async ($, on) => {
    const { advance, clock } = await boot($, on, w => {
      w.env.CLAUDE_EFFORT = 'medium'
    })
    expect(await modelRow($)).toBe('Opus 5.5 · medium · v2.1.294')

    await $.classic.PostToolUse(postToolUse({ effort: { level: 'low' } }))
    await advance(30_000)
    await clock.settle()
    expect(await modelRow($)).toBe('Opus 5.5 · low · v2.1.294')
  })

  test("a subagent's input does not change the session's level", async ($, on) => {
    const { advance, clock } = await boot($, on)

    await $.classic.PostToolUse(postToolUse({ effort: { level: 'low' }, agent_id: 'sub1', agent_type: 'Explore' }))
    await advance(30_000)
    await clock.settle()

    expect(await modelRow($)).toBe('Opus 5.5 · max · v2.1.294')
  })

  test('a level seen in one session does not carry into the next session id (R3)', async ($, on) => {
    const { world, advance, clock } = await boot($, on, noEnv)
    await $.classic.PostToolUse(postToolUse({ effort: { level: 'xhigh' } }))
    await advance(30_000)
    await clock.settle()
    expect(await modelRow($)).toBe('Opus 5.5 · xhigh · v2.1.294')

    world.session.id = 'ffffffff-0000-4000-8000-000000000001'
    await advance(30_000)
    await clock.settle()
    expect(await modelRow($)).toBe('Opus 5.5 · v2.1.294')

    await $.classic.Stop({ stop_hook_active: false, effort: { level: 'low' } })
    await advance(30_000)
    await clock.settle()
    expect(await modelRow($)).toBe('Opus 5.5 · low · v2.1.294')
  })

  describe('before any hook has reported, the effort the settings name', () => {
    test('a session with no prompt shows the configured level, dim and in no level colour', async ($, on) => {
      await boot($, on, configured({ effortLevel: 'max' }))
      expect(await modelRow($)).toBe('Opus 5.5 · max · v2.1.294')
      const props = await effortText($, 'max')
      expect(props).toMatchObject({ dimColor: true })
      expect(props?.color).toBeUndefined()
    })

    test('the level a hook reports beats the configured one, and has its level colour', async ($, on) => {
      const { advance, clock } = await boot($, on, configured({ effortLevel: 'low' }))
      expect(await modelRow($)).toBe('Opus 5.5 · low · v2.1.294')

      await $.classic.Stop({ stop_hook_active: false, effort: { level: 'xhigh' } })
      await advance(30_000)
      await clock.settle()
      expect(await modelRow($)).toBe('Opus 5.5 · xhigh · v2.1.294')
      const props = await effortText($, 'xhigh')
      expect(props).toMatchObject({ color: '#ff8700' })
      expect(props?.dimColor).toBeUndefined()
    })

    test('the top-level effortLevel beats a modelSettings entry', async ($, on) => {
      await boot($, on, configured({ effortLevel: 'medium', modelSettings: { 'claude-opus-5': { effortLevel: 'high' } } }))
      expect(await modelRow($)).toBe('Opus 5.5 · medium · v2.1.294')
    })

    test('with no top-level level the modelSettings key that is the longest prefix of the model id wins', async ($, on) => {
      const modelSettings = {
        'claude-opus': { effortLevel: 'low' },
        'claude-opus-5': { effortLevel: 'high' },
        'claude-opus-5-5': { effortLevel: 'xhigh' },
        'claude-sonnet-5': { effortLevel: 'max' },
      }
      const { world, advance, clock } = await boot($, on, configured({ modelSettings }))
      expect(await modelRow($)).toBe('Opus 5.5 · xhigh · v2.1.294')

      world.session.model = 'claude-opus-5-1'
      await advance(30_000)
      await clock.settle()
      expect(await modelRow($)).toContain(' · high · ')

      world.session.model = 'claude-opus-4-8'
      await advance(30_000)
      await clock.settle()
      expect(await modelRow($)).toContain(' · low · ')

      world.session.model = 'claude-haiku-5'
      await advance(30_000)
      await clock.settle()
      expect(await modelRow($)).not.toMatch(/ · (low|high|xhigh|max) · /)
    })

    test('a level in one source is found though the merged settings do not carry it', async ($, on) => {
      const { world } = await boot($, on, w => {
        noEnv(w)
        w.settingsBySource = { user: { modelSettings: { 'claude-opus-5': { effortLevel: 'high' } } } }
      })
      expect(await modelRow($)).toBe('Opus 5.5 · high · v2.1.294')
      expect(world.settingsCalls).toBeGreaterThan(0)
    })

    test('nothing configured, or a settings read that fails, leaves the effort out', async ($, on) => {
      await boot($, on, w => {
        noEnv(w)
        w.denySettings = true
        w.settingsBySource = { user: { effortLevel: 'high' } }
      })
      expect(await modelRow($)).toBe('Opus 5.5 · v2.1.294')
    })

    test('the settings are read for the model row when it is the only row that needs them', async ($, on) => {
      const { world } = await boot($, on, w => {
        configured({ effortLevel: 'high' })(w)
        w.files.set(ROWS_FILE, '{"summary":false,"agents":false,"usage":false,"edited":false}')
      })
      expect(world.settingsCalls).toBeGreaterThan(0)
      expect(await modelRow($)).toBe('Opus 5.5 · high · v2.1.294')
    })

    test('with the model row off nothing is configured to show and the settings are not read for it', async ($, on) => {
      const { world } = await boot($, on, w => {
        configured({ effortLevel: 'high' })(w)
        w.files.set(ROWS_FILE, '{"summary":false,"agents":false,"usage":false,"edited":false,"model":false}')
      })
      expect(world.settingsCalls).toBe(0)
    })
  })
})

describe('L1 the model part of the header', () => {
  test('names the session model the way the native line does, bracket suffix kept', async ($, on) => {
    await boot($, on, w => {
      w.session.model = 'claude-opus-5-5[1m]'
    })
    expect(headerOf(await paneView($)).body[0]).toMatch(/^Opus 5\.5 \[1m\] · max · v2\.1\.294 /)
  })

  test('an id it cannot read is shown as it came', async ($, on) => {
    await boot($, on, w => {
      w.session.model = 'some-other-model'
    })
    expect(headerOf(await paneView($)).body[0]).toMatch(/^some-other-model · max · v2\.1\.294 /)
  })
})

describe('L3 a turn is followed by one more refresh', () => {
  test('3 s later, even inside the 5 s gap that holds back the immediate one', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    expect(world.usageCalls).toBe(1)

    await $.turn.complete(TURN_DONE)
    await clock.settle()
    expect(world.usageCalls).toBe(1)

    await advance(2900)
    await clock.settle()
    expect(world.usageCalls).toBe(1)

    await advance(200)
    await clock.settle()
    expect(world.usageCalls).toBe(2)

    await advance(5000)
    await clock.settle()
    expect(world.usageCalls).toBe(2)
  })

  test('the immediate refresh stays, and two turns close together leave a single follow-up', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    expect(world.usageCalls).toBe(2)

    await advance(1000)
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    await advance(3100)
    await clock.settle()
    expect(world.usageCalls).toBe(3)
  })
})

describe('R2 R16 R26 the stale marks repaint without a refresh', () => {
  /** The word after the dot, as the open pane shows it now. */
  const marks = async (ui: Awaited<ReturnType<typeof mountPane>>) =>
    (await ui.findAll({ type: 'Text', text: / stale / })).map(f => [f.text.trim(), f.props.color])

  test('an open pane ages to yellow after 90 s and to red after 300 s while no refresh runs', async ($, on) => {
    const { advance } = await boot($, on, w => w.hang.add('clock.every'))
    const ui = await mountPane($)
    expect(await marks(ui)).toEqual([])

    await advance(91_500)
    expect(await marks(ui)).toEqual([['stale 91s', PALETTE.yellow]])

    await advance(210_000)
    expect(await marks(ui)).toEqual([['stale 301s', PALETTE.red]])
    await ui.unmount()
  })

  test('the tail under the prompt turns to stale on its own too', async ($, on) => {
    const { advance } = await boot($, on, w => w.hang.add('clock.every'))
    const ui = await $.ui.mount({
      plugin: 'status-pane',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    })
    expect((await ui.find({ type: 'Text' }))?.text).toMatch(/\d\d:\d\d$/)

    await advance(91_500)
    expect((await ui.find({ type: 'Text' }))?.text).toBe('? for shortcuts|ctx 3% · 5h 23% · 7d 61% · $3.50 · stale')
    await ui.unmount()
  })

  test('a refresh writes its own marks anew, so a live timer never lets a pane go stale', async ($, on) => {
    const { advance, clock } = await boot($, on)
    const ui = await mountPane($)
    for (let i = 0; i < 4; i++) {
      await advance(30_000)
      await clock.settle()
    }
    expect(await marks(ui)).toEqual([])
    await ui.unmount()
  })

  test('a refresh that cannot write its snapshot still makes the pane read the clock again (checkedAt)', async ($, on) => {
    const { world, clock } = await boot($, on, w => w.hang.add('clock.every'))
    const ui = await mountPane($)
    world.denyState.add('snap')

    world.now += 120_000
    await $.turn.complete(TURN_DONE)
    await clock.settle()

    expect(await marks(ui)).toEqual([['stale 120s', PALETTE.yellow]])
    await ui.unmount()
  })

  test('the next snapshot cancels the timers of the last one, so a live refresh leaves nothing to fire', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    await advance(95_000)
    await clock.settle()
    expect(world.invalidated).toEqual([])
  })

  test('a refresh whose clock call fails still makes the pane read the clock again', async ($, on) => {
    const { world, clock } = await boot($, on, w => w.hang.add('clock.every'))
    const ui = await mountPane($)

    world.now += 120_000
    world.denyNow = 1
    await $.session.start(START)
    await clock.settle()

    expect(await marks(ui)).toEqual([['stale 120s', PALETTE.yellow]])
    await ui.unmount()
  })

  test('and the tail under the prompt too', async ($, on) => {
    const { world, clock } = await boot($, on, w => w.hang.add('clock.every'))
    const ui = await $.ui.mount({
      plugin: 'status-pane',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    })
    world.denyState.add('snap')

    world.now += 120_000
    await $.turn.complete(TURN_DONE)
    await clock.settle()

    expect((await ui.find({ type: 'Text' }))?.text).toMatch(/ · stale$/)
    await ui.unmount()
  })
})

describe('S2 a draw never throws', () => {
  const FAULT = (why: string) => `status-pane n/a (cannot draw: ${why})`
  const quiet = (w: World) => w.hang.add('clock.every')

  test('a clock that refuses during the draw leaves one line saying so, not the engine\'s empty pane', async ($, on) => {
    const { world } = await boot($, on, quiet)
    world.denyNow = 1
    expect(await paneText($)).toEqual([FAULT('clock unavailable')])
  })

  test('a state read that is refused during the draw leaves one line saying so', async ($, on) => {
    const { world } = await boot($, on, quiet)
    world.denyGet.add('snap')
    expect(await paneText($)).toEqual([FAULT('state read refused')])
  })

  test('the pane draws again once the refusal is over', async ($, on) => {
    const { world } = await boot($, on, quiet)
    world.denyNow = 1
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^status-pane n\/a/ })).toBeDefined()

    world.now += 1000
    await ui.unmount()
    expect(summarize(await paneView($)).cards).toMatchObject({ CONTEXT: { value: '3%' } })
  })

  test('the tail leaves what the engine drew, an upstream tail included, when the clock refuses during the draw', async ($, on) => {
    const { world } = await boot($, on, quiet)
    world.denyNow = 1
    expect(await hintText($, 'esc to interrupt')).toBe('? for shortcuts|esc to interrupt')
  })

  test('and when a state read is refused during the draw', async ($, on) => {
    const { world } = await boot($, on, quiet)
    world.denyGet.add('checkedAt')
    expect(await hintText($, 'esc to interrupt')).toBe('? for shortcuts|esc to interrupt')
  })

  test('the tail comes back by itself once the refusal is over, when the next refresh writes its snapshot', async ($, on) => {
    const { world, clock } = await boot($, on, quiet)
    world.denyNow = 1
    const ui = await $.ui.mount({
      plugin: 'status-pane',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('? for shortcuts|')

    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    expect((await ui.find({ type: 'Text' }))?.text).toMatch(/^\? for shortcuts\|ctx 3% · 5h 23% /)
    await ui.unmount()
  })
})

describe('R13 ~/.gemini first, as statusline.js resolves it', () => {
  const entry = (resets: number) => ({
    t: Math.floor(MOCKUP_AT / 1000) - 20,
    five_hour: { used_percentage: 40, resets_at: resets },
    seven_day: null,
  })

  test('the rows file and the shared rate-limit file in ~/.gemini win over the ~/.claude copies', async ($, on) => {
    const { world } = await boot($, on, w => {
      w.files.set('/root/.gemini/cc-statusline-rows.json', pinSyncOff('{"quota":false,"waiting":false}'))
      w.files.set(ROWS_FILE, '{"enabled":false}')
      w.files.set('/root/.gemini/rate-limit-snapshots.json', JSON.stringify({ other: entry(Math.floor(MOCKUP_AT / 1000) + 9000) }))
    })

    const cards = summarize(await paneView($)).cards
    expect(Object.keys(cards)).toEqual(['CONTEXT', 'COST', 'GIT', 'ACTIVITY', 'SYSTEM'])
    expect(cards.CONTEXT?.value).toBe('3%')
    const gemini = JSON.parse(world.files.get('/root/.gemini/rate-limit-snapshots.json') ?? 'null')
    expect(Object.keys(gemini).sort()).toEqual(['other', SID].sort())
    expect(world.files.has('/root/.claude/rate-limit-snapshots.json')).toBe(false)
  })

  test('without a ~/.gemini copy the ~/.claude ones are used', async ($, on) => {
    const { world } = await boot($, on)
    expect(world.files.has('/root/.claude/rate-limit-snapshots.json')).toBe(true)
    expect(world.files.has('/root/.gemini/rate-limit-snapshots.json')).toBe(false)
  })
})

describe('R22 a rows file that cannot be read keeps the toggles the pane had', () => {
  test('a half-written file or a refused read leaves a hidden row hidden; no file at all means every row', async ($, on) => {
    const { world, advance, clock } = await boot($, on, w => w.files.set(ROWS_FILE, '{"quota":false}'))
    const quotaHidden = async () => !(await paneView($)).cards.some(c => c.title === '5H')
    expect(await quotaHidden()).toBe(true)

    world.files.set(ROWS_FILE, '{"quota":')
    await advance(30_000)
    await clock.settle()
    expect(await quotaHidden()).toBe(true)

    world.files.set(ROWS_FILE, '{"quota":false}')
    world.denyRead.add(ROWS_FILE)
    await advance(30_000)
    await clock.settle()
    expect(await quotaHidden()).toBe(true)

    world.denyRead.clear()
    world.files.delete(ROWS_FILE)
    await advance(30_000)
    await clock.settle()
    expect(await quotaHidden()).toBe(false)
  })
})
