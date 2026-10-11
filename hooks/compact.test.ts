import { describe, expect, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code/testing'

import { boot, cardOf, makeSnap, makeWorld } from './fixture'
import { COMPACT_TEXT, adviceOf, compactConfig, fillOf, shouldSuggest } from './compact'
import type { CompactState } from './state'
import { layoutTree, paneLayout } from './pane'
import type { PaneView } from './pane'
import { FAKE_ELS, findOverflow, paneParts } from './tree'
import type { Node } from './tree'
import { pctColor } from './model'

// S1 for the CONTEXT hint and the /compact suggestion: pure rows first, then the card, then the engine.
const T_SID = 'c07353bf22c447df82966f2d'
const ROWS_FILE = '/root/.claude/cc-statusline-rows.json'
const ctx = (tokens: number | undefined, window: number | undefined, percent?: number) => ({ tokens, window, percent })
const DEFAULT = compactConfig(undefined, undefined)
const state = (over: Partial<CompactState> = {}): CompactState => ({ sid: T_SID, mode: 'observe', atPct: 60, armed: true, last: null, ...over })

describe('compact: the fill ratio', () => {
  // R1: the threshold reads tokens/window, never the engine's integer percent
  test('tokens over window; percent is ignored whichever way it disagrees', () => {
    expect(fillOf(ctx(600_000, 1_000_000, 0))).toBe(0.6)
    expect(fillOf(ctx(599_999, 1_000_000, 100))).toBe(0.599999)
  })

  // R2: unknown is not zero
  test('no tokens, zero or negative, or a missing or bad window: null, never 0 or NaN', () => {
    const bad = [ctx(undefined, 1e6), ctx(0, 1e6), ctx(-5, 1e6), ctx(Number.NaN, 1e6), ctx(5, undefined), ctx(5, 0), ctx(5, -1), ctx(5, Infinity), ctx(Infinity, 1e6)]
    for (const c of bad) expect(fillOf(c)).toBeNull()
  })
})

describe('compact: configuration', () => {
  // R4: env parse; invalid and out of range fall back to the default, never throw
  test('threshold accepts whole numbers 1..99 only; anything else is the default 60', () => {
    const at = (v: string | undefined) => compactConfig(v, undefined).atPct
    expect(['', 'abc', '0', '100', '-5', '60.5', '1e1', '  70 ', '1e2'].map(at)).toEqual([60, 60, 60, 60, 60, 60, 60, 60, 60])
    expect(['70', '1', '99'].map(at)).toEqual([70, 1, 99])
    expect(at(undefined)).toBe(60)
  })

  test('only "1" switches to suggest and only "0" bypasses; everything else observes', () => {
    const mode = (v: string | undefined) => compactConfig(undefined, v).mode
    expect(mode(undefined)).toBe('observe')
    expect(['x', '2', ''].map(mode)).toEqual(['observe', 'observe', 'observe'])
    expect(mode('1')).toBe('suggest')
    expect(mode('0')).toBe('off')
  })
})

describe('compact: the advice', () => {
  // R3: inclusive threshold, the gauge's colour boundaries
  test('0.5999 is no advice; 0.6 is; the colour follows pctColor (red from 80)', () => {
    expect(adviceOf(0.5999, DEFAULT)).toBeNull()
    expect(adviceOf(0.6, DEFAULT)).toMatchObject({ pct: 60, atPct: 60 })
    expect(pctColor(adviceOf(0.801, DEFAULT)!.pct)).toBe('red')
    expect(pctColor(adviceOf(0.7, DEFAULT)!.pct)).toBe('yellow')
  })

  test('null fill, null config are never advice', () => {
    expect(adviceOf(null, DEFAULT)).toBeNull()
  })

  // R6: the fixed text
  test('the suggestion is one static line starting with /compact, short, and free of session data', () => {
    expect(COMPACT_TEXT.startsWith('/compact ')).toBe(true)
    expect(COMPACT_TEXT).not.toMatch(/[\r\n\u0000-\u001f]/)
    expect(COMPACT_TEXT.length).toBeLessThanOrEqual(120)
  })
})

describe('compact: once per crossing', () => {
  // R5: the sequence from the plan; a drop below the threshold re-arms, a new session starts over
  test('fires at 0.60 and again at 0.62 only, never inside a crossing', () => {
    let s: CompactState | null = null
    const fires: number[] = []
    for (const f of [0.55, 0.6, 0.63, 0.7, 0.61, 0.55, 0.62]) {
      const d = shouldSuggest(s, T_SID, f, DEFAULT)
      if (d.fire) fires.push(f)
      s = d.next
    }
    expect(fires).toEqual([0.6, 0.62])
  })

  test('another session id resets the memory; an armed flag of another session never suppresses', () => {
    const other = state({ sid: 'OTHER', armed: false })
    expect(shouldSuggest(other, T_SID, 0.7, DEFAULT).fire).toBe(true)
  })

  test('unknown fill changes nothing and fires nothing', () => {
    const s = state({ armed: false })
    expect(shouldSuggest(s, T_SID, null, DEFAULT)).toEqual({ fire: false, next: s })
  })

  test('mode off never fires', () => {
    expect(shouldSuggest(null, T_SID, 0.9, compactConfig(undefined, '0')).fire).toBe(false)
  })
})

// ---- the card ----

const at = (used: number, max = 1_000_000) => makeSnap({ context: { ok: true, v: { pct: Math.round((used / max) * 100), used, max, compacts: { ok: true, v: 1 } } } })
const cardAt = (columns: number, used: number, compact: CompactState | null) => {
  const view: PaneView = { columns, nowMs: 0, tzMin: 0, raster: true, cpuHist: [], compact }
  const tree = layoutTree(paneLayout(at(used), view), FAKE_ELS) as unknown as Node
  return { card: cardOf(paneParts(tree, columns), 'CONTEXT'), tree }
}

describe('the CONTEXT card: hint', () => {
  // R8: at or over the threshold the hint is drawn, under the used row, at each breakpoint
  for (const columns of [36, 49, 89]) {
    test(`bodyColumns ${columns}: the threshold figure and /compact are drawn at or over the line, not under it`, () => {
      expect(cardAt(columns, 500_000, null).card.body.join('\n')).not.toContain('/compact')
      const body = cardAt(columns, 600_000, null).card.body.join('\n')
      expect(body).toContain('60%')
      expect(body).toContain('/compact')
    })
  }

  // R9: the mode line comes from the state, and only when there is a state
  test('the mode line says observe, on · shown, on · not shown, on · pending or off; no line without a state', () => {
    const line = (c: CompactState | null) => cardAt(89, 650_000, c).card.body.join('\n')
    expect(line(null)).not.toContain('suggest')
    expect(line(state({ mode: 'observe' }))).toContain('observe')
    expect(line(state({ mode: 'suggest', last: { at: 1, isShown: true } }))).toContain('on · shown')
    expect(line(state({ mode: 'suggest', last: { at: 1, isShown: false } }))).toContain('on · not shown')
    expect(line(state({ mode: 'suggest', last: null }))).toContain('on · pending')
    expect(line(state({ mode: 'off' }))).toContain('off')
  })

  // R10: fit at every width; the hint wraps and never cuts a number
  test('no overflow from 20 to 120 columns, at a 200K and a 1M window', () => {
    // from 22: below that the pane's own MIN_W clamp is wider than the room, which is not the hint's doing
  for (let columns = 22; columns <= 120; columns++) {
      const view: PaneView = { columns, nowMs: 0, tzMin: 0, raster: true, cpuHist: [], compact: state({ mode: 'suggest', last: { at: 1, isShown: false, why: 'ラベル 長い理由 with words that wrap across lines' } }) }
      for (const [used, max] of [[190_000, 200_000], [900_000, 1_000_000]] as const) {
        const tree = layoutTree(paneLayout(makeSnap({ context: { ok: true, v: { pct: 90, used, max, compacts: { ok: true, v: 3 } } } }), view), FAKE_ELS) as unknown as Node
        expect(findOverflow(tree, columns)).toEqual([])
      }
    }
  })
})

// ---- the engine: the hook, the state and the suggestion through the fake machine ----

const SENT: { text: string }[] = []

/** Registers the bottom of the chain (what the engine answers) before boot; `isShown` is what the box reports. */
const setup = async ($: Engine, on: On, opts: { env?: Record<string, string>; isShown?: boolean; throws?: boolean; seed?: CompactState; rows?: string } = {}) => {
  SENT.length = 0
  on('session.measure', (_c, e) => ({ changed: e.changed }) as never)
  on('prompt.suggest', (_c, e) => {
    SENT.push(e as { text: string })
    if (opts.throws) throw new Error('box refused')
    return { isShown: opts.isShown ?? true } as never
  })
  const io = await boot($, on, w => {
    Object.assign(w.env, opts.env ?? {})
    if (opts.seed) w.stateValues.set('compact', opts.seed)
    if (opts.rows) w.files.set(ROWS_FILE, opts.rows)
  })
  // the box answers after the hook returns; settle lets that answer land before the test reads the state
  const measure = async (tokens: number, changed = ['context']) => {
    const r = await ($.session as unknown as { measure: (i: unknown) => Promise<unknown> }).measure({ context: { tokens, window: 1_000_000, percent: 0 }, rateLimits: [], changed })
    await io.clock.settle()
    return r
  }
  return { ...io, measure }
}
const stateOf = (w: { stateValues: Map<string, unknown> }) => w.stateValues.get('compact') as CompactState | null | undefined

describe('engine: the measure hook', () => {
  // E1: observe is the default; it computes and shows, and calls nothing
  test('default observe: no suggest call, the state holds what it would send', async ($, on) => {
    const { world, measure } = await setup($, on)
    await measure(650_000)
    expect(SENT.length).toBe(0)
    expect(stateOf(world)?.mode).toBe('observe')
    expect(stateOf(world)?.last?.would).toBe(COMPACT_TEXT)
  })

  // E2: suggest mode sends once per crossing
  test('suggest mode: one call with the fixed text; a repeat is silent; a compact then a new crossing sends again', async ($, on) => {
    const { world, measure } = await setup($, on, { env: { STATUS_PANE_CTX_SUGGEST: '1' } })
    await measure(650_000)
    await measure(660_000)
    expect(SENT.map(s => s.text)).toEqual([COMPACT_TEXT])
    await measure(400_000)
    await measure(620_000)
    expect(SENT.length).toBe(2)
    expect(stateOf(world)?.last?.isShown).toBe(true)
  })

  // E3: isShown false leaves the crossing open, so the next measure tries again
  test('isShown false is recorded and the next measure retries', async ($, on) => {
    const { world, measure } = await setup($, on, { env: { STATUS_PANE_CTX_SUGGEST: '1' }, isShown: false })
    await measure(650_000)
    expect(stateOf(world)?.last?.isShown).toBe(false)
    await measure(650_000)
    expect(SENT.length).toBe(2)
  })

  // E4: a refusing box never throws out of the hook
  test('a refused suggest is recorded as why and the measure still resolves', async ($, on) => {
    const { world, measure } = await setup($, on, { env: { STATUS_PANE_CTX_SUGGEST: '1' }, throws: true })
    await expect(measure(650_000)).resolves.toBeDefined()
    // the engine words the refusal itself; the test only pins that a reason was recorded, not its wording
    expect(stateOf(world)?.last?.why).toContain('prompt.suggest')
  })

  // E5: silent on irrelevant input
  test('a measure that did not change context writes nothing', async ($, on) => {
    const { world, measure } = await setup($, on, { env: { STATUS_PANE_CTX_SUGGEST: '1' } })
    await measure(650_000, ['cost', 'rateLimits'])
    expect(world.stateSets).not.toContain('compact')
    expect(SENT.length).toBe(0)
  })

  // E6: the master switch off (the rows file) writes nothing and sends nothing
  test('master switch off: no state write, no suggest', async ($, on) => {
    const { world, measure } = await setup($, on, { env: { STATUS_PANE_CTX_SUGGEST: '1' }, rows: '{"enabled":false}' })
    await measure(650_000)
    expect(world.stateSets).not.toContain('compact')
    expect(SENT.length).toBe(0)
  })

  // E6: bypass and master switch
  test('STATUS_PANE_CTX_SUGGEST=0 sends nothing and the card still hints', async ($, on) => {
    const { world, measure } = await setup($, on, { env: { STATUS_PANE_CTX_SUGGEST: '0' } })
    await measure(650_000)
    expect(SENT.length).toBe(0)
    expect(stateOf(world)?.mode).toBe('off')
  })

  // E7: a burst folds into one live call
  test('three measures without waiting: at most one suggest call', async ($, on) => {
    const { measure } = await setup($, on, { env: { STATUS_PANE_CTX_SUGGEST: '1' } })
    await Promise.all([measure(650_000), measure(650_000), measure(650_000)])
    expect(SENT.length).toBe(1)
  })

  // E8: fail-open when a read or write is refused
  test('an env read refused, then a state write refused: the measure resolves, nothing is sent', async ($, on) => {
    const { world, measure } = await setup($, on, { env: { STATUS_PANE_CTX_SUGGEST: '1' } })
    world.denyEnv.add('STATUS_PANE_CTX_SUGGEST')
    await expect(measure(650_000)).resolves.toBeDefined()
    world.denyEnv.delete('STATUS_PANE_CTX_SUGGEST')
    world.denyState.add('compact')
    await expect(measure(650_000)).resolves.toBeDefined()
    expect(SENT.length).toBe(0)
  })

  // E9: a state of another session is treated as empty
  test('a compact state of another session is overwritten, and its armed flag does not suppress', async ($, on) => {
    const { measure } = await setup($, on, { env: { STATUS_PANE_CTX_SUGGEST: '1' }, seed: state({ sid: 'OTHER', armed: false }) })
    await measure(650_000)
    expect(SENT.length).toBe(1)
  })
})
