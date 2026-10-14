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

const stamp = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

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

const good = (over: Record<string, unknown> = {}) => ({
  event: 'commit',
  repo: REPO,
  first_line: 'NOT RECORDED: commit without a finding',
  lines: ['NOT RECORDED: commit without a finding', '  a/tool.py: 12 lines changed'],
  ...over,
})

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

describe('git-hygiene: reader mapping (data rules, SCHEMA git-hygiene)', () => {
  test('a commit record maps every field, with the age from the observed stamp', async () => {
    const v = await mapped(good())
    expect(v).toEqual({
      ok: true,
      v: {
        event: 'commit',
        repo: REPO,
        firstLine: 'NOT RECORDED: commit without a finding',
        lines: ['NOT RECORDED: commit without a finding', '  a/tool.py: 12 lines changed'],
        observedAtSec: NOW_SEC - 120,
        ageSec: 120,
      },
    })
  })

  test('a push record is accepted', async () => {
    const v = await mapped(good({ event: 'push' }))
    expect(v.ok && v.v.event).toBe('push')
  })

  test('an unknown event is malformed with the field named', async () => {
    const v = await mapped(good({ event: 'merge' }))
    expect(v.ok).toBe(false)
    expect(!v.ok && v.why).toMatch(/^n\/a（格式錯誤：data\.event/)
  })

  test('an empty repo is malformed with the field named', async () => {
    const v = await mapped(good({ repo: '' }))
    expect(!v.ok && v.why).toMatch(/data\.repo/)
  })

  test('a repo with a control character is malformed', async () => {
    const v = await mapped(good({ repo: `${REPO}\u0007` }))
    expect(!v.ok && v.why).toMatch(/data\.repo/)
  })

  test('a first line of 201 code points is malformed, one of 200 is not', async () => {
    expect((await mapped(good({ first_line: 'x'.repeat(201) }))).ok).toBe(false)
    expect((await mapped(good({ first_line: 'x'.repeat(200) }))).ok).toBe(true)
  })

  test('a first line with a control character is malformed', async () => {
    const v = await mapped(good({ first_line: 'NOT\u0000RECORDED' }))
    expect(!v.ok && v.why).toMatch(/data\.first_line/)
  })

  test('41 lines is malformed, 40 is not', async () => {
    expect((await mapped(good({ lines: Array.from({ length: 41 }, (_, i) => `line ${i}`) }))).ok).toBe(false)
    expect((await mapped(good({ lines: Array.from({ length: 40 }, (_, i) => `line ${i}`) }))).ok).toBe(true)
  })

  test('an empty lines array is malformed', async () => {
    const v = await mapped(good({ lines: [] }))
    expect(!v.ok && v.why).toMatch(/data\.lines/)
  })

  test('a line of 301 code points is malformed and the reason names its index', async () => {
    const v = await mapped(good({ lines: ['ok', 'x'.repeat(301)] }))
    expect(!v.ok && v.why).toMatch(/data\.lines\[1\]/)
  })

  test('lines that is not an array is malformed', async () => {
    const v = await mapped(good({ lines: 'NOT RECORDED' }))
    expect(!v.ok && v.why).toMatch(/data\.lines/)
  })

  test('the first violation decides: event before repo before first_line before lines', async () => {
    const v = await mapped(good({ event: 'merge', repo: '', lines: 'x' }))
    expect(!v.ok && v.why).toMatch(/data\.event/)
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
  const record = (ageSec: number) => ({
    event: 'commit', repo: REPO, firstLine: 'NOT RECORDED: commit without a finding',
    lines: ['NOT RECORDED: commit without a finding'], observedAtSec: NOW_SEC - ageSec, ageSec,
  })

  test('fresh: titled HYGIENE, the age as value, the event, the repo and the first line', () => {
    for (const columns of widths) {
      const card = cardOf(cardAt(makeSnap({ hygiene: { ok: true, v: record(120) } }), columns), 'HYGIENE')
      expect(card.value).toBe('2m')
      const body = card.body.join('\n')
      expect(body).toContain('commit')
      expect(body).toContain('NOT RECORDED')
      expect(card.raw.join('\n')).not.toContain('舊')
    }
  })

  test('the full repository path is on the card', () => {
    const card = cardOf(cardAt(makeSnap({ hygiene: { ok: true, v: record(120) } }), 89), 'HYGIENE')
    expect(card.body.join('').replace(/\s/g, '')).toContain(REPO)
  })

  test('30 minutes old is still fresh, 31 minutes is marked 舊 and still shown', () => {
    const fresh = cardOf(cardAt(makeSnap({ hygiene: { ok: true, v: record(HYGIENE_STALE_SEC) } }), 89), 'HYGIENE')
    expect(fresh.value).toBe('30m')
    const stale = cardOf(cardAt(makeSnap({ hygiene: { ok: true, v: record(31 * 60) } }), 89), 'HYGIENE')
    expect(stale.value).toContain('舊')
    expect(stale.value).toContain('31m')
    expect(stale.body.join('')).toContain('NOT RECORDED')
  })

  test('missing: the card says there is no warning record yet', () => {
    const card = cardOf(cardAt(makeSnap({ hygiene: { ok: false, why: 'n/a（缺檔）' } }), 89), 'HYGIENE')
    expect(card.body.join('')).toContain('還沒有警告紀錄')
    expect(card.body.join('')).not.toContain('n/a')
  })

  test('malformed and failed: the reader text in full, the rest of the pane unchanged', () => {
    const card = cardOf(cardAt(makeSnap({ hygiene: { ok: false, why: 'n/a（格式錯誤：data.event 不合）' } }), 89), 'HYGIENE')
    expect(card.body.join('').replace(/\s/g, '')).toContain('n/a（格式錯誤：data.event不合）')
    expect(cardOf(cardAt(makeSnap({ hygiene: { ok: false, why: 'n/a（收集失敗：x）' } }), 89), 'SYSTEM').title).toBe('SYSTEM')
  })

  test('the tree fits its room at each width', () => {
    for (const columns of widths) {
      expect(findOverflow(layoutTree(paneLayout(makeSnap({ hygiene: { ok: true, v: record(31 * 60) } }), { columns, nowMs: NOW_MS, tzMin: 0, raster: true, cpuHist: [] }), FAKE_ELS) as unknown as Node, columns)).toEqual([])
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
    expect(cardOf(parts, 'HYGIENE').value).toBe('2m')
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
    expect(cardOf(parts, 'HYGIENE').body.join('')).toContain('data.event')
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
