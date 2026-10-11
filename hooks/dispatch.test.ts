import { describe, expect, test } from 'claude-code/testing'

import type { World } from './fixture'
import { SID, boot, cardOf, makeSnap, paneText, paneView } from './fixture'
import { DISPATCH_STALE_MS, dispatchOf, parseInflightWarn } from './dispatch'
import { PALETTE, dispatchRows, layoutTree, paneLayout } from './pane'
import type { CardRow } from './pane'
import type { Dispatch, Res } from './state'
import { FAKE_ELS, findOverflow, paneParts } from './tree'
import type { Node } from './tree'

type Hooks = Record<string, { hooks: { command: string }[] }[]>
/** The settings with one tracker script removed from every event, as deps.test.ts does it. */
const unwire = (w: World, script: string) => {
  const hooks = w.settings.hooks as Hooks
  w.settings = {
    hooks: Object.fromEntries(
      Object.entries(hooks).map(([event, groups]) => [
        event,
        groups.map(g => ({ ...g, hooks: g.hooks.filter(h => !h.command.includes(script)) })),
      ]),
    ),
  }
}

// S1 for the in-flight row: how many of this session's subagents are running, with an optional warning above a number the user sets.
const T0 = Date.parse('2026-10-10T12:00:00Z')
const MIN = 60_000
const WIDTHS = [
  { columns: 36, tier: 'narrow' },
  { columns: 49, tier: 'medium' },
  { columns: 89, tier: 'wide' },
] as const
const TRACKER = `/tmp/claude-agents-${SID}.json`
const WARN_ENV = 'STATUS_PANE_INFLIGHT_WARN'

const ok = <T>(v: T): Res<T> => ({ ok: true, v })
const dispatch = (running: number, stale = 0, warn: number | null = null): Res<Dispatch> => ok({ running, stale, warn })
const MISSING: Res<Dispatch> = { ok: false, why: 'agents file missing' }
const UNREADABLE: Res<Dispatch> = { ok: false, why: 'agents file unreadable' }
const squash = (s: string) => s.replace(/\s/g, '')

/** A tracker entry; `agoMs` is how long before T0 it started (negative: in the future), omitted: no `started`. */
const entry = (agoMs: number | undefined, status = 'running', name = 'general-purpose') => ({
  name,
  status,
  ...(agoMs === undefined ? {} : { started: T0 - agoMs }),
})
const done = (name = 'Explore') => ({ name, status: 'done', started: T0 - 5 * MIN, finished: T0 - 4 * MIN })
const tracker = (...entries: Record<string, unknown>[]): string => JSON.stringify(Object.fromEntries(entries.map((e, i) => [`a${i + 1}`, e])))
const fresh = (n: number): Record<string, unknown>[] => Array.from({ length: n }, (_, i) => entry((i + 1) * MIN, 'running', `agent-${i % 3}`))

/** The row's text with spaces dropped, so the spacing kv chooses does not matter. */
const rowText = (rows: CardRow[]): string =>
  squash(rows.map(r => (r.kind === 'split' ? r.parts.map(p => p.map(s => s.text).join('')).join('') : r.kind === 'text' ? r.line.map(s => s.text).join('') : '')).join(''))

describe('dispatch: the tracker file as a count of running subagents', () => {
  test('a missing tracker file with the hook wired is n/a, not 0: the tracker only writes on the first SubagentStart', () => {
    expect(dispatchOf(null, T0)).toEqual(MISSING)
  })

  test('running entries started 1 to 5 minutes ago count; done entries count nowhere', () => {
    const text = tracker(entry(1 * MIN), entry(2 * MIN), entry(3 * MIN), entry(5 * MIN), done(), done(), done())
    expect(dispatchOf(text, T0)).toEqual(dispatch(4, 0))
  })

  test('every running entry counts, not only the top three groups that groupAgents keeps', () => {
    const text = tracker(entry(1 * MIN, 'running', 'a'), entry(1 * MIN, 'running', 'b'), entry(1 * MIN, 'running', 'c'), entry(1 * MIN, 'running', 'd'), entry(1 * MIN, 'running', 'e'), entry(1 * MIN, 'running', 'f'), entry(1 * MIN, 'running', 'g'), entry(1 * MIN, 'running', 'h'))
    expect(dispatchOf(text, T0)).toEqual(dispatch(8, 0))
  })

  test('an entry aged exactly the cutoff is running; one millisecond older is stale', () => {
    expect(dispatchOf(tracker(entry(DISPATCH_STALE_MS)), T0)).toEqual(dispatch(1, 0))
    expect(dispatchOf(tracker(entry(DISPATCH_STALE_MS + 1)), T0)).toEqual(dispatch(0, 1))
  })

  test('a running entry whose started is in the future counts as running', () => {
    expect(dispatchOf(tracker(entry(-MIN)), T0)).toEqual(dispatch(1, 0))
  })

  test('a running entry with no usable started is stale, and nothing throws', () => {
    const text = tracker(entry(undefined), { name: 'x', status: 'running', started: 'soon' }, { name: 'y', status: 'running', started: null })
    expect(dispatchOf(text, T0)).toEqual(dispatch(0, 3))
  })

  test('a status other than running counts nowhere, as groupAgents counts it as done', () => {
    const text = tracker(entry(MIN, 'done'), entry(MIN, 'error'), entry(MIN, 'bogus'), { name: 'x', started: T0 - MIN })
    expect(dispatchOf(text, T0)).toEqual(dispatch(0, 0))
  })

  test('a tracker file that is not a JSON object is unreadable, not 0', () => {
    for (const text of ['{bad', '[]', '3', 'null']) expect(dispatchOf(text, T0)).toEqual(UNREADABLE)
  })

  test('positive control: six fresh running entries read as 6, so a zero elsewhere is not a dead parser', () => {
    expect(dispatchOf(tracker(...fresh(6)), T0)).toEqual(dispatch(6, 0))
  })

  test('the live-shaped file (13 running, 8 of them older than the cutoff) reads 5 running and 8 stale', () => {
    const live = [...fresh(5), entry(40 * MIN), entry(60 * MIN), entry(195 * MIN), entry(9370 * MIN), entry(45 * MIN), entry(31 * MIN), entry(120 * MIN), entry(300 * MIN)]
    expect(dispatchOf(tracker(...live, done(), done()), T0)).toEqual(dispatch(5, 8))
  })

  test('the warning threshold passed in is carried on the count, and absent means no threshold', () => {
    expect(dispatchOf(tracker(...fresh(4)), T0, 3)).toEqual(dispatch(4, 0, 3))
    expect(dispatchOf(tracker(...fresh(4)), T0)).toEqual(dispatch(4, 0, null))
  })
})

describe('dispatch: STATUS_PANE_INFLIGHT_WARN, the optional warning threshold', () => {
  test('a positive integer, with surrounding spaces or leading zeros, is the threshold', () => {
    expect(parseInflightWarn('6')).toBe(6)
    expect(parseInflightWarn(' 6 ')).toBe(6)
    expect(parseInflightWarn('007')).toBe(7)
    expect(parseInflightWarn('1')).toBe(1)
  })

  test('unset, empty, zero, negative and non-numeric values mean no warning', () => {
    for (const raw of [undefined, '', '   ', '0', '00', '-3', '+3', '2.5', '3.0', '1e3', 'six', '6 6', '6x', '0x6']) {
      expect(parseInflightWarn(raw)).toBeNull()
    }
  })

  test('a number past the safe integer range is not a threshold', () => {
    expect(parseInflightWarn('9007199254740993')).toBeNull()
    expect(parseInflightWarn('9007199254740991')).toBe(9007199254740991)
  })
})

describe('dispatch: the in-flight row', () => {
  test('the value is the plain count at each size, with no limit shown', () => {
    expect(rowText(dispatchRows(dispatch(0), 30))).toBe(squash('in-flight0'))
    expect(rowText(dispatchRows(dispatch(5), 30))).toBe(squash('in-flight5'))
    expect(rowText(dispatchRows(dispatch(5), 43))).toBe(squash('in-flight5'))
  })

  test('without a threshold, any count is plain, however large', () => {
    const many = dispatchRows(dispatch(40, 0, null), 43)[0] as Extract<CardRow, { kind: 'split' }>
    expect(rowText([many])).toBe(squash('in-flight40'))
    expect(many.parts[1]![0]!.color).not.toBe(PALETTE.red)
  })

  test('at the threshold it is plain; one above it says over in red and bold', () => {
    const at = dispatchRows(dispatch(6, 0, 6), 30)[0] as Extract<CardRow, { kind: 'split' }>
    expect(rowText([at])).toBe(squash('in-flight6'))
    expect(at.parts[1]![0]!.color).not.toBe(PALETTE.red)
    const over = dispatchRows(dispatch(7, 0, 6), 24)[0] as Extract<CardRow, { kind: 'split' }>
    expect(rowText([over])).toBe(squash('in-flight7over6'))
    expect(over.parts[1]![0]).toMatchObject({ text: '7 over 6', color: PALETTE.red, bold: true })
    expect(rowText(dispatchRows(dispatch(7, 0, 6), 43))).toBe(squash('in-flight7over6'))
  })

  test('stale entries follow the value as dim text, and the row wraps whole when too wide', () => {
    expect(rowText(dispatchRows(dispatch(4, 3), 43))).toBe(squash('in-flight4 · 3 stale'))
    const narrow = dispatchRows(dispatch(4, 3), 14)
    expect(narrow.length).toBeGreaterThan(1)
    expect(rowText(narrow)).toBe(squash('in-flight4 · 3 stale'))
  })

  test('a missing or unreadable tracker reads n/a（原因） with its reason in full, at every width', () => {
    for (const { columns } of WIDTHS) {
      expect(rowText(dispatchRows(MISSING, columns - 6))).toBe(squash('in-flight n/a（agents file missing）'))
      expect(rowText(dispatchRows(UNREADABLE, columns - 6))).toBe(squash('in-flight n/a（agents file unreadable）'))
    }
  })
})

describe('dispatch: the ACTIVITY card at three widths', () => {
  const at = (columns: number, snap = makeSnap({ dispatch: dispatch(7, 0, 6) })) =>
    paneLayout(snap, { columns, nowMs: T0, tzMin: 0, raster: true, cpuHist: [] })

  for (const { columns, tier } of WIDTHS) {
    test(`${tier} (${columns} columns): the in-flight row comes right after the title and nothing overflows`, () => {
      const parts = paneParts(layoutTree(at(columns), FAKE_ELS) as unknown as Node, columns)
      const body = cardOf(parts, 'ACTIVITY').body
      expect(squash(body[0] ?? '')).toContain(squash('in-flight'))
      expect(squash(body.join(''))).toContain(squash('7 over 6'))
      expect(findOverflow(layoutTree(at(columns), FAKE_ELS) as unknown as Node, columns)).toEqual([])
    })

    test(`${tier} (${columns} columns): a missing tracker reads n/a in full and the frame is kept`, () => {
      const snap = makeSnap({ dispatch: MISSING })
      const parts = paneParts(layoutTree(at(columns, snap), FAKE_ELS) as unknown as Node, columns)
      expect(squash(cardOf(parts, 'ACTIVITY').body.join(''))).toContain(squash('in-flight n/a（agents file missing）'))
      expect(findOverflow(layoutTree(at(columns, snap), FAKE_ELS) as unknown as Node, columns)).toEqual([])
    })
  }

  test('a snapshot without dispatch (older shape) draws the ACTIVITY card with no in-flight row', () => {
    const parts = paneParts(layoutTree(at(89, makeSnap()), FAKE_ELS) as unknown as Node, 89)
    expect(squash(cardOf(parts, 'ACTIVITY').body.join(''))).not.toContain(squash('in-flight'))
  })
})

describe('dispatch: through the engine', () => {
  for (const { columns, tier } of WIDTHS) {
    test(`${tier} (${columns} columns): with the threshold 6, fresh entries read plain and seven read over 6`, async ($, on) => {
      const { world, advance } = await boot($, on, w => {
        w.now = T0
        w.env[WARN_ENV] = '6'
        w.files.set(TRACKER, tracker(...fresh(3)))
      })
      expect(squash(cardOf(await paneView($, columns), 'ACTIVITY').body.join(''))).toContain(squash('in-flight3'))
      world.files.set(TRACKER, tracker(...fresh(7)))
      await advance(30_000)
      expect(squash(cardOf(await paneView($, columns), 'ACTIVITY').body.join(''))).toContain(squash('in-flight7over6'))
    })
  }

  test('unset, empty, zero or junk threshold: no warning, the count is plain', async ($, on) => {
    const { world, advance } = await boot($, on, w => {
      w.now = T0
      w.files.set(TRACKER, tracker(...fresh(9)))
    })
    for (const raw of [undefined, '', '0', '-2', 'x']) {
      if (raw === undefined) delete world.env[WARN_ENV]
      else world.env[WARN_ENV] = raw
      await advance(30_000)
      const body = squash(cardOf(await paneView($, 89), 'ACTIVITY').body.join(''))
      expect(body).toContain(squash('in-flight9'))
      expect(body).not.toContain(squash('over'))
    }
  })

  test('a threshold the engine refuses to read is no warning, and the row still draws', async ($, on) => {
    await boot($, on, w => {
      w.now = T0
      w.denyEnv.add(WARN_ENV)
      w.files.set(TRACKER, tracker(...fresh(9)))
    })
    expect(squash(cardOf(await paneView($, 89), 'ACTIVITY').body.join(''))).toContain(squash('in-flight9'))
  })

  test('a missing tracker with the hook wired reads n/a（agents file missing） and does not read 0', async ($, on) => {
    await boot($, on, w => {
      w.now = T0
      w.files.delete(TRACKER)
    })
    expect(squash(cardOf(await paneView($, 89), 'ACTIVITY').body.join(''))).toContain(squash('in-flight n/a（agents file missing）'))
    expect((await paneText($, 89)).join('\n')).toMatch(/1 error\b/)
  })

  test('a corrupt tracker reads n/a and counts one error; a missing hook does not count twice', async ($, on) => {
    const { world, advance } = await boot($, on, w => {
      w.now = T0
      w.files.set(TRACKER, '{bad')
    })
    const parts = await paneView($, 89)
    expect(squash(cardOf(parts, 'ACTIVITY').body.join(''))).toContain(squash('in-flight n/a（agents file unreadable）'))
    expect((await paneText($, 89)).join('\n')).toMatch(/1 error\b/)

    unwire(world, 'subagent-tracker.js')
    await advance(30_000)
    const unwired = await paneView($, 89)
    expect(squash(cardOf(unwired, 'ACTIVITY').body.join(''))).toContain(squash('in-flight n/a（subagent-tracker.js hook not configured）'))
    expect(squash(cardOf(unwired, 'ACTIVITY').body.join(''))).toContain(squash('agents n/a'))
    expect((await paneText($, 89)).join('\n')).toMatch(/1 error\b/)
  })
})
