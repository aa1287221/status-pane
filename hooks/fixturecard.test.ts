import { describe, expect, test } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'

import { FILES } from './sidefile.fixtures'
import { boot, cardOf, makeSnap, mountPane, pair, paneView, pinSyncOff } from './fixture'
import { fmtClock } from './model'
import { layoutTree, paneLayout } from './pane'
import type { Layout } from './pane'
import { FAKE_ELS, findOverflow, paneParts, renderTree } from './tree'
import type { Node } from './tree'

// The minimal card that proves the whole path: side file -> reader -> card, at the three layouts of the pane.
const ROWS_FILE = '/root/.claude/cc-statusline-rows.json'
const PATH = '/tmp/claude-side/fixture.json'
const REF_NOW = Date.parse('2026-10-10T12:00:00Z')
const SURFACES: RenderSurface[] = ['terminal', 'desktop', 'vscode', 'mobile']
const WIDTHS = [
  { columns: 36, tier: 'narrow', across: 1 },
  { columns: 49, tier: 'medium', across: 2 },
  { columns: 89, tier: 'wide', across: 3 },
] as const

const okSnap = (count = 3, observedAtSec = Date.parse('2026-10-10T11:59:30Z') / 1000) =>
  makeSnap({ fixture: { ok: true, v: { count, observedAtSec } } })
const naSnap = (text: string) => makeSnap({ fixture: { ok: false, why: text } })

const layoutAt = (snap: ReturnType<typeof makeSnap>, columns: number): Layout =>
  paneLayout(snap, { columns, nowMs: REF_NOW, tzMin: 0, raster: true, cpuHist: [] })
const treeAt = (snap: ReturnType<typeof makeSnap>, columns: number) => layoutTree(layoutAt(snap, columns), FAKE_ELS) as unknown as Node
const cardsAt = (snap: ReturnType<typeof makeSnap>, columns: number) => paneParts(treeAt(snap, columns), columns)

describe('the fixture card: layout', () => {
  for (const { columns, tier, across } of WIDTHS) {
    test(`${tier} (bodyColumns ${columns}): a card of its own across the whole width, titled FIXTURE with the count`, () => {
      const layout = layoutAt(okSnap(), columns)
      const w = layout.w
      expect(layout.tier).toBe(tier)
      // the band the other cards sit in has `across` cards on this tier; the fixture card is a band of one at full width
      const bands = layout.blocks.flatMap(b => (b.kind === 'cards' ? [b.cards.map(c => `${c.id}:${c.width}`)] : []))
      expect(bands.map(b => b.length)).toContain(across)
      expect(bands.at(-1)).toEqual([`fixture:${w}`])
      const card = cardOf(cardsAt(okSnap(), columns), 'FIXTURE')
      expect(card.width).toBe(w)
      expect(card.value).toBe('3')
      expect(card.body).toEqual([
        pair('count', '3', w - 4),
        pair('age', '30s', w - 4),
        pair('observed', fmtClock(Date.parse('2026-10-10T11:59:30Z'), 0, true), w - 4),
      ])
    })

    test(`${tier}: the tree fits its room and shows nothing wider than the card`, () => {
      for (const snap of [okSnap(), okSnap(123_456_789), naSnap('n/a（過期 4h）'), naSnap('n/a（收集失敗：' + 'x'.repeat(190) + '，從未成功）')]) {
        expect(findOverflow(treeAt(snap, columns), columns)).toEqual([])
      }
    })
  }

  test('no fixture field in the snapshot: no card, at every width', () => {
    for (const { columns } of WIDTHS) {
      expect(layoutAt(makeSnap(), columns).blocks.flatMap(b => (b.kind === 'cards' ? b.cards.map(c => c.id) : []))).not.toContain('fixture')
    }
  })

  test('the card is the last band: SYSTEM and the footer keep their place above it', () => {
    const ids = layoutAt(okSnap(), 89).blocks.flatMap(b => (b.kind === 'cards' ? b.cards.map(c => c.id) : []))
    expect(ids.slice(-2)).toEqual(['system', 'fixture'])
  })

  test('n/a keeps the frame and says why in full; no count, no age rows', () => {
    for (const { columns } of WIDTHS) {
      const card = cardOf(cardsAt(naSnap('n/a（缺檔）'), columns), 'FIXTURE')
      expect(card.value).toBe('')
      expect(card.body.join('').replace(/\s/g, '')).toBe('n/a（缺檔）')
      expect(card.raw[0]).toMatch(/^╭/)
      expect(card.raw.at(-1)).toMatch(/^╰/)
    }
  })

  test('a long reason is wrapped over rows and read whole', () => {
    const why = 'n/a（收集失敗：' + 'ssh to s8p-01 timed out after 10 s '.repeat(4).trim() + '，從未成功）'
    const card = cardOf(cardsAt(naSnap(why), 36), 'FIXTURE')
    expect(card.body.length).toBeGreaterThan(1)
    expect(card.body.join('').replace(/\s/g, '')).toBe(why.replace(/\s/g, ''))
  })

  test('the age follows the clock of the draw, not of the refresh', () => {
    const at = (nowMs: number) =>
      cardOf(paneParts(layoutTree(paneLayout(okSnap(), { columns: 49, nowMs, tzMin: 0, raster: true, cpuHist: [] }), FAKE_ELS) as unknown as Node, 49), 'FIXTURE').body[1]
    expect(at(REF_NOW)).toContain('30s')
    expect(at(REF_NOW + 90_000)).toContain('2m')
    // an observation a moment ahead of this clock reads age 0, never negative
    expect(at(REF_NOW - 60_000)).toContain('0s')
  })

  test('a snapshot with a count that is not a number cannot make the draw throw', () => {
    const odd = makeSnap({ fixture: { ok: true, v: { count: NaN, observedAtSec: NaN } } })
    expect(() => renderTree(treeAt(odd, 49), 49)).not.toThrow()
  })
})

describe('the fixture card: side file to card through the engine', () => {
  const valid = FILES['fixture.valid.json']!
  const withFile = (text: string | null, rows = '{"fixture":true}') => (w: { files: Map<string, string>; now: number }) => {
    w.now = REF_NOW
    w.files.set(ROWS_FILE, pinSyncOff(rows))
    if (text !== null) w.files.set(PATH, text)
  }

  for (const { columns, tier } of WIDTHS) {
    // load 68 in the whole-suite run: 3.6 s (5 s limit); 15 s here, the assertions are unchanged
    test(`${tier} (bodyColumns ${columns}): the count of a fresh file, on every surface`, { timeoutMs: 15_000 }, async ($, on) => {
      await boot($, on, withFile(valid))
      for (const surface of SURFACES) {
        const parts = await paneView($, columns, surface)
        const card = cardOf(parts, 'FIXTURE')
        expect(card.value).toBe('3')
        expect(card.body[0]).toMatch(/^count +3$/)
        expect(card.body[1]).toMatch(/^age +30s$/)
        expect(card.width).toBe(columns - 2)
      }
    })
  }

  const CASES: [string, string | null, string][] = [
    ['missing', null, 'n/a（缺檔）'],
    ['truncated', FILES['fixture.truncated.json']!, 'n/a（檔案損毀或被截斷）'],
    ['stale', FILES['fixture.stale.json']!, 'n/a（過期4h）'],
    ['malformed', FILES['fixture.malformed.json']!, 'n/a（格式錯誤：collection_status'],
    ['unsupported-version', FILES['fixture.unsupported-version.json']!, 'n/a（版本不支援：v2）'],
    ['failed', FILES['fixture.failed.json']!, 'n/a（收集失敗：ssh'],
    ['emoji-message', FILES['fixture.emoji-message.json']!, 'n/a（收集失敗：'],
    ['c1-control', FILES['fixture.c1-control.json']!, 'n/a（格式錯誤：error.message'],
    ['version-float', FILES['fixture.version-float.json']!, 'n/a（格式錯誤：schema_version'],
    ['bad-date', FILES['fixture.bad-date.json']!, 'n/a（格式錯誤：observed_at'],
    ['year-zero', FILES['fixture.year-zero.json']!, 'n/a（格式錯誤：observed_at'],
    ['hour-24', FILES['fixture.hour-24.json']!, 'n/a（格式錯誤：observed_at'],
  ]
  const HIDDEN: Record<string, string> = { stale: '7', malformed: '99', 'version-float': '31', 'bad-date': '41', 'year-zero': '42', 'hour-24': '43' }
  for (const [name, text, expected] of CASES) {
    test(`case ${name} reaches the card as its contract text, with no count, age or clock rows`, async ($, on) => {
      await boot($, on, withFile(text))
      const card = cardOf(await paneView($, 89), 'FIXTURE')
      const body = card.body.join('').replace(/\s/g, '')
      expect(card.value).toBe('')
      expect(body.startsWith(expected)).toBe(true)
      expect(card.body.some(l => /^(count|age|observed) /.test(l))).toBe(false)
      // a long reason is read to its end, not cut
      if (name === 'failed' || name === 'emoji-message') expect(body.endsWith('前）')).toBe(true)
      // the number the file holds but the reader must not show
      const hidden = HIDDEN[name]
      if (hidden) expect(new RegExp(`(?<![\\d:.])${hidden}(?![\\d:.%hms])`).test(card.raw.join('\n'))).toBe(false)
    })
  }

  test('off by default: no card, and the side file is never read', async ($, on) => {
    const { world } = await boot($, on, w => {
      w.now = REF_NOW
      w.files.set(PATH, valid)
    })
    expect((await paneView($, 89)).cards.map(c => c.title)).not.toContain('FIXTURE')
    expect(world.reads).not.toContain(PATH)
  })

  test('switched off in the rows file: the same', async ($, on) => {
    const { world } = await boot($, on, withFile(valid, '{"fixture":false}'))
    expect((await paneView($, 89)).cards.map(c => c.title)).not.toContain('FIXTURE')
    expect(world.reads).not.toContain(PATH)
  })

  test('a file that exists but cannot be read is corrupt, the other cards draw, one error is counted', async ($, on) => {
    await boot($, on, w => {
      withFile(valid)(w)
      w.denyRead.add(PATH)
    })
    const parts = await paneView($, 89)
    expect(cardOf(parts, 'FIXTURE').body.join('').replace(/\s/g, '')).toBe('n/a（檔案損毀或被截斷）')
    expect(cardOf(parts, 'CONTEXT').value).toBe('3%')
  })

  test('TMPDIR is honoured: the file is where the contract says', async ($, on) => {
    await boot($, on, w => {
      withFile(null)(w)
      w.env.TMPDIR = '/var/tmp/'
      w.files.set('/var/tmp/claude-side/fixture.json', valid)
    })
    expect(cardOf(await paneView($, 89), 'FIXTURE').value).toBe('3')
  })

  test('a failing fixture counts as one error, like any row that is on', async ($, on) => {
    await boot($, on, withFile(null))
    const lines = renderTree(await mountPane($, 89).then(u => u.drawn()), 89).join('\n')
    expect(lines).toMatch(/1 error\b/)
  })

  test('a stale fixture counts as one error too: only the SYNC card leaves a missing or a stale file out', async ($, on) => {
    await boot($, on, withFile(FILES['fixture.stale.json']!))
    const lines = renderTree(await mountPane($, 89).then(u => u.drawn()), 89).join('\n')
    expect(lines).toMatch(/1 error\b/)
  })

  test('a healthy fixture adds no error', async ($, on) => {
    await boot($, on, withFile(valid))
    const lines = renderTree(await mountPane($, 89).then(u => u.drawn()), 89).join('\n')
    expect(lines).not.toMatch(/\d+ errors?\b/)
  })

  test('the master switch collects nothing, the fixture included', async ($, on) => {
    const { world } = await boot($, on, withFile(valid, '{"enabled":false,"fixture":true}'))
    expect(world.reads).not.toContain(PATH)
  })

  test('a file past 64 KiB is corrupt and is never read', async ($, on) => {
    const { world } = await boot($, on, w => {
      withFile(valid.replace('"data"', `"pad":"${'x'.repeat(70_000)}","data"`))(w)
    })
    expect(cardOf(await paneView($, 89), 'FIXTURE').body.join('').replace(/\s/g, '')).toBe('n/a（檔案損毀或被截斷）')
    expect(world.reads).not.toContain(PATH)
  })

  test('bidi controls in a reason are not drawn', () => {
    const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c].map(c => String.fromCodePoint(c)).join('')
    const text = `n/a（收集失敗：a${bidi}b）`
    const raw = JSON.stringify(cardsAt(naSnap(text), 89))
    expect(raw).toContain('ab')
    for (const ch of bidi) expect(raw.includes(ch)).toBe(false)
  })
})
