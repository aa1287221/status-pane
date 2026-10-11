import { describe, expect, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code/testing'

import { boot, cardOf, makeSnap, makeWorld } from './fixture'
import type { World } from './fixture'
import { COMPACT_TEXT, adviceOf, canonModel, compactConfig, effectiveWindow, envWindow, fillOf, settingsWindow, shouldSuggest } from './compact'
import type { WindowSource } from './compact'
import { OBSERVED } from './compact.observed'
import type { Observed } from './compact.observed'
import type { CompactState, Snap } from './state'
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
const setup = async ($: Engine, on: On, opts: { env?: Record<string, string>; isShown?: boolean; throws?: boolean; seed?: CompactState; rows?: string; edit?: (w: World) => void } = {}) => {
  SENT.length = 0
  on('session.measure', (_c, e) => ({ changed: e.changed }) as never)
  on('prompt.suggest', (_c, e) => {
    SENT.push(e as { text: string })
    if (opts.throws) throw new Error('box refused')
    return { isShown: opts.isShown ?? true } as never
  })
  const io = await boot($, on, w => {
    Object.assign(w.env, opts.env ?? {})
    // readOnce is what the fixture's state.get handler answers; stateValues is only a record of writes
    if (opts.seed) w.readOnce.set('compact', opts.seed)
    if (opts.rows) w.files.set(ROWS_FILE, opts.rows)
    opts.edit?.(w)
  })
  // the box answers after the hook returns; settle lets that answer land before the test reads the state
  const measure = async (tokens: number, changed = ['context'], window = 1_000_000) => {
    const r = await ($.session as unknown as { measure: (i: unknown) => Promise<unknown> }).measure({ context: { tokens, window, percent: 0 }, rateLimits: [], changed })
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

  // E6: the usage row is the CONTEXT card's switch; with it off there is no card to hint on
  test('usage row off: no state write, no suggest', async ($, on) => {
    const { world, measure } = await setup($, on, { env: { STATUS_PANE_CTX_SUGGEST: '1' }, rows: '{"usage":false}' })
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
    const { world, measure } = await setup($, on, { env: { STATUS_PANE_CTX_SUGGEST: '1' }, seed: state({ sid: 'OTHER', armed: false }) })
    await measure(650_000)
    // the seed was read by the hook, not left waiting for a read that never came
    expect(world.readOnce.has('compact')).toBe(false)
    expect(SENT.length).toBe(1)
    expect(stateOf(world)?.sid).toBe(T_SID)
  })
})

// ---- the window the line is taken of: what the engine compacts at, not the model's whole window ----

const OPUS = 'claude-opus-5-5'
const pm = (key: string, v: unknown) => ({ modelSettings: { [key]: { autoCompactWindow: v } } })
/** The sources as the resolver takes them: highest precedence first, policy down to user. */
const ranked = (r: { user?: unknown; project?: unknown; local?: unknown; flag?: unknown; policy?: unknown }): unknown[] => [r.policy ?? {}, r.flag ?? {}, r.local ?? {}, r.project ?? {}, r.user ?? {}]
const labelOf = (engine: string): WindowSource => (engine === 'env' || engine === 'settings' ? engine : 'window')
const ask = (r: Observed) => effectiveWindow({ window: r.window, model: r.model, env: r.env, sources: ranked(r) })

describe('compact window: the engine\'s own answers (Claude Code 2.1.296)', () => {
  // W1: a table whose rows all leave the window alone would pass a resolver that does nothing
  test('the table has teeth: most rows shrink the window and the engine named every source', () => {
    expect(OBSERVED.length).toBeGreaterThanOrEqual(90)
    expect(OBSERVED.filter(r => !r.gap && r.want < r.window).length).toBeGreaterThanOrEqual(50)
    expect([...new Set(OBSERVED.map(r => r.engine))].sort()).toEqual(['auto', 'env', 'model-default', 'settings', 'unknown-model'])
  })

  // W2: every probe run, one test each; the known gaps pin what the plugin answers instead
  for (const r of OBSERVED) {
    test(r.gap ? `${r.id} (known gap)` : r.id, () => {
      const got = ask(r)
      if (r.gap) expect(got).toEqual({ window: r.mine!, source: r.mine! < r.window ? 'settings' : 'window' })
      else expect(got).toEqual({ window: r.want, source: labelOf(r.engine) })
    })
  }
})

describe('compact window: the environment variable', () => {
  // W3: the engine's own number parser, then the bounds; a value it cannot read is skipped, never 0
  test('read as the engine reads it: leading integer, exponent, thousands marks, floor 100000, cap 1000000', () => {
    // observed on 2.1.296 except the three marked inferred (read from the source, not run)
    const cases: [string | undefined, number | null][] = [
      [undefined, null], ['', null], ['250000', 250_000], [' 300000', 300_000], ['300000 ', 300_000], ['+300000', 300_000],
      ['50000', 100_000], ['400k', 100_000], ['2000000', 1_000_000], ['999999999999999999', 1_000_000],
      ['400000abc', 400_000], ['300000.9', 300_000], ['4e5', 400_000], ['1e6', 1_000_000], ['300_000', 300_000],
      ['abc', null], ['0', null], ['-300000', null], ['0x30d40', null],
      ['300,000', 300_000], // inferred
      [' 300000 ', 300_000], // inferred
      ['1e400', null], // inferred
    ]
    for (const [raw, want] of cases) expect([raw, envWindow(raw)]).toEqual([raw, want])
  })
})

describe('compact window: the model\'s name', () => {
  // W4: the settings key is the whole canonical name, whatever way the session spells it
  test('dated, [1m], Vertex, Bedrock, upper case and spaces name one model; a prefix is another', () => {
    const spellings = ['claude-opus-5-5', 'Claude-Opus-5-5', ' claude-opus-5-5 ', 'claude-opus-5-5[1m]', ' Claude-Opus-5-5[1M] ', 'claude-opus-5-5-20260101', 'claude-opus-5-5@20260101', 'us.anthropic.claude-opus-5-5-20260101-v1:0']
    for (const s of spellings) expect([s, canonModel(s)]).toEqual([s, OPUS])
    expect(canonModel('claude-opus-5')).toBe('claude-opus-5')
    expect(canonModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
  })
})

describe('compact window: the settings', () => {
  // W5: the rules of the engine's merge, one named test each
  test('within one file the entry for the model beats the top-level value', () => {
    expect(settingsWindow([{ autoCompactWindow: 300_000, ...pm(OPUS, 400_000) }], OPUS)).toBe(400_000)
  })

  test('the entry beats the top-level value whatever way its key is spelled', () => {
    for (const key of ['Claude-Opus-5-5', 'claude-opus-5-5[1m]']) expect([key, settingsWindow([{ autoCompactWindow: 300_000, ...pm(key, 400_000) }], OPUS)]).toEqual([key, 400_000])
  })

  test('a higher source\'s top-level value replaces a lower source\'s entry for the model', () => {
    expect(settingsWindow([{ autoCompactWindow: 300_000 }, pm(OPUS, 400_000)], OPUS)).toBe(300_000)
  })

  test('a higher source\'s entry beats a lower source\'s top-level value, and another model\'s entry is no entry', () => {
    expect(settingsWindow([pm(OPUS, 400_000), { autoCompactWindow: 300_000 }], OPUS)).toBe(400_000)
    expect(settingsWindow([pm('claude-opus-5', 350_000), pm(OPUS, 400_000)], OPUS)).toBe(400_000)
    expect(settingsWindow([pm('claude-opus-5', 350_000)], OPUS)).toBeNull()
  })

  test('"auto" for the model is the engine\'s own window: it neither falls through to a lower source nor to the top-level value', () => {
    expect(settingsWindow([pm(OPUS, 'auto'), pm(OPUS, 400_000)], OPUS)).toBe('auto')
    expect(settingsWindow([{ autoCompactWindow: 300_000, ...pm(OPUS, 'auto') }], OPUS)).toBe('auto')
  })

  test('only integers from 100000 to 1000000 count; "auto" counts for a model and nowhere else; a bad value is as if absent', () => {
    const top = (v: unknown) => settingsWindow([{ autoCompactWindow: v }], OPUS)
    expect([99_999, 1_000_001, 400_000.5, '400000', 'auto', null, true, [400_000], { n: 1 }].map(top)).toEqual(Array(9).fill(null))
    expect([100_000, 1_000_000].map(top)).toEqual([100_000, 1_000_000])
    const one = (v: unknown) => settingsWindow([pm(OPUS, v)], OPUS)
    expect([99_999, 1_000_001, 400_000.5, '400000', 'x', null].map(one)).toEqual(Array(6).fill(null))
    // an absent value does not reset what is below it
    expect(settingsWindow([{ autoCompactWindow: 50_000 }, pm(OPUS, 400_000)], OPUS)).toBe(400_000)
  })

  test('two spellings of the model in one file: the canonical key wins, else the first', () => {
    expect(settingsWindow([{ modelSettings: { 'claude-opus-5-5[1m]': { autoCompactWindow: 300_000 }, [OPUS]: { autoCompactWindow: 400_000 } } }], OPUS)).toBe(400_000)
    expect(settingsWindow([{ modelSettings: { 'claude-opus-5-5[1m]': { autoCompactWindow: 300_000 }, 'Claude-Opus-5-5': { autoCompactWindow: 400_000 } } }], OPUS)).toBe(300_000)
  })

  test('policy outranks flag, local, project and user, in that order', () => {
    const win = (v: number) => ({ autoCompactWindow: v })
    expect(settingsWindow([win(1e5), win(2e5), win(3e5), win(4e5), win(5e5)], OPUS)).toBe(1e5)
    expect(settingsWindow([{}, win(2e5), win(3e5), win(4e5), win(5e5)], OPUS)).toBe(2e5)
    expect(settingsWindow([{}, {}, win(3e5), win(4e5), win(5e5)], OPUS)).toBe(3e5)
    expect(settingsWindow([{}, {}, {}, win(4e5), win(5e5)], OPUS)).toBe(4e5)
    expect(settingsWindow([{}, {}, {}, {}, win(5e5)], OPUS)).toBe(5e5)
  })

  test('junk is skipped without a throw: sources that are not objects, modelSettings that is not, entries that are not', () => {
    const junk: unknown[] = [null, undefined, 7, 'x', [1], { modelSettings: [1, 2] }, { modelSettings: { [OPUS]: 400_000 } }, { modelSettings: { [OPUS]: null } }, { modelSettings: null }]
    expect(settingsWindow(junk, OPUS)).toBeNull()
    expect(settingsWindow([...junk, pm(OPUS, 400_000)], OPUS)).toBe(400_000)
    expect(settingsWindow([pm(OPUS, 400_000)], undefined)).toBeNull()
    expect(settingsWindow([{ autoCompactWindow: 300_000 }], undefined)).toBe(300_000)
    // a model with no name is not an entry with no name
    for (const model of ['', '  ']) expect(settingsWindow([pm('', 400_000), pm(' ', 350_000)], model)).toBeNull()
  })
})

describe('compact window: the answer', () => {
  const sources = [{}, {}, {}, {}, { autoCompactWindow: 400_000 }]

  // W6: unknown stays unknown
  test('no window is no answer, never 0 or NaN', () => {
    for (const window of [undefined, 0, -1, Number.NaN, Infinity]) expect(effectiveWindow({ window, model: OPUS, env: '250000', sources })).toBeNull()
  })

  // W7: the engine's min(window, configured)
  test('never wider than the model\'s window', () => {
    expect(effectiveWindow({ window: 200_000, model: OPUS, env: undefined, sources })).toEqual({ window: 200_000, source: 'settings' })
    expect(effectiveWindow({ window: 200_000, model: OPUS, env: '900000', sources: [] })).toEqual({ window: 200_000, source: 'env' })
  })

  // W8: the environment is read before the settings, whichever way the settings point
  test('the environment variable beats every source of settings', () => {
    expect(effectiveWindow({ window: 1_000_000, model: OPUS, env: '250000', sources: [pm(OPUS, 150_000), ...sources] })).toEqual({ window: 250_000, source: 'env' })
    expect(effectiveWindow({ window: 1_000_000, model: OPUS, env: 'abc', sources })).toEqual({ window: 400_000, source: 'settings' })
  })

  // W9: settings count only while auto-compact is on; the environment variable counts either way
  test('autoCompactEnabled false in the deciding source puts the settings aside; the highest source that names it decides', () => {
    const off = { autoCompactEnabled: false }
    expect(effectiveWindow({ window: 1_000_000, model: OPUS, env: undefined, sources: [{}, {}, {}, off, { autoCompactWindow: 300_000 }] })).toEqual({ window: 1_000_000, source: 'window' })
    expect(effectiveWindow({ window: 1_000_000, model: OPUS, env: '250000', sources: [{}, {}, {}, off, { autoCompactWindow: 300_000 }] })).toEqual({ window: 250_000, source: 'env' })
    expect(effectiveWindow({ window: 1_000_000, model: OPUS, env: undefined, sources: [{}, {}, {}, { autoCompactEnabled: true }, { ...off, autoCompactWindow: 300_000 }] })).toEqual({ window: 300_000, source: 'settings' })
  })

  test('nothing set is the model\'s window', () => {
    expect(effectiveWindow({ window: 1_000_000, model: OPUS, env: undefined, sources: [] })).toEqual({ window: 1_000_000, source: 'window' })
    expect(effectiveWindow({ window: 1_000_000, model: undefined, env: undefined, sources: [pm(OPUS, 400_000)] })).toEqual({ window: 1_000_000, source: 'window' })
  })
})

// ---- the card: the line is a share of that window ----

const atWin = (used: number, autoCompact?: { window: number; source: WindowSource }, max = 1_000_000) =>
  makeSnap({ context: { ok: true, v: { pct: Math.round((used / max) * 100), used, max, compacts: { ok: true, v: 1 }, ...(autoCompact ? { autoCompact } : {}) } } })
const bodyWin = (columns: number, used: number, autoCompact?: { window: number; source: WindowSource }): string => {
  const view: PaneView = { columns, nowMs: 0, tzMin: 0, raster: true, cpuHist: [], compact: null }
  const tree = layoutTree(paneLayout(atWin(used, autoCompact), view), FAKE_ELS) as unknown as Node
  return cardOf(paneParts(tree, columns), 'CONTEXT').body.join(' ')
}
const W400K = { window: 400_000, source: 'settings' as const }

describe('the CONTEXT card: the compaction window', () => {
  // W10: 240,000 of a 400K window is the line, though it is 24% of the model's 1M
  for (const columns of [36, 49, 89]) {
    test(`bodyColumns ${columns}: 239,999 of a 400K window is under the line, 240,000 is at it, and the figure says which window`, () => {
      expect(bodyWin(columns, 239_999, W400K)).not.toContain('已達')
      expect(bodyWin(columns, 240_000, W400K)).toContain('已達 60%')
      // used reads 250.0K here, so a 240.0K that shows is the line's own
      expect(bodyWin(columns, 250_000, W400K)).toMatch(/已達 60% \(240\.0K\)/)
    })
  }

  // W11: with no window of its own the card reads as it did
  test('no override, or a snapshot without the field: the line is 60% of the model\'s window and carries no figure', () => {
    for (const ac of [undefined, { window: 1_000_000, source: 'window' as const }]) {
      expect(bodyWin(89, 599_999, ac)).not.toContain('已達')
      const at = bodyWin(89, 600_000, ac)
      expect(at).toContain('已達 60%')
      expect(at).not.toMatch(/\d\.\dK\)|\(/)
    }
  })
})

// ---- the engine: the window comes from the settings and the environment through the fake machine ----

const snapOf = (w: World): Snap | undefined => w.stateValues.get('snap') as Snap | undefined
const autoCompactOf = (w: World) => {
  const c = snapOf(w)?.context
  return c?.ok ? c.v.autoCompact : undefined
}

describe('engine: the compaction window', () => {
  const SUGGEST = { STATUS_PANE_CTX_SUGGEST: '1' }
  const user400k = (w: World) => {
    w.settingsBySource.user = pm(OPUS, 400_000)
  }

  // W12: the snapshot, as refresh reads the settings, the environment and the session's model
  test('the snapshot holds the window the settings name for the session\'s model', async ($, on) => {
    const { world } = await setup($, on, { edit: user400k })
    expect(autoCompactOf(world)).toEqual({ window: 400_000, source: 'settings' })
  })

  test('the environment variable is read before the settings', async ($, on) => {
    const { world } = await setup($, on, { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' }, edit: user400k })
    expect(autoCompactOf(world)).toEqual({ window: 250_000, source: 'env' })
  })

  test('nothing set is the model\'s window', async ($, on) => {
    const plain = await setup($, on)
    expect(autoCompactOf(plain.world)).toEqual({ window: 1_000_000, source: 'window' })
  })

  test('settings refused: the model\'s window, or the variable when it is set', async ($, on) => {
    const { world } = await setup($, on, { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' }, edit: w => { w.denySettings = true } })
    expect(autoCompactOf(world)).toEqual({ window: 250_000, source: 'env' })
  })

  test('the sources are ranked: a project\'s top-level 300K replaces the user\'s entry of 400K', async ($, on) => {
    const { world } = await setup($, on, { edit: w => {
      user400k(w)
      w.settingsBySource.project = { autoCompactWindow: 300_000 }
    } })
    expect(autoCompactOf(world)).toEqual({ window: 300_000, source: 'settings' })
  })

  // W13: the discriminating pair: 250K is 62.5% of 400K and 25% of 1M
  test('a 400K compaction window: 250K tokens sends the suggestion', async ($, on) => {
    const { measure } = await setup($, on, { env: SUGGEST, edit: user400k })
    await measure(250_000)
    expect(SENT.map(s => s.text)).toEqual([COMPACT_TEXT])
  })

  test('control: the same 250K with no setting is 25% and sends nothing', async ($, on) => {
    const { measure } = await setup($, on, { env: SUGGEST })
    await measure(250_000)
    expect(SENT.length).toBe(0)
  })

  test('the line is 240,000 of 400,000: one token under sends nothing, the line itself sends', async ($, on) => {
    const { measure } = await setup($, on, { env: SUGGEST, edit: user400k })
    await measure(239_999)
    expect(SENT.length).toBe(0)
    await measure(240_000)
    expect(SENT.length).toBe(1)
  })

  test('the sources are ranked at the measure too: 180,000 is the line of the project\'s 300K, not of the user\'s 400K', async ($, on) => {
    const { measure } = await setup($, on, { env: SUGGEST, edit: w => {
      user400k(w)
      w.settingsBySource.project = { autoCompactWindow: 300_000 }
    } })
    await measure(179_999)
    expect(SENT.length).toBe(0)
    await measure(180_000)
    expect(SENT.length).toBe(1)
  })

  test('observe mode records what it would send at the same line', async ($, on) => {
    const { world, measure } = await setup($, on, { edit: user400k })
    await measure(239_999)
    expect(stateOf(world)?.last).toBeNull()
    await measure(240_000)
    expect(stateOf(world)?.last?.would).toBe(COMPACT_TEXT)
  })

  test('the environment variable moves the line: 150,000 of 250,000, and the setting below it is not read', async ($, on) => {
    const { measure } = await setup($, on, { env: { ...SUGGEST, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' }, edit: user400k })
    await measure(149_999)
    expect(SENT.length).toBe(0)
    await measure(150_000)
    expect(SENT.length).toBe(1)
  })

  test('a window the measure reports below the setting is the window: 130K of 200K sends', async ($, on) => {
    const { measure } = await setup($, on, { env: SUGGEST, edit: user400k })
    await measure(130_000, ['context'], 200_000)
    expect(SENT.length).toBe(1)
  })

  // W14: fail-open to the model's window when an input cannot be had
  test('settings refused: the line falls back to 60% of the model\'s window', async ($, on) => {
    const { measure } = await setup($, on, { env: SUGGEST, edit: w => { w.denySettings = true } })
    await measure(250_000)
    expect(SENT.length).toBe(0)
    await measure(600_000)
    expect(SENT.length).toBe(1)
  })

  test('the variable refused: the settings decide', async ($, on) => {
    const { measure } = await setup($, on, {
      env: { ...SUGGEST, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' },
      edit: w => {
        user400k(w)
        w.denyEnv.add('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
      },
    })
    // 200K is 80% of the variable's 250K but 50% of the setting's 400K
    await measure(200_000)
    expect(SENT.length).toBe(0)
    await measure(250_000)
    expect(SENT.length).toBe(1)
  })

  test('the session\'s model decides: another model\'s entry is not taken', async ($, on) => {
    const { measure } = await setup($, on, { env: SUGGEST, edit: w => {
      user400k(w)
      w.session.model = 'claude-opus-5'
    } })
    await measure(250_000)
    expect(SENT.length).toBe(0)
  })
})
