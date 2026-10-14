import { describe, expect, test } from 'claude-code/testing'

import { EXPECTED_TEXT, FILES, HUB_COMMIT, REF_NOW_MS } from './sync.fixtures'
import { TURN_DONE, boot, cardOf, hintText, makeSnap, mountPane, stallNext } from './fixture'
import type { Proc, World } from './fixture'
import { dw, parseTogglesStrict, tailText } from './model'
import { layoutTree, paneLayout } from './pane'
import type { Snap, SyncData } from './state'
import { FAKE_ELS, cardTitled, findOverflow, paneParts, renderTree } from './tree'
import type { CardView, Node } from './tree'
import { syncHead, syncHint, syncOf } from './sync'
import { KINDS, readSideFile } from './sidefile'
import type { SideIo, SideResult } from './sidefile'

const DIR = '/tmp/claude-side'
const NOW_SEC = REF_NOW_MS / 1000

const ioOver = (files: Record<string, string>): SideIo => ({
  exists: async p => p in files,
  readBytes: async p => {
    const f = files[p]
    if (f === undefined) throw new Error('ENOENT')
    return new TextEncoder().encode(f)
  },
})

const read = (name: string, now = REF_NOW_MS): Promise<SideResult> => {
  const files = Object.fromEntries(Object.entries(FILES).map(([k, v]) => [`${DIR}/${k}`, v]))
  return readSideFile(ioOver(files), `${DIR}/${name}`, now)
}

const okOf = (r: SideResult) => {
  const res = syncOf(r, NOW_SEC)
  if (!res.ok) throw new Error(`expected ok, got ${res.why}`)
  return res.v
}

describe('sync-status: reader mapping (SCHEMA §9 data)', () => {
  test('the behind fixture maps every field, with stamps as epoch seconds', async () => {
    const v = okOf(await read('sync-status.behind3.json'))
    expect(v.branch).toBe('sync-data-v2')
    expect(v.upstream).toBe('origin/sync-data-v2')
    expect([v.ahead, v.behind]).toEqual([0, 3])
    expect(v.lastPushSec).toBe(Date.parse('2026-10-10T11:00:00Z') / 1000)
    expect(v.lastFetchSec).toBe(Date.parse('2026-10-10T11:50:00Z') / 1000)
    expect(v.observedAtSec).toBe(Date.parse('2026-10-10T11:59:30Z') / 1000)
  })

  test('diverged keeps ahead and behind in their own fields', async () => {
    const v = okOf(await read('sync-status.diverged.json'))
    expect([v.ahead, v.behind]).toEqual([2, 3])
  })

  test('null stamps stay null, not zero', async () => {
    const v = okOf(await read('sync-status.nulls.json'))
    expect(v.lastPushSec).toBeNull()
    expect(v.lastFetchSec).toBeNull()
  })

  test('a 2.0 count is malformed at the file level, never shown as 2', async () => {
    const r = await read('sync-status.malformed-float.json')
    expect(r.verdict).toBe('malformed')
  })

  test('a stamp that is not on the calendar is n/a with the field named', async () => {
    const r = await read('sync-status.stamp-not-real.json')
    expect(r.verdict).toBe('ok') // the file-level reader judges the envelope; data rules are syncOf's
    const res = syncOf(r, NOW_SEC)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.why).toMatch(/^n\/a（格式錯誤：data\.last_fetch_at /)
  })

  test('a failed file gives the reader text and no data', async () => {
    const r = await read('sync-status.failed.json')
    const res = syncOf(r, NOW_SEC)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.why).toMatch(/^n\/a（收集失敗：HEAD is not on sync-data-v2/)
  })

  test('a stale file is n/a and its poison count is not in the reason', async () => {
    const r = await read('sync-status.stale.json')
    expect(r.verdict).toBe('stale')
    const res = syncOf(r, NOW_SEC)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.why).not.toMatch(/99/)
  })

  test('a push stamp later than the observation plus the skew is malformed', () => {
    const r: SideResult = {
      verdict: 'ok', kind: 'sync-status', producer: { id: 'sync-status', host: 'wky' }, station: null, runId: null,
      observedAtSec: NOW_SEC - 10, ageSec: 10,
      data: { branch: 'sync-data-v2', upstream: 'origin/sync-data-v2', ahead: 0, behind: 0,
        last_push_at: new Date((NOW_SEC + 400) * 1000).toISOString().slice(0, 19) + 'Z', last_fetch_at: null },
    }
    const res = syncOf(r, NOW_SEC)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.why).toMatch(/^n\/a（格式錯誤：data\.last_push_at /)
  })

  test('negative, fractional, and string counts are each malformed', () => {
    const base = { branch: 'sync-data-v2', upstream: 'origin/sync-data-v2', last_push_at: null, last_fetch_at: null }
    for (const [ahead, behind] of [[-1, 0], [1.5, 0], ['2', 0], [0, 9007199254740992]] as const) {
      const r: SideResult = {
        verdict: 'ok', kind: 'sync-status', producer: { id: 'sync-status', host: 'wky' }, station: null, runId: null,
        observedAtSec: NOW_SEC, ageSec: 0, data: { ...base, ahead, behind },
      }
      const res = syncOf(r, NOW_SEC)
      expect(res.ok).toBe(false)
    }
  })

  test('the kind declares ahead and behind as integer literals', () => {
    expect(KINDS['sync-status']).toMatchObject({ cls: 'local', ttlSec: 900, finalTtlSec: null })
    expect(KINDS['sync-status']!.intFields).toEqual(['ahead', 'behind'])
  })
})

describe('sync-status: headline and tail hint', () => {
  const at = (ahead: number, behind: number) => ({ ahead, behind })

  test('headline: green check when in sync, yellow for one side, red when diverged', () => {
    expect(syncHead(at(0, 0))).toEqual({ text: '✓', tone: 'green' })
    expect(syncHead(at(0, 3))).toEqual({ text: '-3 PULL', tone: 'yellow' })
    expect(syncHead(at(2, 0))).toEqual({ text: '+2 PUSH', tone: 'yellow' })
    expect(syncHead(at(2, 3))).toEqual({ text: '+2 -3', tone: 'red' })
  })

  const snapWith = (sync: ReturnType<typeof okOf> | null, rows: Record<string, boolean> = {}) => {
    const base = makeSnap()
    const toggles = { enabled: true, rows: { ...base.toggles.rows, sync: true, ...rows } }
    return makeSnap({ toggles, sync: sync === null ? undefined : { ok: true, v: sync } as never })
  }
  const data = (ahead: number, behind: number) => ({
    branch: 'sync-data-v2', upstream: 'origin/sync-data-v2', ahead, behind,
    lastPushSec: null, lastFetchSec: null, observedAtSec: NOW_SEC,
  })

  test('the tail says what to do, and nothing when in sync', () => {
    expect(syncHint(snapWith(data(0, 3)))).toBe('SYNC -3 PULL')
    expect(syncHint(snapWith(data(2, 0)))).toBe('SYNC +2 PUSH')
    expect(syncHint(snapWith(data(2, 3)))).toBe('SYNC +2 -3 PULL')
    expect(syncHint(snapWith(data(0, 0)))).toBeNull()
  })

  test('counts above 999 print as 999+', () => {
    expect(syncHint(snapWith(data(0, 1000)))).toBe('SYNC -999+ PULL')
  })

  test('nothing when the row is off, the master is off, or the file is n/a', () => {
    expect(syncHint(snapWith(data(0, 3), { sync: false }))).toBeNull()
    const off = snapWith(data(0, 3))
    expect(syncHint({ ...off, toggles: { ...off.toggles, enabled: false } })).toBeNull()
    expect(syncHint(makeSnap({ sync: { ok: false, why: 'n/a（缺檔）' } }))).toBeNull()
    expect(syncHint(makeSnap({ sync: undefined }))).toBeNull()
  })

  test('the hint leads the tail and survives the trim that drops the clock', () => {
    const snap = snapWith(data(2, 3))
    const tail = tailText(snap, REF_NOW_MS, 0)
    expect(tail).not.toBeNull()
    expect(tail!.startsWith('SYNC +2 -3 PULL')).toBe(true)
    expect(tail!.length).toBeLessThanOrEqual(48)
  })

  test('with the row off the tail is what it was before the row existed', () => {
    const plain = makeSnap()
    expect(tailText(snapWith(data(0, 3), { sync: false }), REF_NOW_MS, 0)).toBe(tailText(plain, REF_NOW_MS, 0))
  })

  test('the row is on by default, and only a falsy value switches it off, as for the other rows', () => {
    expect(parseTogglesStrict('{}')!.rows.sync).toBe(true)
    expect(parseTogglesStrict('{"sync": true}')!.rows.sync).toBe(true)
    expect(parseTogglesStrict('{"sync": 1}')!.rows.sync).toBe(true)
    expect(parseTogglesStrict('{"sync": false}')!.rows.sync).toBe(false)
    expect(parseTogglesStrict('{"sync": 0}')!.rows.sync).toBe(false)
  })
})

describe('sync-status: card', () => {
  const widths = [36, 49, 89]
  const cardAt = (snap: ReturnType<typeof makeSnap>, columns: number) =>
    paneParts(layoutTree(paneLayout(snap, { columns, nowMs: REF_NOW_MS, tzMin: 0, raster: true, cpuHist: [] }), FAKE_ELS) as unknown as Node, columns)

  test('ok behind: titled SYNC with the headline and the rows at every width', () => {
    for (const columns of widths) {
      const card = cardOf(cardAt(makeSnap({ sync: { ok: true, v: okOfData() } }), columns), 'SYNC')
      expect(card.value).toBe('-3 PULL')
      expect(card.body.join('\n')).toContain('behind')
      expect(card.body.join('\n')).toContain('3')
    }
  })

  test('n/a shows the reason in full and no count', () => {
    const card = cardOf(cardAt(makeSnap({ sync: { ok: false, why: 'n/a（缺檔）' } }), 89), 'SYNC')
    expect(card.body.join('').replace(/\s/g, '')).toBe('n/a（缺檔）')
    expect(card.value).toBe('')
  })

  test('a poison count in the reason never reaches the card', () => {
    const card = cardOf(cardAt(makeSnap({ sync: { ok: false, why: 'n/a（過期 4h）' } }), 49), 'SYNC')
    expect(card.raw.join('')).not.toMatch(/99/)
  })

  test('the tree fits its room at each width', () => {
    for (const columns of widths) {
      expect(findOverflow(layoutTree(paneLayout(makeSnap({ sync: { ok: true, v: okOfData() } }), { columns, nowMs: REF_NOW_MS, tzMin: 0, raster: true, cpuHist: [] }), FAKE_ELS) as unknown as Node, columns)).toEqual([])
    }
  })

  test('no sync field, no card', () => {
    const ids = paneLayout(makeSnap(), { columns: 89, nowMs: REF_NOW_MS, tzMin: 0, raster: true, cpuHist: [] })
      .blocks.flatMap(b => (b.kind === 'cards' ? b.cards.map(c => c.id) : []))
    expect(ids).not.toContain('sync')
  })
})

const okOfData = () => ({
  branch: 'sync-data-v2', upstream: 'origin/sync-data-v2', ahead: 0, behind: 3,
  lastPushSec: Date.parse('2026-10-10T11:00:00Z') / 1000, lastFetchSec: Date.parse('2026-10-10T11:50:00Z') / 1000,
  observedAtSec: Date.parse('2026-10-10T11:59:30Z') / 1000,
})

// ---- every width ----

describe('sync-status: the card at every width from 22 to 122', () => {
  // 22 columns is the narrowest pane the layout draws (MIN_W + 2); the tests above look at 36, 49 and 89 only
  const FIRST = 22
  const LAST = 122
  const LABELS = ['ahead', 'behind', 'last push', 'fetched', 'age', 'observed']
  const LABEL_ROW = /^(ahead|behind|last push|fetched|age|observed)(?= |$)/
  const stamp = (iso: string) => Date.parse(iso) / 1000

  const drawn = (snap: Snap, columns: number) => {
    const tree = layoutTree(paneLayout(snap, { columns, nowMs: REF_NOW_MS, tzMin: 0, raster: true, cpuHist: [] }), FAKE_ELS) as unknown as Node
    return { tree, parts: paneParts(tree, columns) }
  }

  /** What holds at one width whatever the card says: nothing in the pane passes its room, every frame is whole, the SYNC card spans the pane. Returns that card. */
  const holds = (snap: Snap, columns: number, at: string): CardView => {
    const { tree, parts } = drawn(snap, columns)
    expect(findOverflow(tree, columns), at).toEqual([])
    expect(Math.max(...renderTree(tree, columns).map(dw)), at).toBeLessThanOrEqual(columns - 2)
    for (const c of parts.cards) {
      const name = c.title || 'header'
      expect(c.raw[0], `${at}: top of ${name}`).toMatch(/^╭─+╮$/)
      expect(c.raw.at(-1), `${at}: bottom of ${name}`).toMatch(/^╰─+╯$/)
      expect(c.raw.every(l => dw(l) === c.width), `${at}: a line of ${name} is not ${c.width} cells`).toBe(true)
    }
    // not cardOf: it answers a card of nothing when there is none, and a sweep of nothing is green
    const card = cardTitled(parts, 'SYNC')
    expect(card, `${at}: no SYNC card`).toBeDefined()
    expect(card!.width, `${at}: the SYNC card spans the pane`).toBe(columns - 2)
    return card!
  }

  // four digits is the widest headline that leaves the title room at 22 columns (4 + 1 + 11 of 16 cells)
  const OK: [string, SyncData, string][] = [
    ['behind 3, pushed and fetched', okOfData(), '-3 PULL'],
    ['ahead 2, stamps months old', { ...okOfData(), ahead: 2, behind: 0, lastPushSec: stamp('2026-01-01T00:00:00Z'), lastFetchSec: stamp('2026-06-01T00:00:00Z') }, '+2 PUSH'],
    ['diverged, four-digit counts', { ...okOfData(), ahead: 1234, behind: 5678 }, '+1234 -5678'],
    ['in sync, never pushed or fetched', { ...okOfData(), ahead: 0, behind: 0, lastPushSec: null, lastFetchSec: null }, '✓'],
  ]
  for (const [name, v, head] of OK) {
    test(`${name}: nothing passes its room, every frame is whole, the headline and the six rows are there`, () => {
      for (let columns = FIRST; columns <= LAST; columns++) {
        const at = `${name} at bodyColumns ${columns}`
        const card = holds(makeSnap({ sync: { ok: true, v } }), columns, at)
        expect(card.value, at).toBe(head)
        expect(card.body.flatMap(l => LABEL_ROW.exec(l)?.[1] ?? []), at).toEqual(LABELS)
      }
    })
  }

  /** What the card says when the reader turns a producer file away. */
  const whyOf = async (file: string): Promise<string> => {
    const res = syncOf(await read(file), NOW_SEC)
    if (res.ok) throw new Error(`${file} was expected to be n/a`)
    return res.why
  }
  // the last two reasons are wider than the widest card here (116 cells inside), so they wrap at every width
  const NA: [string, () => Promise<string>][] = [
    ['no producer file', () => whyOf('sync-status.absent.json')],
    ['the producer timed out', () => whyOf('sync-status.failed-timeout.json')],
    ['one word wider than the card', async () => `n/a（收集失敗：${'x'.repeat(190)}，從未成功）`],
    ['wide characters only', async () => `n/a（格式錯誤：data.${'目錄'.repeat(30)}）`],
  ]
  for (const [name, reason] of NA) {
    test(`n/a, ${name}: nothing passes its room, every frame is whole, the reason is read to its end`, async () => {
      const why = await reason()
      for (let columns = FIRST; columns <= LAST; columns++) {
        const at = `n/a ${name} at bodyColumns ${columns}`
        const card = holds(makeSnap({ sync: { ok: false, why } }), columns, at)
        expect(card.value, at).toBe('')
        expect(card.body.join('').replace(/\s/g, ''), at).toBe(why.replace(/\s/g, ''))
      }
    })
  }
})

// ---- the hub chain: producer bytes -> reader -> card (E2E-01/02) ----

type Case = {
  case: string; file: string; sha256: string; source: string; verdict: string; violation?: string
  ahead?: number; behind?: number; last_push_at?: string | null; last_fetch_at?: string | null
}
type Boundary = { file: string; now: string; verdict: string; violation?: string; why: string }
const EXPECTED = JSON.parse(EXPECTED_TEXT) as { reference: { now: string }; cases: Case[]; boundaries: Boundary[] }

/** The file read from its bytes, then the card's data rules: ok with the data, or the verdict and the n/a text. */
const judged = async (file: string, nowMs: number) => {
  const r = await read(file, nowMs)
  if (r.verdict !== 'ok') return { verdict: String(r.verdict), why: r.text }
  const res = syncOf(r, nowMs / 1000)
  return res.ok ? { verdict: 'ok', v: res.v, why: '' } : { verdict: 'malformed', why: res.why }
}

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

describe('sync-status: hub fixtures (E2E-01/02)', () => {
  test('the copies are the hub bytes: every file has the sha256 its EXPECTED entry lists', async () => {
    expect(HUB_COMMIT).toMatch(/^[0-9a-f]{7,40}$/)
    expect(Object.keys(FILES).sort()).toEqual(EXPECTED.cases.map(c => c.file).sort())
    for (const c of EXPECTED.cases) expect(await sha256(FILES[c.file]!)).toBe(c.sha256)
  })

  test('the table is not vacuous: every verdict is present and eight files come from the producer', () => {
    expect(EXPECTED.reference.now).toBe('2026-10-10T12:00:00Z')
    expect(EXPECTED.cases.length).toBeGreaterThanOrEqual(30)
    const verdicts = new Set(EXPECTED.cases.map(c => c.verdict))
    expect([...verdicts].sort()).toEqual(['failed', 'malformed', 'ok', 'stale'])
    expect(EXPECTED.cases.filter(c => c.source === 'producer').length).toBe(8)
  })

  test('every case gets the verdict, the values and the named field the hub lists', async () => {
    for (const c of EXPECTED.cases) {
      const got = await judged(c.file, REF_NOW_MS)
      expect([c.case, got.verdict]).toEqual([c.case, c.verdict])
      if (c.verdict === 'ok') {
        const v = (got as { v: ReturnType<typeof okOf> }).v
        expect([c.case, v.ahead, v.behind]).toEqual([c.case, c.ahead, c.behind])
        const sec = (stamp: string | null | undefined) => (stamp ? Date.parse(stamp) / 1000 : null)
        expect([c.case, v.lastPushSec, v.lastFetchSec]).toEqual([c.case, sec(c.last_push_at), sec(c.last_fetch_at)])
      }
      if (c.violation) expect([c.case, got.why]).toEqual([c.case, expect.stringContaining(c.violation)])
    }
  })

  test('every boundary gets the verdict the hub lists', async () => {
    expect(EXPECTED.boundaries.length).toBeGreaterThanOrEqual(5)
    for (const b of EXPECTED.boundaries) {
      const got = await judged(b.file, Date.parse(b.now))
      expect([b.why, got.verdict]).toEqual([b.why, b.verdict])
      if (b.violation) expect([b.why, got.why]).toEqual([b.why, expect.stringContaining(b.violation)])
    }
  })

  test('a stale file with a float count is stale, a fresh one is malformed (data rules come after staleness)', async () => {
    expect((await judged('sync-status.stale-float.json', REF_NOW_MS)).verdict).toBe('stale')
    expect((await judged('sync-status.malformed-float.json', REF_NOW_MS)).verdict).toBe('malformed')
  })

  const widths = [36, 49, 89]
  const cardAt = (snap: ReturnType<typeof makeSnap>, columns: number) =>
    paneParts(layoutTree(paneLayout(snap, { columns, nowMs: REF_NOW_MS, tzMin: 0, raster: true, cpuHist: [] }), FAKE_ELS) as unknown as Node, columns)
  const cardFor = async (file: string, columns: number) => {
    const res = syncOf(await read(file), NOW_SEC)
    return cardOf(cardAt(makeSnap({ sync: res }), columns), 'SYNC')
  }

  test('producer bytes drawn: behind 3, diverged, in sync', async () => {
    for (const columns of widths) {
      const behind = await cardFor('sync-status.behind3.json', columns)
      expect(behind.value).toBe('-3 PULL')
      const diverged = await cardFor('sync-status.diverged.json', columns)
      expect(diverged.value).toBe('+2 -3')
      const same = await cardFor('sync-status.in-sync.json', columns)
      expect(same.value).toBe('✓')
    }
  })

  test('producer bytes drawn: the failed file shows the producer text and no counts', async () => {
    const card = await cardFor('sync-status.failed.json', 89)
    expect(card.value).toBe('')
    const text = card.body.join('').replace(/\s/g, '')
    expect(text).toContain('n/a（收集失敗：HEADisnotonsync-data-v2，上次成功')
    expect(text).not.toContain('main')
    expect(text).not.toMatch(/ahead|behind/)
  })

  test('producer bytes drawn: a timeout failure and a never-pushed file', async () => {
    const slow = await cardFor('sync-status.failed-timeout.json', 89)
    expect(slow.body.join('').replace(/\s/g, '')).toContain('n/a（收集失敗：gitdidnotanswerintime(3sper call'.replace(/\s/g, ''))
    const nulls = await cardFor('sync-status.nulls.json', 89)
    expect(nulls.body.join('\n')).toContain('n/a（無推送紀錄）')
  })
})

describe('sync-status: the row through the engine (on by default, opt-out)', () => {
  const ROWS = '/root/.claude/cc-statusline-rows.json'
  const SIDE = '/tmp/claude-side/sync-status.json'
  const behind = FILES['sync-status.behind3.json']!

  /** The cards and the rendered text of one draw of the pane at 89 columns. */
  const drawn = async ($: Parameters<typeof mountPane>[0]) => {
    const ui = await mountPane($, 89)
    const tree = await ui.drawn()
    await ui.unmount()
    return { parts: paneParts(tree, 89), text: renderTree(tree, 89).join('\n') }
  }

  test('on by default: a fresh producer file draws -3 PULL as the last card and leads the tail, with no error', async ($, on) => {
    await boot($, on, w => {
      w.now = REF_NOW_MS
      w.files.delete(ROWS)
      w.files.set(SIDE, behind)
    })
    const { parts, text } = await drawn($)
    expect(parts.cards.map(c => c.title).slice(-2)).toEqual(['SYSTEM', 'SYNC'])
    expect(cardOf(parts, 'SYNC').value).toBe('-3 PULL')
    expect(await hintText($)).toMatch(/^\? for shortcuts\|SYNC -3 PULL/)
    expect(text).not.toMatch(/\d+ errors?\b/)
  })

  test('on by default and the producer has written nothing: n/a（缺檔）, no tail segment, no error', async ($, on) => {
    await boot($, on, w => {
      w.now = REF_NOW_MS
      w.files.delete(ROWS)
    })
    const { parts, text } = await drawn($)
    const card = cardOf(parts, 'SYNC')
    expect(card.value).toBe('')
    expect(card.body.join('').replace(/\s/g, '')).toBe('n/a（缺檔）')
    expect(await hintText($)).not.toMatch(/SYNC/)
    expect(text).not.toMatch(/\d+ errors?\b/)
  })

  test('"sync": false in the rows file hides the card, the tail and the error, and the side file is never read', async ($, on) => {
    const { world } = await boot($, on, w => {
      w.now = REF_NOW_MS
      w.files.set(ROWS, '{"sync":false}')
      w.files.set(SIDE, behind)
    })
    const { parts, text } = await drawn($)
    expect(parts.cards.map(c => c.title)).not.toContain('SYNC')
    expect(await hintText($)).not.toMatch(/SYNC/)
    expect(text).not.toMatch(/\d+ errors?\b/)
    expect(world.reads).not.toContain(SIDE)
  })

  // Owner decision of 2026-10-12 (#29): the card shows every n/a, but only a fault is a SYSTEM error. No file (no producer
  // on this machine yet) and an aged file (between hook runs, until #91 refreshes it) are by design, not faults.
  describe('which n/a counts as a SYSTEM error', () => {
    const failed = FILES['sync-status.failed.json']!
    /** 20 minutes on from the reference clock: `failed` and `behind` were written 1230 s before, 900 s being the TTL. */
    const AGED_MS = REF_NOW_MS + 20 * 60_000

    /** A world whose only SYNC input is `file` (none when null), read at `nowMs`. */
    const serving = (file: string | null, nowMs = REF_NOW_MS) => (w: World) => {
      w.now = nowMs
      w.files.delete(ROWS)
      if (file !== null) w.files.set(SIDE, file)
    }

    /** The row as the user sees it: the card says `card` (the reader's own text), the tail has no SYNC, the SYSTEM card counts `errors` (no chip is 0). */
    const expectRow = async ($: Parameters<typeof mountPane>[0], card: RegExp, errors: number) => {
      const { parts, text } = await drawn($)
      expect(cardOf(parts, 'SYNC').body.join('').replace(/\s/g, '')).toMatch(card)
      expect(await hintText($)).not.toMatch(/SYNC/)
      expect(Number(/(\d+) errors?\b/.exec(text)?.[1] ?? 0)).toBe(errors)
    }

    test('a stale file: n/a（過期 30m）, no tail segment, no error', async ($, on) => {
      await boot($, on, serving(FILES['sync-status.stale.json']!))
      await expectRow($, /^n\/a（過期30m）$/, 0)
    })

    test('a stale file whose last collection failed: the card says both, no error (the failed file counted before it aged)', async ($, on) => {
      await boot($, on, serving(failed, AGED_MS))
      await expectRow($, /^n\/a（過期20m，最後一筆收集失敗：/, 0)
    })

    test('a fresh failed file: the reader text, no tail segment, one error', async ($, on) => {
      await boot($, on, serving(failed))
      await expectRow($, /^n\/a（收集失敗：/, 1)
    })

    test('a fresh file with a count that is not an integer literal (2.0): malformed, one error', async ($, on) => {
      await boot($, on, serving(FILES['sync-status.malformed-float.json']!))
      await expectRow($, /^n\/a（格式錯誤：data\.ahead/, 1)
    })

    test('a fresh file that the data rules of the card turn away (a branch name with a space): one error', async ($, on) => {
      await boot($, on, serving(behind.replace('"sync-data-v2"', '"sync data-v2"')))
      await expectRow($, /^n\/a（格式錯誤：data\.branch/, 1)
    })

    test('a truncated file is corrupt: one error', async ($, on) => {
      await boot($, on, serving(behind.slice(0, 100)))
      await expectRow($, /^n\/a（檔案損毀或被截斷）$/, 1)
    })

    test('a row whose collection fails (the read outlasts the 5 s guard): n/a（timeout）, one error', async ($, on) => {
      const { world, advance, clock } = await boot($, on, serving(behind))
      const release = stallNext(world, `fs.read:${SIDE}`)
      await advance(30_000)
      await clock.settle()
      await advance(5000)
      await clock.settle()
      await expectRow($, /^n\/a（timeout）$/, 1)
      release()
      await clock.settle()
    })
  })
})

describe('sync-status: the mod starts the producer every five minutes (#91)', () => {
  const MIN5 = 300_000
  const ROWS = '/root/.claude/cc-statusline-rows.json'
  const PROD = '/root/.claude/scripts/hooks/sync-status.py'
  const PROD_CFG = '/opt/cc/scripts/hooks/sync-status.py'
  const ARGV = ['python3', '-I', '-B', PROD, '--print']
  const RUN_KEY = (argv: string[]) => `process.run:${argv.join(' ')}`
  const starts = (world: World, argv: string[] = ARGV) => world.ran.filter(r => r.argv.join(' ') === argv.join(' '))
  const debugLines = (world: World) => world.logged.filter(l => l.to === 'debug').map(l => l.text)

  /** The SYNC card and the error chip (the SYSTEM card's last line): a failed producer must change neither. The CPU rows move on their own. */
  const cards = async ($: Parameters<typeof mountPane>[0]) => {
    const ui = await mountPane($, 89)
    const parts = paneParts(await ui.drawn(), 89)
    await ui.unmount()
    return { sync: cardOf(parts, 'SYNC').body.join('|'), errors: cardOf(parts, 'SYSTEM').body.at(-1) }
  }

  test('on by default the first start is one interval after the mod starts, then one per interval, bounded at 30 s', async ($, on) => {
    const { world, advance } = await boot($, on, w => {
      w.files.delete(ROWS)
      w.files.set(PROD, '# producer')
      w.procs.set(ARGV.join(' '), { exitCode: 0 })
    })
    expect(starts(world).length).toBe(0)
    await advance(MIN5 - 1000)
    expect(starts(world).length).toBe(0)
    await advance(1000)
    expect(starts(world).length).toBe(1)
    expect(starts(world)[0]?.init).toEqual({ stdin: '{}', timeoutMs: 30_000 })
    await advance(MIN5)
    expect(starts(world).length).toBe(2)
  })

  test('"sync": false: the producer is never started, however long the mod runs', async ($, on) => {
    const { world, advance } = await boot($, on, w => {
      w.files.set(ROWS, '{"sync":false}')
      w.files.set(PROD, '# producer')
      w.procs.set(ARGV.join(' '), { exitCode: 0 })
    })
    await advance(3 * MIN5)
    expect(starts(world).length).toBe(0)
    expect(debugLines(world).filter(t => /sync-status/.test(t))).toEqual([])
  })

  test('"enabled": false: the producer is never started either, however long the mod runs', async ($, on) => {
    const { world, advance } = await boot($, on, w => {
      w.files.set(ROWS, '{"enabled":false}')
      w.files.set(PROD, '# producer')
      w.procs.set(ARGV.join(' '), { exitCode: 0 })
    })
    await advance(3 * MIN5)
    expect(starts(world).length).toBe(0)
    expect(debugLines(world).filter(t => /sync-status/.test(t))).toEqual([])
  })

  test('CLAUDE_CONFIG_DIR, when set, is the directory the producer is started from', async ($, on) => {
    const { world, advance } = await boot($, on, w => {
      w.files.delete(ROWS)
      w.env.CLAUDE_CONFIG_DIR = '/opt/cc'
      w.files.set(PROD_CFG, '# producer')
      w.procs.set(['python3', '-I', '-B', PROD_CFG, '--print'].join(' '), { exitCode: 0 })
    })
    await advance(MIN5)
    expect(starts(world, ['python3', '-I', '-B', PROD_CFG, '--print'])).toHaveLength(1)
    expect(starts(world)).toHaveLength(0)
  })

  test('without CLAUDE_CONFIG_DIR the producer is HOME/.claude/scripts/hooks/sync-status.py', async ($, on) => {
    const { world, advance } = await boot($, on, w => {
      w.files.delete(ROWS)
      w.files.set(PROD, '# producer')
      w.procs.set(ARGV.join(' '), { exitCode: 0 })
    })
    await advance(MIN5)
    expect(starts(world)).toHaveLength(1)
  })

  test('an empty CLAUDE_CONFIG_DIR counts as unset, as the hook reads it', async ($, on) => {
    const { world, advance } = await boot($, on, w => {
      w.files.delete(ROWS)
      w.env.CLAUDE_CONFIG_DIR = ''
      w.files.set(PROD, '# producer')
      w.procs.set(ARGV.join(' '), { exitCode: 0 })
    })
    await advance(MIN5)
    expect(starts(world)).toHaveLength(1)
  })

  test('a missing producer file: the reason is logged to the debug log and the cards are the same', async ($, on) => {
    const { world, advance } = await boot($, on, w => w.files.delete(ROWS))
    const before = await cards($)
    await advance(MIN5)
    expect(await cards($)).toEqual(before)
    expect(debugLines(world).some(t => /missing/.test(t) && t.includes(PROD))).toBe(true)
  })

  test('a non-zero exit: the code and the report are logged and the cards are the same', async ($, on) => {
    const { world, advance } = await boot($, on, w => {
      w.files.delete(ROWS)
      w.files.set(PROD, '# producer')
      w.procs.set(ARGV.join(' '), { exitCode: 1, stdout: 'sync-status: failed\n  error:     git_timeout: slow\n' })
    })
    const before = await cards($)
    await advance(MIN5)
    expect(debugLines(world).join('\n')).toMatch(/exited 1[\s\S]*git_timeout/)
    expect(await cards($)).toEqual(before)
  })

  test('a timeout: the host ends the run with an error, the reason is logged, the cards are the same, and the next interval runs', async ($, on) => {
    const { world, advance } = await boot($, on, w => {
      w.files.delete(ROWS)
      w.files.set(PROD, '# producer')
      w.delay.set(RUN_KEY(ARGV), 30_000)
      w.procs.set(ARGV.join(' '), new Error('timed out after 30000 ms'))
    })
    const before = await cards($)
    await advance(MIN5)
    await advance(30_000)
    expect(debugLines(world).join('\n')).toMatch(/timed out/)
    expect(await cards($)).toEqual(before)
    await advance(MIN5 - 30_000)
    expect(starts(world)).toHaveLength(2)
  })

  test('a run longer than the interval: the tick that finds it unfinished is skipped, and the tick after it runs', async ($, on) => {
    const { world, advance } = await boot($, on, w => {
      w.files.delete(ROWS)
      w.files.set(PROD, '# producer')
      w.delay.set(RUN_KEY(ARGV), 400_000)
      w.procs.set(ARGV.join(' '), { exitCode: 0 })
    })
    await advance(MIN5)
    await advance(MIN5)
    expect(starts(world)).toHaveLength(1)
    expect(debugLines(world).filter(t => /still going/.test(t))).toHaveLength(1)
    await advance(MIN5)
    expect(starts(world)).toHaveLength(2)
  })

  test('a turn that ends on a stale snapshot re-arms the timers, so the period starts again from that turn', async ($, on) => {
    const { world, advance, clock } = await boot($, on, w => {
      w.files.delete(ROWS)
      w.files.set(PROD, '# producer')
      w.procs.set(ARGV.join(' '), { exitCode: 0 })
    })
    await advance(200_000)
    // the snapshot is older than STALE_MS now: the hooks worker was replaced, and the turn re-arms the timers
    world.now += 100_000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    await advance(200_000)
    // the period armed at boot would have started at 300 s
    expect(starts(world)).toHaveLength(0)
    await advance(100_000)
    expect(starts(world)).toHaveLength(1)
  })
})

describe('sync-status: a stale file counts when the last refresh failed (#123)', () => {
  const ROWS = '/root/.claude/cc-statusline-rows.json'
  const PROD = '/root/.claude/scripts/hooks/sync-status.py'
  const SIDE = '/tmp/claude-side/sync-status.json'
  const ARGV = ['python3', '-I', '-B', PROD, '--print']
  const MIN5 = 300_000
  const behind = FILES['sync-status.behind3.json']!
  /** `behind` is observed at 11:59:30, so 20 minutes on it is 1230 s old: past the 900 s TTL. */
  const AGED_MS = REF_NOW_MS + 20 * 60_000
  /** The same bytes observed at 12:24:30: fresh until 12:39:30. */
  const fresh = behind.split('2026-10-10T11:59:30Z').join('2026-10-10T12:24:30Z')
  type Ctx = Parameters<typeof mountPane>[0]
  type On = Parameters<typeof boot>[1]
  const starts = (world: World) => world.ran.filter(r => r.argv.join(' ') === ARGV.join(' '))
  const logged = (world: World) => world.logged.filter(l => l.to === 'debug').map(l => l.text).join('\n')

  /** The cards and the rendered text of one draw of the pane at 89 columns. */
  const drawn = async ($: Ctx) => {
    const ui = await mountPane($, 89)
    const tree = await ui.drawn()
    await ui.unmount()
    return { parts: paneParts(tree, 89), text: renderTree(tree, 89).join('\n') }
  }
  const errorsIn = (text: string) => Number(/(\d+) errors?\b/.exec(text)?.[1] ?? 0)
  const expectRow = async ($: Ctx, card: RegExp, errors: number) => {
    const { parts, text } = await drawn($)
    expect(cardOf(parts, 'SYNC').body.join('').replace(/\s/g, '')).toMatch(card)
    expect(errorsIn(text)).toBe(errors)
  }

  /** The mod boots at `at` with the SYNC file `file` (none when null); a producer answering `answer` exists unless `answer` is null. */
  const modAt = ($: Ctx, on: On, at: number, file: string | null, answer: Proc | null, extra: (w: World) => void = () => {}) =>
    boot($, on, w => {
      w.now = at
      w.files.delete(ROWS)
      if (file !== null) w.files.set(SIDE, file)
      if (answer !== null) {
        w.files.set(PROD, '# producer')
        w.procs.set(ARGV.join(' '), answer)
      }
      extra(w)
    })

  test('matrix: stale, no refresh has finished yet: not counted', async ($, on) => {
    await modAt($, on, AGED_MS, behind, { exitCode: 2 })
    await expectRow($, /^n\/a（過期/, 0)
  })

  test('matrix: stale, the last refresh was clean: not counted', async ($, on) => {
    const { world, advance } = await modAt($, on, AGED_MS, behind, { exitCode: 0 })
    await advance(MIN5)
    expect(starts(world).length).toBe(1)
    await expectRow($, /^n\/a（過期/, 0)
  })

  test('matrix: stale, the last refresh exited 2: counted one', async ($, on) => {
    const { world, advance } = await modAt($, on, AGED_MS, behind, { exitCode: 2, stderr: 'sync-status: cannot write' })
    await advance(MIN5)
    expect(starts(world).length).toBe(1)
    await expectRow($, /^n\/a（過期/, 1)
  })

  test('matrix: stale, the last refresh timed out (the host ends the run): counted one', async ($, on) => {
    const { world, advance } = await modAt(
      $,
      on,
      AGED_MS,
      behind,
      new Error('status-pane: $.process.run(python3) aborted: still running after 30000 ms'),
    )
    await advance(MIN5)
    expect(starts(world).length).toBe(1)
    await expectRow($, /^n\/a（過期/, 1)
  })

  test('matrix: stale, the last refresh could not spawn python3: counted one', async ($, on) => {
    const { world, advance } = await modAt($, on, AGED_MS, behind, new Error('status-pane: $.process.run(python3) spawn python3 ENOENT'))
    await advance(MIN5)
    expect(starts(world).length).toBe(1)
    await expectRow($, /^n\/a（過期/, 1)
  })

  test('matrix: stale, the producer file is missing: counted one, and the reason is in the debug log', async ($, on) => {
    const { world, advance } = await modAt($, on, AGED_MS, behind, null)
    await advance(MIN5)
    expect(starts(world).length).toBe(0)
    expect(logged(world)).toMatch(/producer missing/)
    await expectRow($, /^n\/a（過期/, 1)
  })

  test('matrix: stale, neither CLAUDE_CONFIG_DIR nor HOME is set: counted one', async ($, on) => {
    const { world, advance } = await modAt($, on, AGED_MS, behind, { exitCode: 0 }, w => {
      delete w.env.HOME
    })
    // without HOME other rows read n/a too, so the count is taken as the change the stale file makes
    const before = errorsIn((await drawn($)).text)
    await advance(MIN5)
    expect(starts(world).length).toBe(0)
    expect(logged(world)).toMatch(/neither CLAUDE_CONFIG_DIR nor HOME/)
    const after = await drawn($)
    expect(cardOf(after.parts, 'SYNC').body.join('').replace(/\s/g, '')).toMatch(/^n\/a（過期/)
    expect(errorsIn(after.text) - before).toBe(1)
  })

  test('matrix: stale, the last refresh exited 1 (the write failed as well): counted one', async ($, on) => {
    const { world, advance } = await modAt($, on, AGED_MS, behind, { exitCode: 1, stdout: 'sync-status: failed\n  error:     git_timeout: slow\n' })
    await advance(MIN5)
    expect(starts(world).length).toBe(1)
    await expectRow($, /^n\/a（過期/, 1)
  })

  test('matrix: a failed run, then a clean run and a fresh file: not counted, and not counted once the file ages again', async ($, on) => {
    const { world, advance } = await modAt($, on, AGED_MS, behind, { exitCode: 2 })
    await advance(MIN5)
    await expectRow($, /^n\/a（過期/, 1)
    world.procs.set(ARGV.join(' '), { exitCode: 0 })
    world.files.set(SIDE, fresh)
    await advance(MIN5)
    await expectRow($, /behind3/, 0)
    // 12:45: the file is 1290 s old again and the last refresh was clean
    await advance(15 * 60_000)
    await expectRow($, /^n\/a（過期/, 0)
  })

  test('matrix: not stale, the last refresh failed: the file decides; an ok file is not counted, a failed file is', async ($, on) => {
    const { world, advance } = await modAt($, on, REF_NOW_MS, behind, { exitCode: 2 })
    await advance(MIN5)
    expect(starts(world).length).toBe(1)
    await expectRow($, /behind3/, 0)
    world.files.set(SIDE, FILES['sync-status.failed.json']!)
    await advance(MIN5)
    await expectRow($, /^n\/a（收集失敗：/, 1)
  })

  test('matrix: a tick skipped for a run still going leaves the outcome as it was', async ($, on) => {
    const { world, advance } = await modAt($, on, AGED_MS, behind, { exitCode: 2 })
    await advance(MIN5)
    await expectRow($, /^n\/a（過期/, 1)
    world.delay.set(`process.run:${ARGV.join(' ')}`, 400_000)
    await advance(MIN5)
    await advance(MIN5)
    expect(starts(world).length).toBe(2)
    expect(logged(world)).toMatch(/still going/)
    await expectRow($, /^n\/a（過期/, 1)
  })

  test('matrix: card off is no attempt and counts nothing; the outcome from before it stands once the card is back', async ($, on) => {
    const { world, advance } = await modAt($, on, AGED_MS, behind, { exitCode: 2 })
    await advance(MIN5)
    await expectRow($, /^n\/a（過期/, 1)
    world.files.set(ROWS, '{"sync":false}')
    await advance(MIN5)
    expect(starts(world).length).toBe(1)
    expect(errorsIn((await drawn($)).text)).toBe(0)
    world.files.delete(ROWS)
    await advance(30_000)
    expect(errorsIn((await drawn($)).text)).toBe(1)
  })

  test('matrix: master switch off is no attempt and counts nothing', async ($, on) => {
    const { world, advance } = await modAt($, on, AGED_MS, behind, { exitCode: 2 })
    await advance(MIN5)
    await expectRow($, /^n\/a（過期/, 1)
    world.files.set(ROWS, '{"enabled":false}')
    await advance(MIN5)
    expect(starts(world).length).toBe(1)
    expect(errorsIn((await drawn($)).text)).toBe(0)
  })

  test('matrix: a missing file is not counted, whatever the last refresh did', async ($, on) => {
    const { world, advance } = await modAt($, on, AGED_MS, null, { exitCode: 2 })
    await advance(MIN5)
    expect(starts(world).length).toBe(1)
    await expectRow($, /^n\/a（缺檔）$/, 0)
  })

  test('matrix, a sleep: a turn that re-arms the timers on a stale snapshot keeps the failure counted', async ($, on) => {
    const { world, advance, clock } = await modAt($, on, AGED_MS, behind, { exitCode: 2 })
    await advance(MIN5)
    await expectRow($, /^n\/a（過期/, 1)
    // the snapshot is older than STALE_MS now, so the turn re-arms the producer's period
    world.now += 100_000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    await expectRow($, /^n\/a（過期/, 1)
  })
})
