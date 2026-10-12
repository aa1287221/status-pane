import { describe, expect, test } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'

import { boot, cardOf, hintText, makeSnap, mountPane, paneView, pinSyncOff } from './fixture'
import { tailText } from './model'
import { layoutTree, paneLayout } from './pane'
import type { Layout } from './pane'
import { FAKE_ELS, findOverflow, paneParts, renderTree } from './tree'
import type { Node } from './tree'
import type { Snap, WaitingItem, WaitingDown } from './state'
import { CAPTURE } from './waiting.fixtures'

// The WAITING card: its layout at the three tiers, its rows, the tail segment, and the side file through the engine.
const REF_NOW = Date.parse('2026-10-10T12:00:00Z')
const DAY = 86_400_000
const ROWS_FILE = '/root/.claude/cc-statusline-rows.json'
const SIDE = '/root/.claude/projects/-project/references/side-files'
const SURFACES: RenderSurface[] = ['terminal', 'desktop', 'vscode', 'mobile']
const WIDTHS = [
  { columns: 36, tier: 'narrow', across: 1 },
  { columns: 49, tier: 'medium', across: 2 },
  { columns: 89, tier: 'wide', across: 3 },
] as const

const sec = (iso: string): number => Date.parse(iso) / 1000
/** Due at REF_NOW: since 7 days and 1 second ago. */
const DUE_SINCE = sec('2026-10-03T11:59:59Z')
/** Not due: three days old. */
const NEW_SINCE = sec('2026-10-07T12:00:00Z')

const item = (over: Partial<WaitingItem> = {}): WaitingItem => ({ id: 'hosta-aaaa0001', host: 'hosta', what: 'a thing to wait for', sinceSec: NEW_SINCE, ...over })
const board = (items: WaitingItem[], down: WaitingDown[] = []) => ({ ok: true as const, v: { items, openTotal: items.length, down, skipped: 0 } })
const snapOf = (items: WaitingItem[], down: WaitingDown[] = []) => makeSnap({ waiting: board(items, down) })

const layoutAt = (snap: Snap, columns: number, nowMs = REF_NOW, tzMin = 0): Layout =>
  paneLayout(snap, { columns, nowMs, tzMin, raster: true, cpuHist: [] })
const cardsAt = (snap: Snap, columns: number, nowMs = REF_NOW, tzMin = 0) =>
  paneParts(layoutTree(layoutAt(snap, columns, nowMs, tzMin), FAKE_ELS) as unknown as Node, columns)
const waitingOf = (snap: Snap, columns = 89, nowMs = REF_NOW, tzMin = 0) => cardOf(cardsAt(snap, columns, nowMs, tzMin), 'WAITING')
const bodyText = (snap: Snap, columns = 89, nowMs = REF_NOW, tzMin = 0) => waitingOf(snap, columns, nowMs, tzMin).body.join('\n')

describe('the WAITING card: layout', () => {
  for (const { columns, tier, across } of WIDTHS) {
    test(`${tier} (bodyColumns ${columns}): a band of one across the width, after ACTIVITY and before SYSTEM`, () => {
      const layout = layoutAt(snapOf([item()]), columns)
      const bands = layout.blocks.flatMap(b => (b.kind === 'cards' ? [b.cards.map(c => `${c.id}:${c.width}`)] : []))
      const at = bands.findIndex(b => b.some(x => x.startsWith('waiting:')))
      expect(bands[at]).toEqual([`waiting:${layout.w}`])
      expect(bands[at - 1]!.map(x => x.split(':')[0])).toContain('activity')
      expect(bands[at + 1]!.map(x => x.split(':')[0])).toContain('system')
      expect(bands.some(b => b.length === across)).toBe(true)
      expect(waitingOf(snapOf([item()]), columns).width).toBe(layout.w)
    })
  }

  test('no waiting field in the snapshot: no card, at every width', () => {
    for (const { columns } of WIDTHS) {
      const ids = layoutAt(makeSnap(), columns).blocks.flatMap(b => (b.kind === 'cards' ? b.cards.map(c => c.id) : []))
      expect(ids).not.toContain('waiting')
    }
  })

  test('the tree fits its room at every width, for the long and the unbreakable', () => {
    const long = item({ what: 'x'.repeat(200) })
    const cjk = item({ what: '等'.repeat(120) })
    const url = item({ what: 'https://example.com/' + 'a'.repeat(40) })
    const reason = 'n/a（' + '讀取失敗原因 '.repeat(20).trim() + '）'
    for (const { columns } of WIDTHS) {
      for (const snap of [snapOf([long]), snapOf([cjk]), snapOf([url]), snapOf([item()], [{ host: 'hostb', text: reason }])]) {
        expect(findOverflow(layoutTree(layoutAt(snap, columns), FAKE_ELS) as unknown as Node, columns)).toEqual([])
      }
    }
  })
})

describe('the WAITING card: title and rows', () => {
  test('one due item: value `1 · 1 due`, the age and start date at the left, DUE at the right, the text below', () => {
    const snap = snapOf([item({ sinceSec: DUE_SINCE, what: 'reply from the vendor' })])
    const card = waitingOf(snap, 89)
    expect(card.value).toBe('1 · 1 due')
    expect(card.body[0]).toMatch(/^7d · 2026-10-03\s+DUE$/)
    expect(card.body[1]).toContain('reply from the vendor')
  })

  test('an open item, not due: value `1`, no DUE flag', () => {
    const card = waitingOf(snapOf([item({ sinceSec: NEW_SINCE })]), 89)
    expect(card.value).toBe('1')
    expect(card.body[0]).toMatch(/^3d · 2026-10-07$/)
  })

  test('a verified-empty board: value 0 and one dim row 沒有登記', () => {
    const card = waitingOf(makeSnap({ waiting: board([]) }), 89)
    expect(card.value).toBe('0')
    expect(card.body).toEqual(['沒有登記'])
  })

  test('n/a for the whole card: the reason in full, the frame kept', () => {
    const card = waitingOf(makeSnap({ waiting: { ok: false, why: 'n/a（目錄無法列出：EACCES）' } }), 36)
    expect(card.body.join('').replace(/\s/g, '')).toBe('n/a（目錄無法列出：EACCES）')
    expect(card.raw[0]).toMatch(/^╭/)
    expect(card.raw.at(-1)).toMatch(/^╰/)
  })

  test('an unreadable host beside items: ≥ in the title, the host row under the items', () => {
    const snap = snapOf([item({ id: 'hosta-aaaa0001' }), item({ id: 'hosta-aaaa0002' }), item({ id: 'hosta-aaaa0003' })], [{ host: 'hostb', text: 'n/a（檔案損毀或被截斷）' }])
    const card = waitingOf(snap, 89)
    expect(card.value).toBe('≥3')
    expect(bodyText(snap)).toContain('hostb n/a（檔案損毀或被截斷）')
  })

  test('nothing readable: the title is —, each unreadable host its own row', () => {
    const snap = makeSnap({ waiting: board([], [{ host: 'hosta', text: 'n/a（缺檔）' }, { host: 'hostb', text: 'n/a（檔案損毀或被截斷）' }]) })
    const card = waitingOf(snap, 89)
    expect(card.value).toBe('—')
    expect(card.body.join('\n')).toContain('hosta n/a（缺檔）')
    expect(card.body.join('\n')).toContain('hostb n/a（檔案損毀或被截斷）')
  })

  test('nothing readable: 沒有登記 is never drawn beside an unreadable host', () => {
    const card = waitingOf(makeSnap({ waiting: board([], [{ host: 'hosta', text: 'n/a（缺檔）' }]) }), 89)
    expect(card.body.join('\n')).not.toContain('沒有登記')
    expect(card.value).toBe('—')
  })

  test('more than 8 items: 8 drawn, then +N more; the title counts them all', () => {
    const items = Array.from({ length: 10 }, (_, i) => item({ id: `hosta-aaaa00${String(i).padStart(2, '0')}`, what: `item ${i}`, sinceSec: NEW_SINCE + i }))
    const card = waitingOf(snapOf(items), 89)
    expect(card.value).toBe('10')
    expect(card.body.at(-1)).toContain('+2 more')
    expect(card.body.filter(line => line.includes('item ')).length).toBe(8)
  })

  test('a long text wraps to 2 rows, the second ending in …; an unbreakable word is broken by cells', () => {
    const body = bodyText(snapOf([item({ what: 'x'.repeat(200) })]), 36)
    expect(body).toContain('…')
    expect(body.split('\n').filter(l => l.includes('x')).length).toBe(2)
  })

  test('CJK-only text wraps by cells, never overflowing the card', () => {
    const snap = snapOf([item({ what: '等'.repeat(120) })])
    expect(findOverflow(layoutTree(layoutAt(snap, 36), FAKE_ELS) as unknown as Node, 36)).toEqual([])
    expect(bodyText(snap, 36)).toContain('等')
  })

  test('the age follows the draw clock: a day later the same snapshot reads 8d and due', () => {
    const snap = snapOf([item({ sinceSec: DUE_SINCE - DAY / 1000 })])
    expect(waitingOf(snap, 89, REF_NOW).body[0]).toMatch(/^8d · 2026-10-02/)
    expect(waitingOf(snap, 89, REF_NOW).value).toBe('1 · 1 due')
    expect(waitingOf(snap, 89, REF_NOW - 2 * DAY).value).toBe('1')
  })

  test('the start date is local: +08:00 shows the next day for 20:00 UTC, UTC shows the same day', () => {
    const snap = snapOf([item({ sinceSec: sec('2026-10-01T20:00:00Z') })])
    expect(waitingOf(snap, 89, REF_NOW, 480).body[0]).toContain('2026-10-02')
    expect(waitingOf(snap, 89, REF_NOW, 0).body[0]).toContain('2026-10-01')
  })

  test('bidi controls inside the text are not drawn', () => {
    const body = bodyText(snapOf([item({ what: 'ab\u202ecd\u200fef' })]))
    expect(body).not.toContain('\u202e')
    expect(body).not.toContain('\u200f')
    expect(body).toContain('abcdef')
  })
})

describe('the WAITING tail segment', () => {
  const tail = (snap: Snap, nowMs = REF_NOW) => tailText(snap, nowMs, 0) ?? ''

  test('3 open items: WAIT 3; with one due: WAIT 3 (1 due); unreadable beside them: WAIT ≥3', () => {
    const three = [item({ id: 'hosta-aaaa0001' }), item({ id: 'hosta-aaaa0002' }), item({ id: 'hosta-aaaa0003', sinceSec: DUE_SINCE })]
    expect(tail(snapOf(three))).toMatch(/^WAIT 3 \(1 due\)/)
    expect(tail(snapOf(three.slice(0, 2)))).toMatch(/^WAIT 2/)
    expect(tail(snapOf(three.slice(0, 2), [{ host: 'hostb', text: 'n/a（缺檔）' }]))).toMatch(/^WAIT ≥2/)
  })

  test('0 open items, or nothing readable: no WAIT segment', () => {
    expect(tail(makeSnap({ waiting: board([]) }))).not.toContain('WAIT')
    expect(tail(makeSnap({ waiting: board([], [{ host: 'hosta', text: 'n/a（缺檔）' }]) }))).not.toContain('WAIT')
    expect(tail(makeSnap({ waiting: { ok: false, why: 'n/a（目錄無法列出）' } }))).not.toContain('WAIT')
  })

  test('the segment is the first one and survives the 48-character trim', () => {
    const snap = makeSnap({ waiting: board([item({ id: 'hosta-aaaa0001' })]) })
    const text = tail(snap)
    expect(text.startsWith('WAIT 1')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(48)
  })

  test('the SYNC segment, when it shows, sits in front of WAIT; each alone leads; the trim drops everything but SYNC before WAIT', () => {
    const toggles = { enabled: true, rows: { ...makeSnap().toggles.rows, sync: true } }
    const sync = (ahead: number, behind: number): Snap['sync'] => ({
      ok: true,
      v: { branch: 'sync-data-v2', upstream: 'origin/sync-data-v2', ahead, behind, lastPushSec: null, lastFetchSec: null, observedAtSec: REF_NOW / 1000 },
    })
    expect(tail(makeSnap({ toggles, sync: sync(0, 3), waiting: board([item()]) }))).toMatch(/^SYNC -3 PULL · WAIT 1 · ctx 3%/)
    expect(tail(makeSnap({ toggles, waiting: board([item()]) }))).toMatch(/^WAIT 1 · ctx 3%/)
    expect(tail(makeSnap({ toggles, sync: sync(0, 3) }))).toMatch(/^SYNC -3 PULL · ctx 3%/)
    // 21 + 3 + 16 characters: not even `ctx 3%` fits behind them
    const due = Array.from({ length: 12 }, (_, i) => item({ id: `hosta-aaaa${String(i + 1).padStart(4, '0')}`, sinceSec: DUE_SINCE }))
    expect(tail(makeSnap({ toggles, sync: sync(1234, 5678), waiting: board(due) }))).toBe('SYNC +999+ -999+ PULL · WAIT 12 (12 due)')
  })

  test('the row off or the master switch off: no segment; a snapshot without the field: none', () => {
    const rows = makeSnap({ waiting: board([item()]) }).toggles.rows
    expect(tail(makeSnap({ waiting: board([item()]), toggles: { enabled: true, rows: { ...rows, waiting: false } } }))).not.toContain('WAIT')
    expect(tail(makeSnap({ waiting: board([item()]), toggles: { enabled: false, rows } }))).toBe('')
    expect(tail(makeSnap({}))).not.toContain('WAIT')
  })
})

describe('the WAITING card: side files through the engine', () => {
  const captured = (w: { files: Map<string, string>; now: number }, hostb = CAPTURE['waiting.hostb.json']!.lines.join('\n') + '\n') => {
    w.now = REF_NOW
    w.files.set(ROWS_FILE, pinSyncOff('{"waiting":true}'))
    w.files.set(`${SIDE}/waiting.hosta.json`, CAPTURE['waiting.hosta.json']!.lines.join('\n') + '\n')
    w.files.set(`${SIDE}/waiting.hostb.json`, hostb)
  }

  test('the captured producer bytes: Y and Z drawn with days and start dates, X hidden, the tail counts 2', async ($, on) => {
    await boot($, on, w => captured(w))
    for (const columns of [36, 49, 89]) {
      const card = cardOf(await paneView($, columns), 'WAITING')
      expect(card.value).toBe('2')
      expect(card.body.join('\n')).toContain('1d · 2026-10-09')
      expect(card.body.join('\n')).toContain('Y waiting')
      expect(card.body.join('\n')).toContain('Z waiting')
      expect(card.body.join('\n')).not.toContain('X waiting')
    }
    expect(await hintText($)).toContain('WAIT 2')
  })

  test('a day past 7 days the same captured board shows both as due', async ($, on) => {
    await boot($, on, w => {
      captured(w)
      w.now = REF_NOW + 7 * DAY
    })
    const card = cardOf(await paneView($, 89), 'WAITING')
    expect(card.value).toBe('2 · 2 due')
    expect(await hintText($)).toContain('WAIT 2 (2 due)')
  })

  test('the producer control: flipping hostb closer to open brings X back, so the sample discriminates', async ($, on) => {
    const hostb = CAPTURE['waiting.hostb.json']!.lines.join('\n').replace('"state": "closed"', '"state": "open"') + '\n'
    await boot($, on, w => captured(w, hostb))
    expect(cardOf(await paneView($, 89), 'WAITING').body.join('\n')).toContain('X waiting')
  })

  test('the rows file switches the card and its segment off: no side file is read', async ($, on) => {
    const { world } = await boot($, on, w => {
      captured(w)
      w.files.set(ROWS_FILE, '{"waiting":false}')
    })
    expect((await paneView($, 89)).cards.map(c => c.title)).not.toContain('WAITING')
    expect(world.reads.filter(p => p.includes('side-files'))).toEqual([])
    expect(await hintText($)).not.toContain('WAIT')
  })

  test('the master switch off collects nothing', async ($, on) => {
    const { world } = await boot($, on, w => {
      captured(w)
      w.files.set(ROWS_FILE, '{"enabled":false}')
    })
    expect(world.reads.filter(p => p.includes('side-files'))).toEqual([])
  })

  test('CLAUDE_CONFIG_DIR is honoured: the card reads /alt/cfg and never /root/.claude', async ($, on) => {
    const { world } = await boot($, on, w => {
      captured(w)
      w.env.CLAUDE_CONFIG_DIR = '/alt/cfg'
      w.files.set(`/alt/cfg/projects/-project/references/side-files/waiting.hosta.json`, CAPTURE['waiting.hosta.json']!.lines.join('\n') + '\n')
    })
    const card = cardOf(await paneView($, 89), 'WAITING')
    // alt dir has only hosta's file: X stays open (since 10-01, due) and Y is open; Z lives in the other dir
    expect(card.value).toBe('2 · 1 due')
    expect(card.body.join('\n')).toContain('X waiting')
    expect(card.body.join('\n')).not.toContain('Z waiting')
    expect(world.reads.filter(p => p.includes('side-files')).every(p => p.startsWith('/alt/cfg/'))).toBe(true)
  })

  test('a refused CLAUDE_CONFIG_DIR read: only the WAITING card is n/a with the reason', async ($, on) => {
    await boot($, on, w => {
      captured(w)
      w.denyEnv.add('CLAUDE_CONFIG_DIR')
    })
    const parts = await paneView($, 89)
    expect(cardOf(parts, 'WAITING').body.join('')).toContain('n/a')
    expect(cardOf(parts, 'CONTEXT').value).toBe('3%')
  })

  test('a refused directory listing: the card is one n/a, the others stay, one error is counted', async ($, on) => {
    await boot($, on, w => {
      captured(w)
      w.denyList.add(SIDE)
    })
    const parts = await paneView($, 89)
    expect(cardOf(parts, 'WAITING').body.join('').replace(/\s/g, '')).toContain('n/a（目錄無法列出')
    expect(cardOf(parts, 'CONTEXT').value).toBe('3%')
    const lines = renderTree(await mountPane($, 89).then(u => u.drawn()), 89).join('\n')
    expect(lines).toMatch(/1 error\b/)
  })

  test('a healthy board adds no error', async ($, on) => {
    await boot($, on, w => captured(w))
    const lines = renderTree(await mountPane($, 89).then(u => u.drawn()), 89).join('\n')
    expect(lines).not.toMatch(/\d+ errors?\b/)
  })

  test('the row on and no side-files dir at all: the card is drawn, reads 0 and says 沒有登記', async ($, on) => {
    await boot($, on, w => {
      w.now = REF_NOW
      w.files.set(ROWS_FILE, '{"waiting":true}')
    })
    const card = cardOf(await paneView($, 89), 'WAITING')
    expect(card.value).toBe('0')
    expect(card.body).toEqual(['沒有登記'])
  })

  test('on by default: with no rows file, an empty synced dir shows 0 and 沒有登記', async ($, on) => {
    await boot($, on, w => {
      w.now = REF_NOW
      w.files.delete(ROWS_FILE)
    })
    const parts = await paneView($, 89)
    expect(parts.cards.map(c => c.title)).toContain('WAITING')
    expect(cardOf(parts, 'WAITING').value).toBe('0')
    expect(cardOf(parts, 'WAITING').body).toEqual(['沒有登記'])
    expect(await hintText($)).not.toContain('WAIT')
  })

  test('on by default: a rows file that does not name waiting keeps the card and its tail segment', async ($, on) => {
    await boot($, on, w => {
      captured(w)
      w.files.set(ROWS_FILE, '{"summary":true}')
    })
    const parts = await paneView($, 89)
    expect(parts.cards.map(c => c.title)).toContain('WAITING')
    expect(cardOf(parts, 'WAITING').value).toBe('2')
    expect(await hintText($)).toContain('WAIT 2')
  })
})

// Keep the surfaces list referenced so every surface is covered by the engine tests above.
export const ALL_SURFACES = SURFACES
