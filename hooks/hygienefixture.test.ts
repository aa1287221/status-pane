import { describe, expect, test } from 'claude-code/testing'

import { EXPECTED_TEXT, FILES, HUB_COMMIT } from './hygiene.fixtures'
import { hygieneOf } from './hygiene'
import { readSideFile } from './sidefile'
import type { SideIo } from './sidefile'

const EXPECTED = JSON.parse(EXPECTED_TEXT) as {
  reference: { now: string }
  cases: { case: string; file: string; sha256?: string; verdict: string; violation?: string; entries?: { event: string; repo: string; first_line: string; line_count: number; source: string; at: string }[] }[]
  boundaries: { file: string; now: string; verdict: string; violation?: string; rule?: string }[]
}
const DIR = '/work/example/tmp/claude-side'
const NOW_MS = Date.parse(EXPECTED.reference.now)
const io: SideIo = {
  exists: async p => p.slice(p.lastIndexOf('/') + 1) in FILES,
  readBytes: async p => {
    const name = p.slice(p.lastIndexOf('/') + 1)
    const text = FILES[name]
    if (text === undefined) throw new Error('ENOENT')
    return new TextEncoder().encode(text)
  },
}

const judged = async (name: string, nowMs = NOW_MS) => {
  const r = await readSideFile(io, `${DIR}/${name}`, nowMs)
  const data = hygieneOf(r, nowMs / 1000)
  return { r, data }
}
const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

describe('git-hygiene: hub fixtures', () => {
  test('the embedded copies are pinned to the hub commit and every listed sha256', async () => {
    expect(HUB_COMMIT).toMatch(/^[0-9a-f]{7,40}$/)
    expect(Object.keys(FILES).sort()).toEqual(EXPECTED.cases.filter(c => c.sha256).map(c => c.file).sort())
    for (const c of EXPECTED.cases) if (c.sha256) expect(await sha256(FILES[c.file]!)).toBe(c.sha256)
  })

  test('every hub case goes through the reader and maps its verdict, violation and entries', async () => {
    expect(EXPECTED.cases).toHaveLength(18)
    for (const c of EXPECTED.cases) {
      const { r, data } = await judged(c.file)
      const verdict = r.verdict === 'ok' ? (data.ok ? 'ok' : 'malformed') : r.verdict
      const reason = r.verdict === 'ok' && !data.ok ? data.why : r.reason
      expect([c.case, verdict]).toEqual([c.case, c.verdict])
      if (c.violation) expect([c.case, reason]).toEqual([c.case, expect.stringContaining(c.violation)])
      if (c.verdict === 'ok') {
        expect(data.ok).toBe(true)
        if (data.ok) {
          expect(data.v.entries.map(e => ({
            event: e.event,
            repo: e.repo,
            first_line: e.firstLine,
            line_count: e.lines.length,
            source: e.source,
            at: new Date(e.atSec * 1000).toISOString().replace('.000Z', 'Z'),
          }))).toEqual(c.entries)
        }
      } else {
        expect(data.ok).toBe(false)
      }
      if (c.verdict === 'failed') {
        expect(r.text).toContain('fixture failure: side file not written')
        expect(r.text).toContain('上次成功')
        expect(r.text).not.toContain('write_failed')
      }
    }
    expect(await judged('git-hygiene.missing.json').then(({ r }) => r.verdict)).toBe('missing')
  })

  test('each boundary gets the hub verdict and violation', async () => {
    for (const b of EXPECTED.boundaries) {
      const { r } = await judged(b.file, Date.parse(b.now))
      expect([b.now, r.verdict]).toEqual([b.now, b.verdict])
      // The shared reader names the clock rule without the field ('格式錯誤：時鐘超前'); the hub text adds observed_at.
      const want = b.rule === 'clock' ? '時鐘超前' : b.violation
      if (want) expect([b.now, r.reason]).toEqual([b.now, expect.stringContaining(want)])
    }
  })

  test('at precedes source when one entry violates both checks', async () => {
    const bad = JSON.stringify({
      schema_version: 1,
      kind: 'git-hygiene',
      producer: { id: 'fixture', host: 'fixture-host' },
      station: null,
      run_id: null,
      observed_at: '2026-10-10T11:59:30Z',
      last_success_at: '2026-10-10T11:59:30Z',
      collection_status: 'ok',
      error: null,
      data: { entries: [{
        event: 'commit', repo: '/work/example/repo', first_line: 'good',
        lines: ['good'],
        at: '2026-10-10T11:58:00Z', source: 'invalid',
      }] },
    })
    const localIo: SideIo = { ...io, exists: async p => p.endsWith('git-hygiene.local-two-violations.json'),
      readBytes: async () => new TextEncoder().encode(bad) }
    const r = await readSideFile(localIo, `${DIR}/git-hygiene.local-two-violations.json`, NOW_MS)
    const data = hygieneOf(r, NOW_MS / 1000)
    expect(data.ok).toBe(false)
    expect(!data.ok && data.why).toContain('data.entries[0].at 必須等於 observed_at')
  })

  test('line count precedes line contents when one entry violates both checks', async () => {
    const bad = JSON.stringify({
      schema_version: 1,
      kind: 'git-hygiene',
      producer: { id: 'fixture', host: 'fixture-host' },
      station: null,
      run_id: null,
      observed_at: '2026-10-10T11:59:30Z',
      last_success_at: '2026-10-10T11:59:30Z',
      collection_status: 'ok',
      error: null,
      data: { entries: [{
        event: 'commit', repo: '/work/example/repo', first_line: 'good',
        lines: ['x'.repeat(201), ...Array.from({ length: 12 }, (_, i) => `line ${i}`)],
        at: '2026-10-10T11:59:30Z', source: 'main',
      }] },
    })
    const localIo: SideIo = { ...io, exists: async p => p.endsWith('git-hygiene.local-line-order.json'),
      readBytes: async () => new TextEncoder().encode(bad) }
    const r = await readSideFile(localIo, `${DIR}/git-hygiene.local-line-order.json`, NOW_MS)
    const data = hygieneOf(r, NOW_MS / 1000)
    expect(data.ok).toBe(false)
    expect(!data.ok && data.why).toContain('data.entries[0].lines 不是 1 到 12 行的陣列')
  })
})
