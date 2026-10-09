import { describe, expect, test } from 'claude-code/testing'

import { dw, fmtClock, mergeTail, staleness, tailText } from './model'
import { MOCKUP_AT, makeSnap } from './fixture'
import type { Res, Snap } from './state'

const bad = (why: string): Res<never> => ({ ok: false, why })

describe('display width', () => {
  test('ASCII and box glyphs are one cell, CJK and emoji two', () => {
    expect(dw('abc')).toBe(3)
    expect(dw('遷移')).toBe(4)
    expect(dw('📁')).toBe(2)
    expect(dw('▰▱✓✗│…≈→○△✘')).toBe(11)
    expect(dw('')).toBe(0)
  })
})

describe('clock and staleness', () => {
  test('fmtClock reads the instant in the given offset, with or without seconds', () => {
    expect(fmtClock(MOCKUP_AT, 0, true)).toBe('02:41:13')
    expect(fmtClock(MOCKUP_AT, 0, false)).toBe('02:41')
    expect(fmtClock(MOCKUP_AT, 480, true)).toBe('10:41:13')
    expect(fmtClock(MOCKUP_AT, -180, true)).toBe('23:41:13')
  })

  test('fmtClock without an offset reads the local clock', () => {
    const d = new Date(MOCKUP_AT)
    const pad = (n: number) => String(n).padStart(2, '0')
    expect(fmtClock(MOCKUP_AT, undefined, true)).toBe(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`)
    expect(fmtClock(MOCKUP_AT, undefined, false)).toBe(`${pad(d.getHours())}:${pad(d.getMinutes())}`)
  })

  test('staleness: fresh up to 90 s, stale above, dead above 300 s', () => {
    const at = MOCKUP_AT
    const level = (ageS: number) => staleness(at, at + ageS * 1000)
    expect([0, 90, 91, 120, 300, 301, 400].map(level)).toEqual([
      'fresh',
      'fresh',
      'stale',
      'stale',
      'stale',
      'dead',
      'dead',
    ])
  })
})

describe('#9 prompt tail', () => {
  test('context, both quotas, session cost and the refresh time', () => {
    expect(tailText(makeSnap(), MOCKUP_AT, 0)).toBe('ctx 3% · 5h 23% · 7d 61% · $3.20 · 02:41')
  })

  test('the time follows the offset it is given', () => {
    expect(tailText(makeSnap(), MOCKUP_AT, 480)).toBe('ctx 3% · 5h 23% · 7d 61% · $3.20 · 10:41')
  })

  test('segments without data are left out', () => {
    const noCtx = { ok: true as const, v: { pct: null, used: 0, max: 1, compacts: { ok: true as const, v: 0 } } }
    expect(tailText(makeSnap({ context: noCtx }), MOCKUP_AT, 0)).toBe('5h 23% · 7d 61% · $3.20 · 02:41')
    // a percentage with no tokens behind it, or tokens with no percentage, is as unknown in the tail as in the pane
    const noTokens = { ok: true as const, v: { pct: 3, used: 0, max: 1, compacts: { ok: true as const, v: 0 } } }
    expect(tailText(makeSnap({ context: noTokens }), MOCKUP_AT, 0)).toBe('5h 23% · 7d 61% · $3.20 · 02:41')
    const noPct = { ok: true as const, v: { pct: null, used: 5, max: 1, compacts: { ok: true as const, v: 0 } } }
    expect(tailText(makeSnap({ context: noPct }), MOCKUP_AT, 0)).toBe('5h 23% · 7d 61% · $3.20 · 02:41')
    // a window nobody has a reading of is left out, a window at 0% is told
    const unknown = { ok: true as const, v: { five: { pct: null, resetSec: null }, seven: { pct: 61, resetSec: 1 } } }
    expect(tailText(makeSnap({ quota: unknown }), MOCKUP_AT, 0)).toBe('ctx 3% · 7d 61% · $3.20 · 02:41')
    const both = { ok: true as const, v: { five: { pct: null, resetSec: null }, seven: { pct: null, resetSec: null } } }
    expect(tailText(makeSnap({ quota: both }), MOCKUP_AT, 0)).toBe('ctx 3% · $3.20 · 02:41')
    const idle = { ok: true as const, v: { five: { pct: 0, resetSec: null }, seven: { pct: 0, resetSec: null } } }
    expect(tailText(makeSnap({ quota: idle }), MOCKUP_AT, 0)).toBe('ctx 3% · 5h 0% · 7d 0% · $3.20 · 02:41')
    const failed = makeSnap({ context: bad('x'), quota: bad('x'), cost: bad('x') })
    expect(tailText(failed, MOCKUP_AT, 0)).toBe('02:41')
  })

  test('a row switched off in the rows file drops its segment', () => {
    const base = makeSnap()
    const snap = makeSnap({ toggles: { enabled: true, rows: { ...base.toggles.rows, quota: false, cost: false } } })
    expect(tailText(snap, MOCKUP_AT, 0)).toBe('ctx 3% · 02:41')
  })

  test('it never runs past 48 characters: whole segments from the end give way', () => {
    const wide = makeSnap({
      context: { ok: true, v: { pct: 100, used: 1, max: 1, compacts: { ok: true, v: 0 } } },
      quota: { ok: true, v: { five: { pct: 100, resetSec: 1 }, seven: { pct: 100, resetSec: 1 } } },
      cost: { ok: true, v: { all: 1, session: 123_456.78, durMin: 1 } },
    })
    const tail = tailText(wide, MOCKUP_AT, 0) ?? ''
    expect(tail).toBe('ctx 100% · 5h 100% · 7d 100% · $123456.78')
    expect(tail.length).toBeLessThanOrEqual(48)
  })

  test('past 90 s the time gives way to stale', () => {
    expect(tailText(makeSnap(), MOCKUP_AT + 90_000, 0)).toBe('ctx 3% · 5h 23% · 7d 61% · $3.20 · 02:41')
    expect(tailText(makeSnap(), MOCKUP_AT + 91_000, 0)).toBe('ctx 3% · 5h 23% · 7d 61% · $3.20 · stale')
  })

  test('nothing to draw before the first refresh, or with the rows file switched off', () => {
    expect(tailText(null, MOCKUP_AT, 0)).toBeNull()
    const base = makeSnap()
    expect(tailText(makeSnap({ toggles: { enabled: false, rows: base.toggles.rows } }), MOCKUP_AT, 0)).toBeNull()
  })

  test('a snapshot of an older shape leaves the tail out instead of throwing', () => {
    // state outlives a hot reload, so the first draw after an edit may see the old shape
    expect(tailText({} as Snap, MOCKUP_AT, 0)).toBeNull()
  })

  test('an upstream tail is kept and ours follows it', () => {
    expect(mergeTail('esc to interrupt', 'ctx 3%')).toBe('esc to interrupt · ctx 3%')
    expect(mergeTail(undefined, 'ctx 3%')).toBe('ctx 3%')
    expect(mergeTail('', 'ctx 3%')).toBe('ctx 3%')
  })
})
