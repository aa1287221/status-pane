import { describe, expect, test } from 'claude-code/testing'

import { boot, cardOf, hintText, makeSnap, mountPane } from './fixture'
import { ROW_KEYS, parseTogglesStrict } from './model'
import { layoutTree, paneLayout } from './pane'
import { FAKE_ELS, paneParts, renderTree, findOverflow } from './tree'
import type { Node } from './tree'
import { HYGIENE_STALE_SEC, hygieneOf } from './hygiene'
import { KINDS, readSideFile } from './sidefile'
import type { SideIo, SideResult } from './sidefile'

// all times are fabricated; the side file lives at a path under /work/example, never /tmp/claude-side
const DIR = '/work/example/tmp/claude-side'
const NOW_MS = Date.parse('2026-10-15T01:00:00Z')
const NOW_SEC = NOW_MS / 1000
const REPO = '/work/example/repo'
const FIRST = 'NOT RECORDED: commit without a finding'

const stamp = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** An entry as the helper writes it; `ageSec` sets `at` relative to NOW. */
const entry = (over: Record<string, unknown> = {}, ageSec = 120) => ({
  event: 'commit',
  repo: REPO,
  first_line: FIRST,
  lines: [FIRST, '  a/tool.py: 12 lines changed'],
  at: stamp(NOW_SEC - ageSec),
  source: 'main',
  ...over,
})

/** A valid envelope around `data`; `over` replaces top-level members (a failed envelope sets error and data). */
const envelope = (data: unknown, observedSec = NOW_SEC - 120, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema_version: 1,
    kind: 'git-hygiene',
    producer: { id: 'git-hygiene', host: 'work-example' },
    station: null,
    run_id: null,
    observed_at: stamp(observedSec),
    last_success_at: stamp(observedSec),
    collection_status: 'ok',
    error: null,
    data,
    ...over,
  })

/** `data` with one entry, the entry's members overridden by `over`. */
const good = (over: Record<string, unknown> = {}) => ({ entries: [entry(over)] })

const ioOver = (files: Record<string, string>): SideIo => ({
  exists: async p => p in files,
  readBytes: async p => {
    const f = files[p]
    if (f === undefined) throw new Error('ENOENT')
    return new TextEncoder().encode(f)
  },
})

const readWith = (text: string | null, nowMs = NOW_MS): Promise<SideResult> => {
  const files: Record<string, string> = text === null ? {} : { [`${DIR}/git-hygiene.json`]: text }
  return readSideFile(ioOver(files), `${DIR}/git-hygiene.json`, nowMs)
}

const mapped = async (data: unknown, observedSec = NOW_SEC - 120) => hygieneOf(await readWith(envelope(data, observedSec)), NOW_SEC)

describe('git-hygiene: kind registration', () => {
  test('local, no TTL, no final TTL: the age is shown, staleness is the card threshold', () => {
    expect(KINDS['git-hygiene']).toEqual({ cls: 'local', ttlSec: null, finalTtlSec: null })
  })

  test('the card threshold is 30 minutes', () => {
    expect(HYGIENE_STALE_SEC).toBe(1800)
  })

  test('the row is on by default, and only a falsy value switches it off', () => {
    expect(ROW_KEYS).toContain('hygiene')
    expect(parseTogglesStrict('{}')!.rows.hygiene).toBe(true)
    expect(parseTogglesStrict('{"hygiene": 1}')!.rows.hygiene).toBe(true)
    expect(parseTogglesStrict('{"hygiene": false}')!.rows.hygiene).toBe(false)
    expect(parseTogglesStrict('{"hygiene": 0}')!.rows.hygiene).toBe(false)
  })
})

describe('git-hygiene: reader mapping (data rules v2, SCHEMA git-hygiene)', () => {
  test('a one-entry record maps every field, with the age from the entry stamp', async () => {
    const v = await mapped(good())
    expect(v).toEqual({
      ok: true,
      v: {
        entries: [{
          event: 'commit',
          repo: REPO,
          firstLine: FIRST,
          lines: [FIRST, '  a/tool.py: 12 lines changed'],
          atSec: NOW_SEC - 120,
          ageSec: 120,
          source: 'main',
        }],
      },
    })
  })

  test('a push record is accepted, and a subtask source is kept', async () => {
    const v = await mapped({ entries: [entry({ event: 'push', source: 'subtask' })] })
    expect(v.ok && v.v.entries[0]!.event).toBe('push')
    expect(v.ok && v.v.entries[0]!.source).toBe('subtask')
  })

  test('one to five entries are accepted, six is malformed', async () => {
    const at = (i: number) => entry({}, 120 + i)
    expect((await mapped({ entries: [at(0)] })).ok).toBe(true)
    expect((await mapped({ entries: [at(0), at(1), at(2), at(3), at(4)] })).ok).toBe(true)
    const six = await mapped({ entries: [at(0), at(1), at(2), at(3), at(4), at(5)] })
    expect(!six.ok && six.why).toMatch(/data\.entries/)
  })

  test('entries that is not an array, or empty, is malformed', async () => {
    for (const bad of ['NOT RECORDED', [], {}]) {
      const v = await mapped({ entries: bad })
      expect(!v.ok && v.why).toMatch(/data\.entries/)
    }
  })

  test('an entry that is not an object is malformed with its index named', async () => {
    const v = await mapped({ entries: [entry(), 'NOT RECORDED'] })
    expect(!v.ok && v.why).toMatch(/data\.entries\[1\]/)
  })

  test('an unknown event is malformed with the field named', async () => {
    const v = await mapped(good({ event: 'merge' }))
    expect(!v.ok && v.why).toMatch(/^n\/a（格式錯誤：data\.entries\[0\]\.event/)
  })

  test('an empty repo is malformed with the field named', async () => {
    const v = await mapped(good({ repo: '' }))
    expect(!v.ok && v.why).toMatch(/data\.entries\[0\]\.repo/)
  })

  test('a repo with a control character is malformed', async () => {
    const v = await mapped(good({ repo: `${REPO}\u0007` }))
    expect(!v.ok && v.why).toMatch(/data\.entries\[0\]\.repo/)
  })

  test('a first line of 201 code points is malformed, one of 200 is not', async () => {
    expect((await mapped(good({ first_line: 'x'.repeat(201) }))).ok).toBe(false)
    expect((await mapped(good({ first_line: 'x'.repeat(200) }))).ok).toBe(true)
  })

  test('a first line with a control character is malformed', async () => {
    const v = await mapped(good({ first_line: 'NOT\u0000RECORDED' }))
    expect(!v.ok && v.why).toMatch(/data\.entries\[0\]\.first_line/)
  })

  test('a first line with U+2028 or U+2029 is malformed as a control character', async () => {
    for (const sep of ['\u2028', '\u2029']) {
      const v = await mapped(good({ first_line: `NOT${sep}RECORDED` }))
      expect(!v.ok && v.why).toMatch(/data\.entries\[0\]\.first_line 含控制字元/)
    }
  })

  test('13 lines is malformed, 12 is not, and an empty lines array is malformed', async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`)
    expect((await mapped(good({ lines: lines(13) }))).ok).toBe(false)
    expect((await mapped(good({ lines: lines(12) }))).ok).toBe(true)
    const empty = await mapped(good({ lines: [] }))
    expect(!empty.ok && empty.why).toMatch(/data\.entries\[0\]\.lines/)
  })

  test('a line of 201 code points is malformed and the reason names its index, 200 is not', async () => {
    const v = await mapped(good({ lines: ['ok', 'x'.repeat(201)] }))
    expect(!v.ok && v.why).toMatch(/data\.entries\[0\]\.lines\[1\]/)
    expect((await mapped(good({ lines: ['ok', 'x'.repeat(200)] }))).ok).toBe(true)
  })

  test('lines that is not an array is malformed', async () => {
    const v = await mapped(good({ lines: 'NOT RECORDED' }))
    expect(!v.ok && v.why).toMatch(/data\.entries\[0\]\.lines/)
  })

  test('an at that is not a real UTC moment is malformed', async () => {
    const v = await mapped(good({ at: '2026-02-30T00:00:00Z' }))
    expect(!v.ok && v.why).toMatch(/data\.entries\[0\]\.at/)
    const w = await mapped(good({ at: '2026-10-15 00:00:00Z' }))
    expect(!w.ok && w.why).toMatch(/data\.entries\[0\]\.at/)
  })

  test('entries[0].at must equal observed_at', async () => {
    const v = await mapped(good(), NOW_SEC - 300)
    expect(!v.ok && v.why).toMatch(/data\.entries\[0\]\.at/)
  })

  test('a later entry must not be newer than the one before it', async () => {
    const newer = await mapped({ entries: [entry({}, 120), entry({}, 60)] })
    expect(!newer.ok && newer.why).toMatch(/data\.entries\[1\]\.at/)
    expect((await mapped({ entries: [entry({}, 120), entry({}, 120)] })).ok).toBe(true)
  })

  test('a source that is neither main nor subtask is malformed', async () => {
    const v = await mapped(good({ source: 'other' }))
    expect(!v.ok && v.why).toMatch(/data\.entries\[0\]\.source/)
  })

  test('the first violation decides: entry field order, then entry order', async () => {
    const v = await mapped(good({ event: 'merge', repo: '', source: 'x' }))
    expect(!v.ok && v.why).toMatch(/data\.entries\[0\]\.event/)
    const w = await mapped({ entries: [entry(), entry({ source: 'x' }), entry({ event: 'merge' })] })
    expect(!w.ok && w.why).toMatch(/data\.entries\[1\]\.source/)
  })

  test('unknown keys in data and in an entry are ignored', async () => {
    const v = await mapped({ entries: [entry({ extra: 1 })], note: 'x' })
    expect(v.ok).toBe(true)
  })

  test('a failed envelope is the reader text, never a record', async () => {
    const text = envelope(null, NOW_SEC - 120, { collection_status: 'failed', error: { code: 'git_timeout', message: 'git timed out' }, last_success_at: null })
    const r = hygieneOf(await readWith(text), NOW_SEC)
    expect(!r.ok && r.why).toMatch(/^n\/a（收集失敗：git timed out/)
  })

  test('no file is the reader missing verdict, which the card turns into its own text', async () => {
    const r = await readWith(null)
    expect(r.verdict).toBe('missing')
  })
})

describe('git-hygiene: card', () => {
  const widths = [36, 49, 89]
  const cardAt = (snap: ReturnType<typeof makeSnap>, columns: number) =>
    paneParts(layoutTree(paneLayout(snap, { columns, nowMs: NOW_MS, tzMin: 0, raster: true, cpuHist: [] }), FAKE_ELS) as unknown as Node, columns)
  const rec = (ageSec: number, over: Partial<{ source: 'main' | 'subtask'; firstLine: string; repo: string }> = {}) => ({
    event: 'commit',
    repo: REPO,
    firstLine: FIRST,
    lines: [FIRST],
    atSec: NOW_SEC - ageSec,
    ageSec,
    source: 'main' as const,
    ...over,
  })
  const ok = (...entries: ReturnType<typeof rec>[]) => ({ ok: true as const, v: { entries } })

  test('fresh: titled HYGIENE with the entry count, one row with the age, the repo tail and the first line', () => {
    for (const columns of widths) {
      const card = cardOf(cardAt(makeSnap({ hygiene: ok(rec(120)) }), columns), 'HYGIENE')
      expect(card.value).toBe('1 筆')
      expect(card.body.join('\n')).toContain('2m')
      expect(card.body.join('\n')).toContain('repo')
      expect(card.body.join('\n')).toContain('NOT RECORDED')
      expect(card.raw.join('\n')).not.toContain('舊')
    }
  })

  test('five entries are listed newest first, one row each', () => {
    const entries = [rec(60, { firstLine: 'NOT RECORDED: one' }), rec(600, { firstLine: 'PARTIAL STAGING: two' }), rec(900, { firstLine: 'WARN three' }), rec(1200, { firstLine: 'NOT ATTRIBUTABLE (four)' }), rec(1500, { firstLine: 'NOT RECORDED: five' })]
    const card = cardOf(cardAt(makeSnap({ hygiene: ok(...entries) }), 89), 'HYGIENE')
    expect(card.value).toBe('5 筆')
    const rows = card.body.map(l => l.replace(/\s+/g, ' '))
    const at = ['one', 'two', 'three', 'four', 'five'].map(w => rows.findIndex(r => r.includes(w)))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test('背景 marks only the subtask rows', () => {
    const card = cardOf(cardAt(makeSnap({ hygiene: ok(rec(60, { firstLine: 'WARN main-row' }), rec(120, { source: 'subtask', firstLine: 'WARN sub-row' })) }), 89), 'HYGIENE')
    const rows = card.body.map(l => l.replace(/\s+/g, ' '))
    expect(rows.find(r => r.includes('main-row'))).not.toContain('背景')
    expect(rows.find(r => r.includes('sub-row'))).toContain('背景')
  })

  test('舊 marks a row only past 30 minutes, and the row is still shown', () => {
    const card = cardOf(cardAt(makeSnap({ hygiene: ok(rec(HYGIENE_STALE_SEC, { firstLine: 'WARN edge-row' }), rec(31 * 60, { firstLine: 'WARN old-row' })) }), 89), 'HYGIENE')
    const rows = card.body.map(l => l.replace(/\s+/g, ' '))
    expect(rows.find(r => r.includes('edge-row'))).not.toContain('舊')
    const old = rows.find(r => r.includes('old-row'))
    expect(old).toContain('舊')
    expect(old).toContain('31m')
  })

  test('a row is cut to the card width with an ellipsis, never wrapped onto a second row', () => {
    const long = `WARN ${'x'.repeat(199)}`
    const snap = makeSnap({ hygiene: ok(rec(120, { firstLine: long }), rec(240, { firstLine: 'WARN short' })) })
    for (const columns of widths) {
      const card = cardOf(cardAt(snap, columns), 'HYGIENE')
      expect(card.body.join('\n')).toContain('…')
      expect(card.body.length).toBe(2)
    }
  })

  test('the last path segment of the repo is on the row, not the full path', () => {
    const card = cardOf(cardAt(makeSnap({ hygiene: ok(rec(120, { repo: '/work/example/other-repo' })) }), 89), 'HYGIENE')
    expect(card.body.join('\n')).toContain('other-repo')
    expect(card.body.join('\n')).not.toContain('/work/example')
  })

  test('missing: the card says there is no warning record yet', () => {
    const card = cardOf(cardAt(makeSnap({ hygiene: { ok: false, why: 'n/a（缺檔）' } }), 89), 'HYGIENE')
    expect(card.body.join('')).toContain('還沒有警告紀錄')
    expect(card.body.join('')).not.toContain('n/a')
  })

  test('malformed and failed: the reader text in full, the rest of the pane unchanged', () => {
    const card = cardOf(cardAt(makeSnap({ hygiene: { ok: false, why: 'n/a（格式錯誤：data.entries 不是陣列）' } }), 89), 'HYGIENE')
    expect(card.body.join('').replace(/\s/g, '')).toContain('n/a（格式錯誤：data.entries不是陣列）')
    expect(cardOf(cardAt(makeSnap({ hygiene: { ok: false, why: 'n/a（收集失敗：x）' } }), 89), 'SYSTEM').title).toBe('SYSTEM')
  })

  test('the tree fits its room at each width, with five rows', () => {
    const entries = [1, 2, 3, 4, 5].map(i => rec(i * 1000, { firstLine: `WARN ${'y'.repeat(200)}`, repo: `/work/example/${'r'.repeat(300)}` }))
    for (const columns of widths) {
      expect(findOverflow(layoutTree(paneLayout(makeSnap({ hygiene: ok(...entries) }), { columns, nowMs: NOW_MS, tzMin: 0, raster: true, cpuHist: [] }), FAKE_ELS) as unknown as Node, columns)).toEqual([])
    }
  })

  test('no hygiene field, no card', () => {
    const ids = paneLayout(makeSnap(), { columns: 89, nowMs: NOW_MS, tzMin: 0, raster: true, cpuHist: [] })
      .blocks.flatMap(b => (b.kind === 'cards' ? b.cards.map(c => c.id) : []))
    expect(ids).not.toContain('hygiene')
  })
})

describe('git-hygiene: the row through the engine', () => {
  const ROWS = '/root/.claude/cc-statusline-rows.json'
  const SIDE = '/tmp/claude-side/git-hygiene.json'

  const drawn = async ($: Parameters<typeof mountPane>[0]) => {
    const ui = await mountPane($, 89)
    const tree = await ui.drawn()
    await ui.unmount()
    return { parts: paneParts(tree, 89), text: renderTree(tree, 89).join('\n') }
  }

  // 15 s: the engine draws in about 1 s at normal load
  test('on by default: a fresh record draws the HYGIENE card with no error', { timeoutMs: 15_000 }, async ($, on) => {
    await boot($, on, w => {
      w.now = NOW_MS
      w.files.delete(ROWS)
      w.files.set(SIDE, envelope(good(), NOW_SEC - 120))
    })
    const { parts, text } = await drawn($)
    expect(cardOf(parts, 'HYGIENE').value).toBe('1 筆')
    expect(text).not.toMatch(/\d+ errors?\b/)
  })

  test('on by default and nothing written yet: the card says so, no error counted', { timeoutMs: 15_000 }, async ($, on) => {
    await boot($, on, w => {
      w.now = NOW_MS
      w.files.delete(ROWS)
    })
    const { parts, text } = await drawn($)
    expect(cardOf(parts, 'HYGIENE').body.join('')).toContain('還沒有警告紀錄')
    expect(text).not.toMatch(/\d+ errors?\b/)
  })

  test('a malformed record counts one error and the rest of the pane still draws', { timeoutMs: 15_000 }, async ($, on) => {
    await boot($, on, w => {
      w.now = NOW_MS
      w.files.delete(ROWS)
      w.files.set(SIDE, envelope(good({ event: 'merge' }), NOW_SEC - 120))
    })
    const { parts, text } = await drawn($)
    expect(parts.cards.map(c => c.title)).toContain('SYSTEM')
    expect(cardOf(parts, 'HYGIENE').body.join('')).toContain('data.entries[0].event')
    expect(text).toMatch(/1 error\b/)
  })

  test('a failed record counts one error and says the collection failed', { timeoutMs: 15_000 }, async ($, on) => {
    await boot($, on, w => {
      w.now = NOW_MS
      w.files.delete(ROWS)
      w.files.set(SIDE, envelope(null, NOW_SEC - 120, { collection_status: 'failed', error: { code: 'git_timeout', message: 'git timed out' }, last_success_at: null }))
    })
    const { parts, text } = await drawn($)
    expect(cardOf(parts, 'HYGIENE').body.join('')).toContain('收集失敗')
    expect(text).toMatch(/1 error\b/)
  })

  test('"hygiene": false hides the card and the file is never read', { timeoutMs: 15_000 }, async ($, on) => {
    const { world } = await boot($, on, w => {
      w.now = NOW_MS
      w.files.set(ROWS, '{"hygiene":false}')
      w.files.set(SIDE, envelope(good(), NOW_SEC - 120))
    })
    const { parts } = await drawn($)
    expect(parts.cards.map(c => c.title)).not.toContain('HYGIENE')
    expect(world.reads).not.toContain(SIDE)
  })

  test('the hint line is not changed by the card', { timeoutMs: 15_000 }, async ($, on) => {
    await boot($, on, w => {
      w.now = NOW_MS
      w.files.delete(ROWS)
      w.files.set(SIDE, envelope(good(), NOW_SEC - 120))
    })
    expect(await hintText($)).not.toMatch(/HYGIENE|NOT RECORDED/)
  })
})
