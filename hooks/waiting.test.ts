import { describe, expect, test } from 'claude-code/testing'

import { CAPTURE, HUB, HUB_COMMIT, bytesOf } from './waiting.fixtures'
import { collectWaiting, itemsOf, mergeBoard, waitingHead, waitingView } from './waiting'
import type { WaitingIo } from './waiting'
import { readSideFile } from './sidefile'
import type { SideOk } from './sidefile'

// SCHEMA.md section 9 `waiting`, 7.1 merge. The reference now is the hub's: 2026-10-10T12:00:00Z.
const NOW = Date.parse('2026-10-10T12:00:00Z')
const DIR = '/root/.claude/projects/-project/references/side-files'
const LOC = { home: '/root/.claude' }

const encode = (text: string | Uint8Array): Uint8Array => (typeof text === 'string' ? new TextEncoder().encode(text) : text)

/** A fake synced dir: `reads` records every file the reader opened, `list` can be refused. */
const fakeIo = (files: Record<string, string | Uint8Array>, opts: { denyList?: boolean } = {}) => {
  const store = new Map(Object.entries(files).map(([name, v]) => [`${DIR}/${name}`, encode(v)]))
  const reads: string[] = []
  const io: WaitingIo & { reads: string[] } = {
    reads,
    exists: async p => store.has(p) || [...store.keys()].some(k => k.startsWith(`${p}/`)),
    readBytes: async p => {
      reads.push(p)
      const b = store.get(p)
      if (!b) throw new Error(`ENOENT: no such file or directory, open '${p}'`)
      return b
    },
    list: async p => {
      if (opts.denyList) throw new Error(`EACCES: permission denied, scandir '${p}'`)
      return [...store.keys()].filter(k => k.startsWith(`${p}/`)).map(k => ({ name: k.slice(p.length + 1) }))
    },
  }
  return io
}

const hubFiles = (): Record<string, Uint8Array> => ({
  'waiting.hosta.json': bytesOf(HUB['waiting.hosta.json']!.lines),
  'waiting.hostb.json': bytesOf(HUB['waiting.hostb.json']!.lines),
})

const item = (over: Record<string, unknown> = {}) => ({
  id: 'hosta-aaaa0009',
  state: 'open',
  updated_at: '2026-10-10T06:00:00Z',
  since: '2026-10-09T06:00:00Z',
  what: 'a thing to wait for',
  links: [],
  closed_at: null,
  closed_by: null,
  ...over,
})

/** A `waiting` side file: the envelope SCHEMA.md section 2 asks for, with `items` as given. */
const envelope = (host: string, items: unknown, observed = '2026-10-10T12:00:00Z'): string =>
  JSON.stringify(
    {
      schema_version: 1,
      kind: 'waiting',
      producer: { id: 'waiting', host },
      station: null,
      run_id: null,
      observed_at: observed,
      last_success_at: observed,
      collection_status: 'ok',
      error: null,
      data: { items },
    },
    null,
    2,
  )

/** The one-host board whose only item is `over`: the reader's verdict on that item. */
const oneItem = (over: Record<string, unknown>) => collectWaiting(fakeIo({ 'waiting.hosta.json': envelope('hosta', [item(over)]) }), LOC, NOW)

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')

/** The per-host items the merge sees: each file through the reader and the item rules. */
const perHostOf = async (files: Record<string, Uint8Array>) => {
  const io = fakeIo(files)
  const out: { host: string; items: NonNullable<ReturnType<typeof itemsOf>['v']> }[] = []
  for (const name of Object.keys(files).sort()) {
    const r = await readSideFile(io, `${DIR}/${name}`, NOW)
    if (r.verdict !== 'ok') throw new Error(`${name} is ${r.verdict}`)
    const its = itemsOf(r as SideOk)
    if (!its.ok) throw new Error(its.why)
    out.push({ host: r.producer.host, items: its.v })
  }
  return out
}

describe('hub copies (drift guard)', () => {
  test('each embedded hub copy matches its pinned sha256 and EXPECTED.json is the file it says', async () => {
    expect(HUB_COMMIT).toBe('7b88598c6c18c38d90209ab39e9d3ae4a22f5b4c')
    for (const name of ['EXPECTED.json', 'waiting.hosta.json', 'waiting.hostb.json']) {
      expect(await sha256(bytesOf(HUB[name]!.lines))).toBe(HUB[name]!.sha256)
    }
    expect(JSON.parse(bytesOf(HUB['EXPECTED.json']!.lines)).reference.now).toBe('2026-10-10T12:00:00Z')
  })

  test('guard: a one-byte edit of an embedded copy changes its hash', async () => {
    const bytes = bytesOf(HUB['waiting.hosta.json']!.lines)
    const edited = bytes.slice()
    edited[edited.length - 3] = edited[edited.length - 3]! ^ 1
    expect(await sha256(edited)).not.toBe(HUB['waiting.hosta.json']!.sha256)
  })
})

describe('merge against the hub EXPECTED.json (SCHEMA 7.1)', () => {
  test('the merged set and winners match EXPECTED.json', async () => {
    const expected = JSON.parse(bytesOf(HUB['EXPECTED.json']!.lines)).merged as { id: string; state: string; source_host: string }[]
    const merged = mergeBoard(await perHostOf(hubFiles()))
    for (const e of expected) {
      const m = merged.find(x => x.id === e.id)
      expect(m && { id: m.id, state: m.state, source_host: m.host }).toEqual({ id: e.id, state: e.state, source_host: e.source_host })
    }
    expect(merged.length).toBe(expected.length)
  })

  test('closed wins even though the closer updated_at is older than the open copy (0001 hidden)', async () => {
    const data = await collectWaiting(fakeIo(hubFiles()), LOC, NOW)
    expect(data.items.map(i => i.id)).not.toContain('hosta-aaaa0001')
  })

  test('equal updated_at: the larger host wins (0003 from hostb)', async () => {
    const data = await collectWaiting(fakeIo(hubFiles()), LOC, NOW)
    expect(data.items.find(i => i.id === 'hosta-aaaa0003')?.host).toBe('hostb')
  })

  test('due is strictly more than 7 days: 0005 (604801 s) due, 0004 (604800 s) not due, 0003 due', async () => {
    const data = await collectWaiting(fakeIo(hubFiles()), LOC, NOW)
    const rows = waitingView(data, NOW, 0).rows
    expect(rows.find(r => r.id === 'hosta-aaaa0005')?.due).toBe(true)
    expect(rows.find(r => r.id === 'hosta-aaaa0004')?.due).toBe(false)
    expect(rows.find(r => r.id === 'hosta-aaaa0003')?.due).toBe(true)
  })

  test('the newer updated_at wins for 0002, and hostb-bbbb0001 appears only from hostb; the card reads 5 · 2 due', async () => {
    const data = await collectWaiting(fakeIo(hubFiles()), LOC, NOW)
    expect(data.items.map(i => i.id)).toEqual(['hosta-aaaa0003', 'hosta-aaaa0005', 'hosta-aaaa0004', 'hosta-aaaa0002', 'hostb-bbbb0001'])
    expect(data.items.find(i => i.id === 'hosta-aaaa0002')?.what).toBe('newer text on A')
    expect(waitingHead(waitingView(data, NOW, 0))).toEqual({ count: '5', dueText: '2 due' })
  })
})

describe('reader, name filter and cap', () => {
  test('control: the unmodified hub files are ok', async () => {
    const data = await collectWaiting(fakeIo(hubFiles()), LOC, NOW)
    expect(data.down).toEqual([])
  })

  test('names outside the grammar are never opened; waiting.hosta.json is', async () => {
    const io = fakeIo({
      'waiting.json': '{}',
      'waiting.a.b.json': '{}',
      '.waiting.hosta.json.x1.tmp': '{}',
      'other.hosta.json': '{}',
      'waiting.hosta.json.bak': '{}',
      'waiting.hosta.json': envelope('hosta', [item()]),
    })
    await collectWaiting(io, LOC, NOW)
    expect(io.reads).toEqual([`${DIR}/waiting.hosta.json`])
  })

  test('name vs content: a file named for hosta whose producer is hostb is n/a', async () => {
    const data = await collectWaiting(fakeIo({ 'waiting.hosta.json': envelope('hostb', [item()]) }), LOC, NOW)
    expect(data.down).toEqual([{ host: 'hosta', text: 'n/a（格式錯誤：檔名的 host 不等於 producer.host）' }])
  })

  test('more than 16 matching files: 16 read, the rest counted as skipped', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 17; i++) files[`waiting.h${String(i).padStart(2, '0')}.json`] = envelope(`h${String(i).padStart(2, '0')}`, [])
    const io = fakeIo(files)
    const data = await collectWaiting(io, LOC, NOW)
    expect(io.reads.length).toBe(16)
    expect(data.skipped).toBe(1)
  })

  test('100+ open items: the snapshot keeps 100, the title shows the true total', async () => {
    const items = Array.from({ length: 105 }, (_, i) => item({ id: `hosta-${(0xa0000000 + i).toString(16)}`, since: '2026-10-01T00:00:00Z' }))
    const data = await collectWaiting(fakeIo({ 'waiting.hosta.json': envelope('hosta', items) }), LOC, NOW)
    expect(data.items.length).toBe(100)
    expect(data.openTotal).toBe(105)
    expect(waitingHead(waitingView(data, NOW, 0)).count).toBe('105')
  })

  test('a list refused: the collector throws with the reason, nothing is read', async () => {
    const io = fakeIo({ 'waiting.hosta.json': envelope('hosta', [item()]) }, { denyList: true })
    await expect(collectWaiting(io, LOC, NOW)).rejects.toThrow('目錄無法列出')
    expect(io.reads).toEqual([])
  })

  test('a file that vanishes between list and read is n/a（缺檔）, no throw', async () => {
    const io = fakeIo({ 'waiting.hosta.json': envelope('hosta', [item()]) })
    const real = io.readBytes
    io.readBytes = async p => {
      if (p.endsWith('waiting.hosta.json')) throw new Error('ENOENT')
      return real(p)
    }
    const data = await collectWaiting(io, LOC, NOW)
    expect(data.down).toEqual([{ host: 'hosta', text: 'n/a（檔案損毀或被截斷）' }])
  })
})

describe('AC1 empty states', () => {
  test('(a) dir absent: 0 and no 沒有登記 text is needed in the data (the card says it)', async () => {
    const data = await collectWaiting(fakeIo({}), LOC, NOW)
    expect(data).toEqual({ items: [], openTotal: 0, down: [], skipped: 0 })
    expect(waitingHead(waitingView(data, NOW, 0))).toEqual({ count: '0', dueText: null })
  })

  test('(b) only non-matching names: verified empty', async () => {
    const data = await collectWaiting(fakeIo({ 'waiting.json': '{}', 'other.x.json': '{}' }), LOC, NOW)
    expect(waitingHead(waitingView(data, NOW, 0))).toEqual({ count: '0', dueText: null })
  })

  test('(c) every present host ok with no open items: 0', async () => {
    const data = await collectWaiting(fakeIo({ 'waiting.hosta.json': envelope('hosta', []) }), LOC, NOW)
    expect(waitingHead(waitingView(data, NOW, 0))).toEqual({ count: '0', dueText: null })
  })

  test('(d) all items closed: 0', async () => {
    const closed = item({ state: 'closed', closed_at: '2026-10-09T00:00:00Z', closed_by: 'hosta' })
    const data = await collectWaiting(fakeIo({ 'waiting.hosta.json': envelope('hosta', [closed]) }), LOC, NOW)
    expect(waitingHead(waitingView(data, NOW, 0))).toEqual({ count: '0', dueText: null })
  })

  test('false-green control: hosta ok and empty, hostb truncated gives title — and the row, never 0', async () => {
    const data = await collectWaiting(fakeIo({ 'waiting.hosta.json': envelope('hosta', []), 'waiting.hostb.json': '{"schema_ver' }), LOC, NOW)
    expect(data.down).toEqual([{ host: 'hostb', text: 'n/a（檔案損毀或被截斷）' }])
    expect(waitingHead(waitingView(data, NOW, 0))).toEqual({ count: '—', dueText: null })
  })

  test('the same case with hostb valid and empty is 0: the sample discriminates', async () => {
    const data = await collectWaiting(fakeIo({ 'waiting.hosta.json': envelope('hosta', []), 'waiting.hostb.json': envelope('hostb', []) }), LOC, NOW)
    expect(waitingHead(waitingView(data, NOW, 0))).toEqual({ count: '0', dueText: null })
  })

  test('mixed: hosta has 3 open items, hostb unreadable: 3 items, title ≥3', async () => {
    const three = [item({ id: 'hosta-aaaa0001' }), item({ id: 'hosta-aaaa0002' }), item({ id: 'hosta-aaaa0003' })]
    const data = await collectWaiting(fakeIo({ 'waiting.hosta.json': envelope('hosta', three), 'waiting.hostb.json': '' }), LOC, NOW)
    expect(data.items.length).toBe(3)
    expect(data.down).toEqual([{ host: 'hostb', text: 'n/a（檔案損毀或被截斷）' }])
    expect(waitingHead(waitingView(data, NOW, 0))).toEqual({ count: '≥3', dueText: null })
  })
})

describe('item rules (SCHEMA 9): each violation makes that host n/a with its reason', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['what missing', { what: undefined }, '缺少 what'],
    ['what empty', { what: '' }, 'what 不是 1 到 200 個字元'],
    ['what 201 code points', { what: 'a'.repeat(201) }, 'what 不是 1 到 200 個字元'],
    ['what contains U+0085', { what: 'ab\u0085c' }, 'what 含控制字元'],
    ['what contains U+2028', { what: 'ab c' }, 'what 含控制字元'],
    ['what whitespace-only', { what: '   　 ' }, 'what 只有空白'],
    ['links 6 entries', { links: Array.from({ length: 6 }, () => 'https://example.com/a') }, 'links 超過 5 個'],
    ['links with credentials', { links: ['https://u:p@e.com'] }, 'links[0] 不是 http(s) URL'],
    ['links javascript scheme', { links: ['javascript:x'] }, 'links[0] 不是 http(s) URL'],
    ['links 301 chars', { links: ['https://e.com/' + 'a'.repeat(285)] }, 'links[0] 超過 300 個字元'],
    ['links with a space', { links: ['https://e.com/a b'] }, 'links[0] 不是 http(s) URL'],
    ['bad id (x-1)', { id: 'x-1' }, 'id 格式不合'],
    ['bad id (uppercase hex)', { id: 'hosta-AAAA0001' }, 'id 格式不合'],
    ['state pending', { state: 'pending' }, 'state 不是 open 或 closed'],
    ['since 2026-02-30', { since: '2026-02-30T00:00:00Z' }, 'since 不是真實存在的時刻'],
    ['closed without closed_at', { state: 'closed', closed_at: null, closed_by: 'hosta' }, 'closed 項目缺 closed_at'],
    ['missing key links', { links: undefined }, '缺少 links'],
  ]
  for (const [name, over, reason] of cases) {
    test(`${name}: n/a with the reason`, async () => {
      const data = await oneItem(over)
      expect(data.down.length).toBe(1)
      expect(data.down[0]!.text).toContain('格式錯誤')
      expect(data.down[0]!.text).toContain(reason)
    })
  }

  test('200 code points of emoji are accepted (code points, not UTF-16 units)', async () => {
    const data = await oneItem({ what: '🙂'.repeat(200) })
    expect(data.down).toEqual([])
    expect(data.items.length).toBe(1)
  })

  test('a duplicate id inside one file is n/a', async () => {
    const data = await collectWaiting(fakeIo({ 'waiting.hosta.json': envelope('hosta', [item(), item()]) }), LOC, NOW)
    expect(data.down[0]!.text).toContain('與前面重複')
  })

  test('unknown keys are ignored', async () => {
    const data = await oneItem({ extra: 'fine' })
    expect(data.down).toEqual([])
  })
})

describe('the clock and the reader order', () => {
  test('observed_at exactly 300 s ahead is tolerated; 301 s ahead is n/a（時鐘超前）', async () => {
    const at300 = new Date(NOW + 300_000).toISOString().replace('.000', '')
    const at301 = new Date(NOW + 301_000).toISOString().replace('.000', '')
    expect((await collectWaiting(fakeIo({ 'waiting.hosta.json': envelope('hosta', [item()], at300) }), LOC, NOW)).down).toEqual([])
    const late = await collectWaiting(fakeIo({ 'waiting.hosta.json': envelope('hosta', [item()], at301) }), LOC, NOW)
    expect(late.down).toEqual([{ host: 'hosta', text: 'n/a（格式錯誤：時鐘超前）' }])
  })

  test('a clock-ahead file is judged by the reader before the item rules: its bad items are not reported', async () => {
    const at301 = new Date(NOW + 301_000).toISOString().replace('.000', '')
    const data = await collectWaiting(fakeIo({ 'waiting.hosta.json': envelope('hosta', [item({ id: 'x-1' })], at301) }), LOC, NOW)
    expect(data.down).toEqual([{ host: 'hosta', text: 'n/a（格式錯誤：時鐘超前）' }])
  })

  test('the capture from the real producer parses and carries one closer record', async () => {
    const data = await collectWaiting(fakeIo({ 'waiting.hosta.json': bytesOf(CAPTURE['waiting.hosta.json']!.lines), 'waiting.hostb.json': bytesOf(CAPTURE['waiting.hostb.json']!.lines) }), LOC, NOW)
    expect(data.down).toEqual([])
    expect(data.items.map(i => i.what)).toEqual(['Y waiting', 'Z waiting'])
  })
})
