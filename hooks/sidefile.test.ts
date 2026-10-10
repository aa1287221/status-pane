import { describe, expect, test } from 'claude-code/testing'

import { BYTES, FILES, HUB_COMMIT, MANIFEST_TEXT } from './sidefile.fixtures'
import {
  KINDS,
  SIDE_MAX_BYTES,
  SKEW_SEC,
  ageText,
  bytesFromBase64,
  fixtureOf,
  parseSideName,
  parseStamp,
  readSideFile,
  readSideKind,
  sideFilePath,
} from './sidefile'
import type { SideIo, SideResult } from './sidefile'

// SCHEMA.md section 10: the reader is judged against the hub's hand-written fixtures and MANIFEST.json.
type Case = { case: string; file: string; verdict: string; hidden_count?: number }
type Boundary = { file: string; now: string; verdict: string; why: string }
type Manifest = {
  reference: { now: string; kind: string; ttl_seconds: number; skew_seconds: number; supported_versions: number[] }
  cases: Case[]
  boundaries: Boundary[]
}
const MANIFEST = JSON.parse(MANIFEST_TEXT) as Manifest
const NOW = Date.parse(MANIFEST.reference.now)
const DIR = '/tmp/claude-side'
const at = (file: string) => `${DIR}/${file}`

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const cp = (...codes: number[]): string => String.fromCodePoint(...codes)

type Store = Record<string, string | Uint8Array>

/** A SideIo over in-memory files that records what it was asked, so a test can prove nothing was opened. */
const memIo = (files: Store, over: Partial<SideIo> = {}) => {
  const calls: string[] = []
  const io: SideIo = {
    exists: async p => {
      calls.push(`exists ${p}`)
      return p in files
    },
    readBytes: async p => {
      calls.push(`read ${p}`)
      const f = files[p]
      if (f === undefined) throw new Error('ENOENT')
      return typeof f === 'string' ? enc(f) : f
    },
    ...over,
  }
  return { io, calls }
}

const fixtureStore = (): Store => Object.fromEntries(Object.entries(FILES).map(([name, text]) => [at(name), text]))

const readFile = (file: string, now = NOW, store: Store = fixtureStore()) => readSideFile(memIo(store).io, at(file), now)

/** The valid fixture with one edit; the result is the file text. */
const edited = (edit: (o: Record<string, unknown>) => void): string => {
  const o = JSON.parse(FILES['fixture.valid.json']!) as Record<string, unknown>
  edit(o)
  return JSON.stringify(o, null, 2) + '\n'
}
const fixtureWith = (edit: (o: Record<string, unknown>) => void, now = NOW) =>
  readSideFile(memIo({ [at('fixture.json')]: edited(edit) }).io, at('fixture.json'), now)

const expectNa = (r: SideResult, verdict: string, text: string | RegExp) => {
  expect(r.verdict).toBe(verdict)
  if (r.verdict === 'ok') throw new Error('expected an n/a result')
  if (typeof text === 'string') expect(r.text).toBe(text)
  else expect(r.text).toMatch(text)
}

describe('side file reader: the hub fixtures (SCHEMA.md section 10)', () => {
  test('the manifest lists thirteen cases and six boundaries, for kind fixture at 12:00 UTC', () => {
    expect(MANIFEST.cases.length).toBe(13)
    expect(MANIFEST.boundaries.length).toBe(6)
    expect(MANIFEST.reference).toMatchObject({ now: '2026-10-10T12:00:00Z', kind: 'fixture', ttl_seconds: 600, skew_seconds: 300, supported_versions: [1] })
    // the reader's registry and constants are the manifest's reference block
    expect(KINDS.fixture).toMatchObject({ cls: 'local', ttlSec: MANIFEST.reference.ttl_seconds, finalTtlSec: null })
    expect(SKEW_SEC).toBe(MANIFEST.reference.skew_seconds)
  })

  for (const c of MANIFEST.cases) {
    test(`case ${c.case}: ${c.verdict}`, async () => {
      const r = await readFile(c.file)
      expect(r.verdict).toBe(c.verdict)
      // a reader that read nothing of the file's data must not carry it: the count is for ok only
      if (c.hidden_count !== undefined) {
        expect(r.verdict).not.toBe('ok')
        expect(JSON.stringify(r)).not.toContain('count')
        expect('data' in r).toBe(false)
      }
    })
  }

  test('the missing case: the file name really is absent from the fixtures', () => {
    expect('fixture.missing.json' in FILES).toBe(false)
    expect(MANIFEST.cases.find(c => c.case === 'missing')?.file).toBe('fixture.missing.json')
  })

  for (const b of MANIFEST.boundaries) {
    test(`boundary ${b.file} at ${b.now}: ${b.verdict} (${b.why})`, async () => {
      const r = await readFile(b.file, Date.parse(b.now))
      expect(r.verdict).toBe(b.verdict)
    })
  }
})

describe('side file reader: every negative fixture fails for its own reason', () => {
  test('valid: the data, the age and the stamp of the observation', async () => {
    const r = await readFile('fixture.valid.json')
    expect(r).toMatchObject({ verdict: 'ok', kind: 'fixture', data: { count: 3 }, ageSec: 30, observedAtSec: Date.parse('2026-10-10T11:59:30Z') / 1000 })
    if (r.verdict === 'ok') expect(r.producer).toEqual({ id: 'side-file-fixture', host: 'fixture-host' })
  })
  test('missing', async () => expectNa(await readFile('fixture.missing.json'), 'missing', 'n/a（缺檔）'))
  test('truncated: the data is all there, the closing brace is not', async () =>
    expectNa(await readFile('fixture.truncated.json'), 'corrupt', 'n/a（檔案損毀或被截斷）'))
  test('stale: the age is said, the count is not', async () => {
    const r = await readFile('fixture.stale.json')
    expectNa(r, 'stale', 'n/a（過期 4h）')
  })
  test('malformed: the one wrong field is named', async () => expectNa(await readFile('fixture.malformed.json'), 'malformed', /^n\/a（格式錯誤：collection_status/))
  test('unsupported version: the version is named, the other structure is not read', async () =>
    expectNa(await readFile('fixture.unsupported-version.json'), 'unsupported_version', 'n/a（版本不支援：v2）'))
  test('failed: the message, and the last success', async () => {
    const r = await readFile('fixture.failed.json')
    expectNa(r, 'failed', /^n\/a（收集失敗：ssh to s8p-01 timed out after 10 s/)
    if (r.verdict !== 'ok') {
      expect(r.text).toContain('上次成功')
      expect(r.lastSuccessAtSec).toBe(Date.parse('2026-10-10T11:40:00Z') / 1000)
    }
  })
  test('emoji message: 200 code points are legal although UTF-16 says 300 and UTF-8 says 500 bytes', async () => {
    const r = await readFile('fixture.emoji-message.json')
    expect(r.verdict).toBe('failed')
    if (r.verdict !== 'ok') expect([...r.reason].filter(c => c === cp(0x1f600)).length).toBe(100)
  })
  test('c1 control: U+009B in the message', async () => expectNa(await readFile('fixture.c1-control.json'), 'malformed', /^n\/a（格式錯誤：error\.message/))
  test('version float: 1.0 is not the integer literal 1', async () =>
    expectNa(await readFile('fixture.version-float.json'), 'malformed', /^n\/a（格式錯誤：schema_version/))
  test('bad date: 2026-02-30 is not rolled over to March', async () =>
    expectNa(await readFile('fixture.bad-date.json'), 'malformed', /^n\/a（格式錯誤：observed_at/))
  test('year zero', async () => expectNa(await readFile('fixture.year-zero.json'), 'malformed', /^n\/a（格式錯誤：observed_at/))
  test('hour 24', async () => expectNa(await readFile('fixture.hour-24.json'), 'malformed', /^n\/a（格式錯誤：observed_at/))
  test('a failure whose message is shown carries no data of its own', async () => {
    const r = await readFile('fixture.failed.json')
    expect('data' in r).toBe(false)
  })
})

describe('side file reader: embedded copies match the manifest (drift tripwire)', () => {
  test('copies come from the hub commit the tests name', () => expect(HUB_COMMIT).toBe('6098494'))

  test('every manifest case has a copy, except the one that is absent on purpose', () => {
    for (const c of MANIFEST.cases) {
      expect(c.file).toBe(`fixture.${c.case}.json`)
      expect(c.file in FILES).toBe(c.case !== 'missing')
    }
    for (const b of MANIFEST.boundaries) expect(b.file in FILES).toBe(true)
    const named = new Set(MANIFEST.cases.map(c => c.file))
    for (const name of Object.keys(FILES)) expect(named.has(name)).toBe(true)
  })

  test('every copy has the byte length it had at the hub commit', () => {
    for (const [name, text] of Object.entries(FILES)) expect([name, enc(text).length]).toEqual([name, BYTES[name]])
  })

  test('truncated is the first 320 bytes of valid, without the closing brace and newline', () => {
    const valid = enc(FILES['fixture.valid.json']!)
    const cut = enc(FILES['fixture.truncated.json']!)
    expect(valid.length).toBe(327)
    expect(cut.length).toBe(320)
    expect([...cut]).toEqual([...valid.slice(0, 320)])
  })

  test('each hidden_count is the data.count its copy really holds (truncated: the value just before the cut)', () => {
    for (const c of MANIFEST.cases) {
      if (c.hidden_count === undefined) continue
      const text = FILES[c.file]!
      if (c.case === 'truncated') {
        expect(text).toMatch(new RegExp(`"count": ${c.hidden_count}$`))
      } else if (c.case === 'unsupported-version') {
        expect((JSON.parse(text) as { payload: { count: number } }).payload.count).toBe(c.hidden_count)
      } else {
        expect((JSON.parse(text) as { data: { count: number } }).data.count).toBe(c.hidden_count)
      }
    }
  })

  test('the copies hold what the contract says about them, one violation each', () => {
    const j = (name: string) => JSON.parse(FILES[name]!) as Record<string, any>
    expect(j('fixture.valid.json')).toMatchObject({ schema_version: 1, kind: 'fixture', collection_status: 'ok', observed_at: '2026-10-10T11:59:30Z' })
    expect(j('fixture.stale.json').observed_at).toBe('2026-10-10T08:00:00Z')
    expect(j('fixture.malformed.json').collection_status).toBe('success')
    expect(j('fixture.unsupported-version.json').schema_version).toBe(2)
    expect(j('fixture.failed.json')).toMatchObject({ collection_status: 'failed', station: 's8p-01', data: null })
    const emoji = j('fixture.emoji-message.json').error.message as string
    expect([...emoji].length).toBe(200)
    expect(emoji.length).toBe(300)
    expect(enc(emoji).length).toBe(500)
    // the C1 byte is written out as a visible escape, so a copy that lost it shrinks by 4 bytes
    expect(FILES['fixture.c1-control.json']).toContain(cp(0x5c) + 'u009b')
    expect(FILES['fixture.version-float.json']).toContain('"schema_version": 1.0,')
    expect(j('fixture.bad-date.json').observed_at).toBe('2026-02-30T00:00:00Z')
    expect(j('fixture.year-zero.json').observed_at).toBe('0000-01-01T00:00:00Z')
    expect(j('fixture.hour-24.json').observed_at).toBe('2026-10-10T24:00:00Z')
  })

  test('a copy that drifted fails the tripwire: the same check on a damaged copy is red', () => {
    const damaged = FILES['fixture.c1-control.json']!.replace(cp(0x5c) + 'u009b', cp(0x9b))
    expect(enc(damaged).length).not.toBe(BYTES['fixture.c1-control.json'])
  })
})

describe('side file reader: section 2 and 4 rules, one violation at a time', () => {
  test('the unedited valid text is ok (control for the edits below)', async () => {
    expect((await fixtureWith(() => {})).verdict).toBe('ok')
  })

  test('every key must be present', async () => {
    const keys = Object.keys(JSON.parse(FILES['fixture.valid.json']!) as object).filter(k => k !== 'schema_version')
    for (const key of keys) {
      const r = await fixtureWith(o => {
        delete o[key]
      })
      expectNa(r, 'malformed', new RegExp(`^n/a（格式錯誤：.*${key}`))
    }
  })

  test('schema_version missing, a string, a bool, 0 and negatives are malformed; the first violation names it', async () => {
    const missing = await fixtureWith(o => void delete o.schema_version)
    expectNa(missing, 'malformed', /schema_version/)
    for (const v of ['1', true, null, 0, -1, [1], { v: 1 }]) {
      expectNa(await fixtureWith(o => void (o.schema_version = v)), 'malformed', /schema_version/)
    }
  })

  test('integer literal: 1.0, 1e0, 1E0, 10e-1 and -0 are not accepted; 1 is', async () => {
    const withLiteral = (lit: string) => readSideFile(memIo({ [at('fixture.json')]: FILES['fixture.valid.json']!.replace('"schema_version": 1,', `"schema_version": ${lit},`) }).io, at('fixture.json'), NOW)
    for (const lit of ['1.0', '1e0', '1E0', '10e-1', '1.5', '-0', '0', '-1']) expectNa(await withLiteral(lit), 'malformed', /schema_version/)
    expect((await withLiteral('1')).verdict).toBe('ok')
    expectNa(await withLiteral('2'), 'unsupported_version', 'n/a（版本不支援：v2）')
    expectNa(await withLiteral('99999999999999999999999'), 'unsupported_version', /^n\/a（版本不支援：v/)
  })

  test('the literal is the top-level key: a decoy inside data cannot stand in for it', async () => {
    const text = FILES['fixture.version-float.json']!.replace('"count": 31', '"schema_version": 1, "count": 31')
    expectNa(await readSideFile(memIo({ [at('fixture.json')]: text }).io, at('fixture.json'), NOW), 'malformed', /schema_version/)
    // and the other way: a float decoy in data does not poison a good top-level 1
    const good = FILES['fixture.valid.json']!.replace('"count": 3', '"count": 3, "schema_version": 1.0')
    expect((await readSideFile(memIo({ [at('fixture.json')]: good }).io, at('fixture.json'), NOW)).verdict).toBe('ok')
  })

  test('the last of two top-level schema_version keys wins, as JSON.parse has it', async () => {
    const dup = FILES['fixture.valid.json']!.replace('"schema_version": 1,', '"schema_version": 1.0,\n  "schema_version": 1,')
    expect((await readSideFile(memIo({ [at('fixture.json')]: dup }).io, at('fixture.json'), NOW)).verdict).toBe('ok')
    const dup2 = FILES['fixture.valid.json']!.replace('"schema_version": 1,', '"schema_version": 1,\n  "schema_version": 1.0,')
    expectNa(await readSideFile(memIo({ [at('fixture.json')]: dup2 }).io, at('fixture.json'), NOW), 'malformed', /schema_version/)
  })

  test('a key spelled with an escape is still the key', async () => {
    const text = FILES['fixture.version-float.json']!.replace('"schema_version"', '"schema' + cp(0x5c) + 'u005fversion"')
    expectNa(await readSideFile(memIo({ [at('fixture.json')]: text }).io, at('fixture.json'), NOW), 'malformed', /schema_version/)
  })

  test('step 4 comes before step 5: a version this reader does not know is never judged by v1 rules', async () => {
    const r = await fixtureWith(o => {
      o.schema_version = 2
      o.collection_status = 'success'
      delete o.observed_at
    })
    expectNa(r, 'unsupported_version', 'n/a（版本不支援：v2）')
  })

  test('kind: shape, and equal to the file name', async () => {
    for (const k of ['Fixture', '1fixture', 'fix_ture', '', 'a'.repeat(33), 5, null]) {
      expectNa(await fixtureWith(o => void (o.kind = k)), 'malformed', /kind/)
    }
    expectNa(await fixtureWith(o => void (o.kind = 'sync-status')), 'malformed', /kind.*檔名/)
    expectNa(await fixtureWith(o => void (o.kind = 'fixture\n')), 'malformed', /kind/)
  })

  test('producer: an object of two labels', async () => {
    for (const p of [null, 'x', [], {}, { id: 'a' }, { host: 'a' }, { id: '', host: 'a' }, { id: 'a', host: 'a b' }, { id: '-a', host: 'a' }, { id: 'a'.repeat(65), host: 'a' }, { id: 'a', host: 5 }, { id: 'a\n', host: 'a' }]) {
      expectNa(await fixtureWith(o => void (o.producer = p)), 'malformed', /producer/)
    }
    expect((await fixtureWith(o => void (o.producer = { id: 'a'.repeat(64), host: 'h.example-1_x' }))).verdict).toBe('ok')
  })

  test('station and run_id: a label or null', async () => {
    for (const key of ['station', 'run_id']) {
      for (const v of ['', 'a b', '-a', 5, true, 'x'.repeat(65), 'a\n', '10.0.0.1 ']) {
        expectNa(await fixtureWith(o => void (o[key] = v)), 'malformed', new RegExp(key))
      }
      expect((await fixtureWith(o => void (o[key] = 's8p-01'))).verdict).toBe('ok')
    }
  })

  test('collection_status is ok or failed and nothing else', async () => {
    for (const s of ['success', 'OK', 'Ok', ' ok', 'ok\n', null, true, 1]) {
      expectNa(await fixtureWith(o => void (o.collection_status = s)), 'malformed', /collection_status/)
    }
  })

  test('timestamps: one format only', async () => {
    const bad = [
      '2026-10-10T11:59:30+00:00',
      '2026-10-10T11:59:30.000Z',
      '2026-10-10 11:59:30Z',
      '2026-10-10T11:59:30',
      '2026-10-10T11:59:30z',
      '2026-10-10t11:59:30Z',
      '26-10-10T11:59:30Z',
      '2026-1-10T11:59:30Z',
      '2026-10-10T11:59Z',
      ' 2026-10-10T11:59:30Z',
      '2026-10-10T11:59:30Z\n',
      '2026-13-10T11:59:30Z',
      '2026-00-10T11:59:30Z',
      '2026-10-00T11:59:30Z',
      '2026-10-32T11:59:30Z',
      '2026-04-31T11:59:30Z',
      '2026-02-29T11:59:30Z',
      '1900-02-29T00:00:00Z',
      '2026-10-10T24:00:00Z',
      '2026-10-10T11:60:30Z',
      '2026-10-10T11:59:60Z',
      '2026-10-10T11:59:30' + cp(0xff1a) + 'Z',
      '０２６-10-10T11:59:30Z',
      '',
      5,
      null,
    ]
    for (const t of bad) {
      expectNa(await fixtureWith(o => {
        o.observed_at = t
        o.last_success_at = t
      }), 'malformed', /observed_at/)
    }
    // last_success_at alone, with a good observed_at
    for (const t of ['2026-02-30T00:00:00Z', 'x', 5]) {
      expectNa(await fixtureWith(o => void (o.last_success_at = t)), 'malformed', /last_success_at/)
    }
  })

  test('timestamps: the days that do exist are accepted', async () => {
    const ok = ['2024-02-29T11:59:30Z', '2000-02-29T11:59:30Z', '2026-12-31T11:59:30Z', '2026-10-10T11:59:30Z']
    for (const t of ok) {
      const r = await fixtureWith(o => {
        o.observed_at = t
        o.last_success_at = t
      }, Date.parse(t))
      expect([t, r.verdict]).toEqual([t, 'ok'])
    }
  })

  test('parseStamp is a calendar, not Date.parse', () => {
    expect(parseStamp('2026-10-10T12:00:00Z')).toBe(Date.parse('2026-10-10T12:00:00Z') / 1000)
    expect(parseStamp('1970-01-01T00:00:00Z')).toBe(0)
    expect(parseStamp('1969-12-31T23:59:59Z')).toBe(-1)
    expect(parseStamp('2000-03-01T00:00:00Z')! - parseStamp('2000-02-29T00:00:00Z')!).toBe(86_400)
    expect(parseStamp('2100-03-01T00:00:00Z')! - parseStamp('2100-02-28T00:00:00Z')!).toBe(86_400)
    expect(parseStamp('0001-01-01T00:00:00Z')).toBe(-62_135_596_800)
    expect(parseStamp('9999-12-31T23:59:59Z')).toBe(253_402_300_799)
    for (const bad of ['0000-01-01T00:00:00Z', '10000-01-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-10-10T24:00:00Z', '2026-10-10T12:00:00']) {
      expect([bad, parseStamp(bad)]).toEqual([bad, null])
    }
  })

  test('tripwire: this engine still rolls impossible dates over, which is why parseStamp exists', () => {
    expect(new Date(Date.parse('2026-02-30T00:00:00Z')).toISOString()).toBe('2026-03-02T00:00:00.000Z')
    expect(new Date(Date.parse('2026-10-10T24:00:00Z')).toISOString()).toBe('2026-10-11T00:00:00.000Z')
  })

  test('error: null, or a code and a message', async () => {
    const failed = (error: unknown) => fixtureWith(o => {
      o.collection_status = 'failed'
      o.last_success_at = null
      o.data = null
      o.error = error
    })
    expect((await failed({ code: 'ssh_timeout', message: 'timed out' })).verdict).toBe('failed')
    for (const e of [null, 'x', [], {}, { code: 'ssh_timeout' }, { message: 'm' }, { code: 'Ssh', message: 'm' }, { code: '1x', message: 'm' }, { code: 'a-b', message: 'm' }, { code: '', message: 'm' }, { code: 'a'.repeat(49), message: 'm' }, { code: 5, message: 'm' }, { code: 'ok\n', message: 'm' }]) {
      expectNa(await failed(e), 'malformed', /error/)
    }
    expect((await failed({ code: 'a'.repeat(48), message: 'm' })).verdict).toBe('failed')
  })

  test('error.message: 1 to 200 code points, none of them a control character', async () => {
    const msg = (m: unknown) => fixtureWith(o => {
      o.collection_status = 'failed'
      o.last_success_at = null
      o.data = null
      o.error = { code: 'x', message: m }
    })
    expect((await msg('x'.repeat(200))).verdict).toBe('failed')
    expect((await msg(cp(0x1f600).repeat(200))).verdict).toBe('failed')
    for (const m of ['', 'x'.repeat(201), cp(0x1f600).repeat(201), 5, null]) expectNa(await msg(m), 'malformed', /error\.message/)
    const controls = [0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9b, 0x9f, 0x2028, 0x2029]
    for (const c of controls) expectNa(await msg(`a${cp(c)}b`), 'malformed', /error\.message/)
    // the neighbours of those sets are fine
    for (const c of [0x20, 0x7e, 0xa0, 0xa1, 0x2027, 0x202a, 0x3000, 0xfeff, 0x1f600]) {
      const r = await msg(`a${cp(c)}b`)
      expect([c, r.verdict]).toEqual([c, 'failed'])
    }
  })

  test('consistency 1: ok needs error null, data an object, last_success_at equal to observed_at', async () => {
    expectNa(await fixtureWith(o => void (o.error = { code: 'x', message: 'm' })), 'malformed', /error/)
    expectNa(await fixtureWith(o => void (o.data = null)), 'malformed', /data/)
    expectNa(await fixtureWith(o => void (o.data = [])), 'malformed', /data/)
    expectNa(await fixtureWith(o => void (o.data = 'x')), 'malformed', /data/)
    expectNa(await fixtureWith(o => void (o.last_success_at = null)), 'malformed', /last_success_at/)
    expectNa(await fixtureWith(o => void (o.last_success_at = '2026-10-10T11:59:29Z')), 'malformed', /last_success_at/)
    expect((await fixtureWith(o => void (o.data = {}))).verdict).toBe('ok')
  })

  test('consistency 2 and 3: failed needs an error and no data; last_success_at never after observed_at', async () => {
    const failed = (edit: (o: Record<string, unknown>) => void) => fixtureWith(o => {
      o.collection_status = 'failed'
      o.error = { code: 'x', message: 'm' }
      o.data = null
      o.last_success_at = null
      edit(o)
    })
    expect((await failed(() => {})).verdict).toBe('failed')
    expect((await failed(o => void (o.last_success_at = o.observed_at))).verdict).toBe('failed')
    expect((await failed(o => void (o.last_success_at = '2026-10-10T11:00:00Z'))).verdict).toBe('failed')
    expectNa(await failed(o => void (o.last_success_at = '2026-10-10T11:59:31Z')), 'malformed', /last_success_at/)
    expectNa(await failed(o => void (o.error = null)), 'malformed', /error/)
    expectNa(await failed(o => void (o.data = {})), 'malformed', /data/)
  })

  test('unknown top-level and data keys are ignored', async () => {
    const r = await fixtureWith(o => {
      o.extra = { nested: [1, 2, 3] }
      ;(o.data as Record<string, unknown>).more = 'x'
    })
    expect(r).toMatchObject({ verdict: 'ok', data: { count: 3, more: 'x' } })
  })

  test('the first violation is the one named when there are several', async () => {
    const r = await fixtureWith(o => {
      o.kind = 'Bad'
      o.collection_status = 'success'
    })
    expectNa(r, 'malformed', /kind/)
  })

  test('a file name that is not of this kind: kind must equal the first segment', async () => {
    const r = await readSideFile(memIo({ [at('sync-status.json')]: FILES['fixture.valid.json']! }).io, at('sync-status.json'), NOW)
    expectNa(r, 'malformed', /kind.*檔名/)
  })
})

describe('side file reader: age, TTL, final and clock skew', () => {
  const valid = (file = 'fixture.valid.json') => FILES[file]!

  test('fresh up to and including the TTL; one second more is stale', async () => {
    const t = Date.parse('2026-10-10T11:59:30Z')
    expect((await readFile('fixture.valid.json', t + 600_000)).verdict).toBe('ok')
    expectNa(await readFile('fixture.valid.json', t + 601_000), 'stale', 'n/a（過期 10m）')
  })

  test('an age of 600.5 s is past the TTL (milliseconds count)', async () => {
    const t = Date.parse('2026-10-10T11:59:30Z')
    expect((await readFile('fixture.valid.json', t + 600_500)).verdict).toBe('stale')
  })

  test('observed_at up to 300 s ahead is tolerated and reads as age 0; 301 s is malformed', async () => {
    const t = Date.parse('2026-10-10T11:59:30Z')
    const r = await readFile('fixture.valid.json', t - 300_000)
    expect(r).toMatchObject({ verdict: 'ok', ageSec: 0 })
    expectNa(await readFile('fixture.valid.json', t - 301_000), 'malformed', /時鐘超前/)
    expectNa(await readFile('fixture.valid.json', t - 300_001), 'malformed', /時鐘超前/)
  })

  test('local time pasted with a Z is caught: Taiwan is eight hours ahead', async () => {
    const taipei = '2026-10-10T20:00:00Z'
    const r = await fixtureWith(o => {
      o.observed_at = taipei
      o.last_success_at = taipei
    })
    expectNa(r, 'malformed', /時鐘超前/)
  })

  test('the rollover probes of the manifest: a rolled-over date is not a fresh one', async () => {
    for (const [file, now] of [['fixture.bad-date.json', '2026-03-02T00:00:30Z'], ['fixture.hour-24.json', '2026-10-11T00:00:30Z']] as const) {
      expectNa(await readFile(file, Date.parse(now)), 'malformed', /observed_at/)
    }
  })

  test('step 6 before step 7: a failure older than the TTL is stale, and the reason rides along', async () => {
    const r = await readFile('fixture.failed.json', Date.parse('2026-10-10T12:30:00Z'))
    expectNa(r, 'stale', /^n\/a（過期 30m.*ssh to s8p-01 timed out after 10 s/)
  })

  test('a kind with no TTL never goes stale but still tells its age', async () => {
    expect(KINDS.waiting).toMatchObject({ cls: 'synced', ttlSec: null })
    const text = edited(o => {
      o.kind = 'waiting'
      o.producer = { id: 'waiting', host: 'WKY' }
    })
    const r = await readSideFile(memIo({ '/h/references/side-files/waiting.WKY.json': text }).io, '/h/references/side-files/waiting.WKY.json', NOW + 400 * 86_400_000)
    expect(r).toMatchObject({ verdict: 'ok', ageSec: 400 * 86_400 + 30 })
  })

  test('final: true lengthens the TTL for a kind that has a final TTL (review-lane 300 s, then 86400 s)', async () => {
    expect(KINDS['review-lane']).toMatchObject({ cls: 'local', ttlSec: 300, finalTtlSec: 86_400 })
    const file = (data: Record<string, unknown>) => edited(o => {
      o.kind = 'review-lane'
      o.data = data
    })
    const read = (data: Record<string, unknown>, ageSec: number) =>
      readSideFile(memIo({ [at('review-lane.json')]: file(data) }).io, at('review-lane.json'), Date.parse('2026-10-10T11:59:30Z') + ageSec * 1000)
    expect((await read({ final: true }, 86_400)).verdict).toBe('ok')
    expect((await read({ final: true }, 86_401)).verdict).toBe('stale')
    expect((await read({}, 300)).verdict).toBe('ok')
    expect((await read({}, 301)).verdict).toBe('stale')
    // only the boolean true counts
    for (const f of [false, 'true', 1, null, [true]]) expect([f, (await read({ final: f }, 301)).verdict]).toEqual([f, 'stale'])
  })

  test('a kind without a final TTL ignores data.final', async () => {
    const t = Date.parse('2026-10-10T11:59:30Z')
    const text = edited(o => void (o.data = { count: 1, final: true }))
    const r = await readSideFile(memIo({ [at('fixture.json')]: text }).io, at('fixture.json'), t + 601_000)
    expect(r.verdict).toBe('stale')
  })

  test('ageText', () => {
    expect([0, 59, 60, 119, 3599, 3600, 3660, 14_400, 86_399, 86_400, 90_000, 400 * 86_400].map(ageText)).toEqual([
      '0s', '59s', '1m', '1m', '59m', '1h', '1h1m', '4h', '23h59m', '1d', '1d1h', '400d',
    ])
  })
})

describe('side file reader: names and locations', () => {
  test('grammar: kind, then at most two parts, then .json', () => {
    const ok: [string, string, string[]][] = [
      ['/tmp/claude-side/fixture.json', 'fixture', []],
      ['/tmp/claude-side/fixture.valid.json', 'fixture', ['valid']],
      ['/tmp/claude-side/site-watch.s8p-01.json', 'site-watch', ['s8p-01']],
      ['/x/waiting.DESKTOP-TM3EUNI.json', 'waiting', ['DESKTOP-TM3EUNI']],
      ['/x/waiting.WKY.run_1.json', 'waiting', ['WKY', 'run_1']],
      ['fixture.a.b.json', 'fixture', ['a', 'b']],
    ]
    for (const [path, kind, parts] of ok) expect([path, parseSideName(path)]).toEqual([path, { kind, parts }])
    const bad = [
      '/tmp/claude-side/',
      '/tmp/claude-side/fixture',
      '/tmp/claude-side/fixture.JSON',
      '/tmp/claude-side/Fixture.json',
      '/tmp/claude-side/1fixture.json',
      '/tmp/claude-side/fixture..json',
      '/tmp/claude-side/fixture.a.b.c.json',
      '/tmp/claude-side/fixture.a b.json',
      '/tmp/claude-side/fixture.-a.json',
      '/tmp/claude-side/fixture.json.tmp',
      '/tmp/claude-side/.fixture.x.tmp',
      '/tmp/claude-side/.fixture.json',
      '/tmp/claude-side/fixture.json\n',
      '/tmp/claude-side/fixture.' + 'a'.repeat(65) + '.json',
      '/tmp/claude-side/' + 'k'.repeat(33) + '.json',
      '/tmp/claude-side/.json',
      '',
    ]
    for (const path of bad) expect([path, parseSideName(path)]).toEqual([path, null])
    // a 64-character part and a 32-character kind are the limits
    expect(parseSideName('/t/' + 'k'.repeat(32) + '.' + 'a'.repeat(64) + '.json')).not.toBeNull()
  })

  test('a name outside the grammar is never opened and is not malformed', async () => {
    const { io, calls } = memIo({ [at('fixture.a.b.c.json')]: FILES['fixture.valid.json']! })
    const r = await readSideFile(io, at('fixture.a.b.c.json'), NOW)
    expectNa(r, 'bad_name', /檔名/)
    expect(calls).toEqual([])
  })

  test('a kind that is not in the registry is not opened either', async () => {
    const { io, calls } = memIo({ [at('nonesuch.json')]: FILES['fixture.valid.json']! })
    expectNa(await readSideFile(io, at('nonesuch.json'), NOW), 'unknown_kind', /nonesuch/)
    expect(calls).toEqual([])
  })

  test('synced kinds carry the host in the name, and it must equal producer.host', async () => {
    const text = (host: string) => edited(o => {
      o.kind = 'waiting'
      o.producer = { id: 'waiting', host }
    })
    const p = '/h/references/side-files/waiting.WKY.json'
    expect((await readSideFile(memIo({ [p]: text('WKY') }).io, p, NOW)).verdict).toBe('ok')
    expectNa(await readSideFile(memIo({ [p]: text('WKYLaptop') }).io, p, NOW), 'malformed', /host/)
    // host of another case is another host
    expectNa(await readSideFile(memIo({ [p]: text('wky') }).io, p, NOW), 'malformed', /host/)
    // a synced name without a host part has no host to compare
    const bare = '/h/references/side-files/waiting.json'
    expectNa(await readSideFile(memIo({ [bare]: text('WKY') }).io, bare, NOW), 'malformed', /host/)
    // a local kind's first part is a scope and is not compared with the host
    expect((await readSideFile(memIo({ [at('site-watch.s8p-01.json')]: edited(o => void (o.kind = 'site-watch')) }).io, at('site-watch.s8p-01.json'), NOW)).verdict).toBe('ok')
  })

  test('registry: the five kinds of section 9', () => {
    expect(Object.keys(KINDS).sort()).toEqual(['fixture', 'review-lane', 'site-watch', 'sync-status', 'waiting'])
    expect(KINDS['sync-status']).toMatchObject({ cls: 'local', ttlSec: 900, finalTtlSec: null })
    expect(KINDS['site-watch']).toMatchObject({ cls: 'local', ttlSec: 300, finalTtlSec: null })
    expect(KINDS.waiting).toMatchObject({ cls: 'synced', ttlSec: null, finalTtlSec: null })
  })

  test('local path: $TMPDIR/claude-side, /tmp when TMPDIR is unset or empty', () => {
    expect(sideFilePath('fixture', { tmpdir: '/var/tmp' })).toBe('/var/tmp/claude-side/fixture.json')
    expect(sideFilePath('fixture', { tmpdir: '' })).toBe('/tmp/claude-side/fixture.json')
    expect(sideFilePath('fixture', { tmpdir: undefined })).toBe('/tmp/claude-side/fixture.json')
    expect(sideFilePath('fixture', { tmpdir: '/var/tmp///' })).toBe('/var/tmp/claude-side/fixture.json')
    expect(sideFilePath('site-watch', { tmpdir: '/tmp' }, { scope: 's8p-01' })).toBe('/tmp/claude-side/site-watch.s8p-01.json')
  })

  test('synced path: the config dir, or $HOME/.claude when CLAUDE_CONFIG_DIR is unset or empty; the host is in the name', () => {
    const dir = 'projects/-project/references/side-files'
    expect(sideFilePath('waiting', { home: '/root' }, { host: 'WKY' })).toBe(`/root/.claude/${dir}/waiting.WKY.json`)
    expect(sideFilePath('waiting', { home: '/root', configDir: '' }, { host: 'WKY' })).toBe(`/root/.claude/${dir}/waiting.WKY.json`)
    expect(sideFilePath('waiting', { home: '/root', configDir: '/cfg' }, { host: 'WKY' })).toBe(`/cfg/${dir}/waiting.WKY.json`)
    expect(sideFilePath('waiting', { home: '/root' }, { host: 'WKY', scope: 'a' })).toBe(`/root/.claude/${dir}/waiting.WKY.a.json`)
  })

  test('paths that would not parse back are refused with null, never built', () => {
    expect(sideFilePath('nonesuch', { tmpdir: '/tmp' })).toBeNull()
    expect(sideFilePath('fixture', { tmpdir: '/tmp' }, { scope: 'a.b' })).toBeNull()
    expect(sideFilePath('fixture', { tmpdir: '/tmp' }, { scope: '../x' })).toBeNull()
    expect(sideFilePath('fixture', { tmpdir: '/tmp' }, { scope: '' })).toBeNull()
    expect(sideFilePath('waiting', { home: '/root' }, {})).toBeNull()
    expect(sideFilePath('waiting', { home: '/root' }, { host: 'a.b' })).toBeNull()
    expect(sideFilePath('waiting', { home: undefined }, { host: 'WKY' })).toBeNull()
    expect(sideFilePath('waiting', { home: '' }, { host: 'WKY' })).toBeNull()
  })

  test('readSideKind reads by kind and location', async () => {
    const store: Store = { '/tmp/claude-side/fixture.json': FILES['fixture.valid.json']! }
    const r = await readSideKind(memIo(store).io, 'fixture', { tmpdir: '' }, {}, NOW)
    expect(r).toMatchObject({ verdict: 'ok', data: { count: 3 } })
    expectNa(await readSideKind(memIo({}).io, 'fixture', { tmpdir: '/tmp' }, {}, NOW), 'missing', 'n/a（缺檔）')
    expectNa(await readSideKind(memIo(store).io, 'nonesuch', { tmpdir: '/tmp' }, {}, NOW), 'unknown_kind', /nonesuch/)
    expectNa(await readSideKind(memIo(store).io, 'waiting', { home: '/root' }, {}, NOW), 'bad_name', /檔名|路徑/)
  })
})

describe('side file reader: it never throws', () => {
  const textOf = (n: number) => FILES['fixture.valid.json']!.replace(/\n$/, ' '.repeat(n) + '\n')

  test('exists refuses: the answer is corrupt, not an exception', async () => {
    const { io } = memIo({}, { exists: async () => { throw new Error('EACCES') } })
    expectNa(await readSideFile(io, at('fixture.json'), NOW), 'corrupt', 'n/a（檔案損毀或被截斷）')
  })
  test('exists throws synchronously', async () => {
    const { io } = memIo({}, { exists: () => { throw new Error('boom') } })
    expect((await readSideFile(io, at('fixture.json'), NOW)).verdict).toBe('corrupt')
  })
  test('the file is there but unreadable', async () => {
    const { io } = memIo({ [at('fixture.json')]: 'x' }, { readBytes: async () => { throw new Error('EACCES') } })
    expect((await readSideFile(io, at('fixture.json'), NOW)).verdict).toBe('corrupt')
  })
  test('the read answers something that is not bytes', async () => {
    for (const odd of [undefined, null, 'text', 5, {}, [1, 2]]) {
      const { io } = memIo({ [at('fixture.json')]: 'x' }, { readBytes: async () => odd as never })
      expect((await readSideFile(io, at('fixture.json'), NOW)).verdict).toBe('corrupt')
    }
  })
  test('the answer from exists is not a boolean', async () => {
    for (const odd of [undefined, null, 0, '']) {
      const { io } = memIo({}, { exists: async () => odd as never })
      expect((await readSideFile(io, at('fixture.json'), NOW)).verdict).toBe('missing')
    }
  })
  test('a path that is not a string', async () => {
    for (const p of [undefined, null, 5, {}, []]) {
      expect((await readSideFile(memIo({}).io, p as never, NOW)).verdict).toBe('bad_name')
    }
  })
  test('a clock that is not a time', async () => {
    for (const now of [NaN, Infinity, undefined as never, null as never, 'x' as never]) {
      expectNa(await readSideFile(memIo(fixtureStore()).io, at('fixture.valid.json'), now), 'no_clock', /時刻/)
    }
  })

  test('empty, blank and BOM files are corrupt', async () => {
    const store = (text: string | Uint8Array): Store => ({ [at('fixture.json')]: text })
    for (const t of ['', ' ', '\n', '\n\n  \t', cp(0xfeff) + FILES['fixture.valid.json']!]) {
      const r = await readSideFile(memIo(store(t)).io, at('fixture.json'), NOW)
      expect([t.length, r.verdict]).toEqual([t.length, 'corrupt'])
    }
    expect((await readSideFile(memIo(store(new Uint8Array(0))).io, at('fixture.json'), NOW)).verdict).toBe('corrupt')
  })

  test('not a single JSON value: trailing content, two values, NaN, Infinity, comments, single quotes', async () => {
    const valid = FILES['fixture.valid.json']!
    const cases = [valid + '{}', valid + 'x', valid + '\n{}\n', valid.replace('"count": 3', '"count": NaN'), valid.replace('"count": 3', '"count": Infinity'), valid.replace('"count": 3', '"count": -Infinity'), '// c\n' + valid, valid.replace(/"/g, "'"), valid.replace('"count": 3', '"count": 3,'), '{"a":1}{"b":2}', valid.slice(0, 100), valid.slice(0, -2)]
    for (const t of cases) {
      const r = await readSideFile(memIo({ [at('fixture.json')]: t }).io, at('fixture.json'), NOW)
      expect([t.slice(0, 30), r.verdict]).toEqual([t.slice(0, 30), 'corrupt'])
    }
  })

  test('JSON that is not an object is malformed, not corrupt', async () => {
    for (const t of ['[]', '[1]', 'null', '"x"', '42', 'true', '[' + FILES['fixture.valid.json']! + ']']) {
      const r = await readSideFile(memIo({ [at('fixture.json')]: t }).io, at('fixture.json'), NOW)
      expectNa(r, 'malformed', /^n\/a（格式錯誤：/)
    }
  })

  test('a very deep nesting is corrupt, never a stack overflow out of the reader', async () => {
    const t = '['.repeat(60_000)
    expect((await readSideFile(memIo({ [at('fixture.json')]: t }).io, at('fixture.json'), NOW)).verdict).toBe('corrupt')
    const deep = '{"schema_version": 1, "x": ' + '['.repeat(2000) + ']'.repeat(2000) + '}'
    const r = await readSideFile(memIo({ [at('fixture.json')]: deep }).io, at('fixture.json'), NOW)
    expect(['corrupt', 'malformed']).toContain(r.verdict)
  })

  test('size: 64 KiB exactly is read, one byte more is corrupt before it is parsed', async () => {
    const exact = enc(textOf(SIDE_MAX_BYTES - FILES['fixture.valid.json']!.length))
    expect(exact.length).toBe(SIDE_MAX_BYTES)
    expect(SIDE_MAX_BYTES).toBe(65_536)
    expect((await readSideFile(memIo({ [at('fixture.json')]: exact }).io, at('fixture.json'), NOW)).verdict).toBe('ok')
    const over = enc(textOf(SIDE_MAX_BYTES + 1 - FILES['fixture.valid.json']!.length))
    expect(over.length).toBe(SIDE_MAX_BYTES + 1)
    expectNa(await readSideFile(memIo({ [at('fixture.json')]: over }).io, at('fixture.json'), NOW), 'corrupt', 'n/a（檔案損毀或被截斷）')
  })

  test('size is counted in bytes: 32768 two-byte characters in a string are 64 KiB of data, not 32 K', async () => {
    const big = edited(o => void (o.data = { pad: cp(0xe9).repeat(33_000) }))
    expect(big.length).toBeLessThan(SIDE_MAX_BYTES)
    expect(enc(big).length).toBeGreaterThan(SIDE_MAX_BYTES)
    expect((await readSideFile(memIo({ [at('fixture.json')]: big }).io, at('fixture.json'), NOW)).verdict).toBe('corrupt')
  })

  test('UTF-8 that is not UTF-8 is corrupt: stray bytes, overlongs, surrogates, cut sequences, past U+10FFFF', async () => {
    const valid = enc(FILES['fixture.valid.json']!)
    const spliced = (bytes: number[]) => {
      const at30 = valid.indexOf(0x70) // inside "producer"
      return Uint8Array.from([...valid.slice(0, at30), ...bytes, ...valid.slice(at30)])
    }
    const bad: [string, number[]][] = [
      ['stray continuation', [0x80]],
      ['0xff', [0xff]],
      ['0xfe', [0xfe]],
      ['overlong NUL', [0xc0, 0x80]],
      ['overlong slash', [0xc0, 0xaf]],
      ['overlong 3-byte', [0xe0, 0x80, 0x80]],
      ['overlong 4-byte', [0xf0, 0x80, 0x80, 0x80]],
      ['overlong letter a, 3-byte', [0xe0, 0x81, 0xa1]],
      ['overlong letter a, 4-byte', [0xf0, 0x80, 0x81, 0xa1]],
      ['surrogate D800', [0xed, 0xa0, 0x80]],
      ['surrogate DFFF', [0xed, 0xbf, 0xbf]],
      ['past U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
      ['lead 0xf5', [0xf5, 0x80, 0x80, 0x80]],
      ['two-byte cut', [0xc3]],
      ['three-byte cut', [0xe2, 0x82]],
      ['four-byte cut', [0xf0, 0x9f, 0x98]],
    ]
    for (const [name, bytes] of bad) {
      const r = await readSideFile(memIo({ [at('fixture.json')]: spliced(bytes) }).io, at('fixture.json'), NOW)
      expect([name, r.verdict]).toEqual([name, 'corrupt'])
    }
    // the neighbours that are fine: U+0080, U+07FF, U+0800, U+D7FF, U+E000, U+FFFF, U+10000, U+10FFFF as a string value
    const fine = edited(o => void (o.data = { s: [0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x10ffff].map(c => cp(c)).join('') }))
    expect((await readSideFile(memIo({ [at('fixture.json')]: fine }).io, at('fixture.json'), NOW)).verdict).toBe('ok')
  })

  test('a lone surrogate written as an escape is JSON, so it is read; it does not throw', async () => {
    const text = FILES['fixture.valid.json']!.replace('"count": 3', '"count": 3, "s": "' + cp(0x5c) + 'ud800"')
    expect((await readSideFile(memIo({ [at('fixture.json')]: text }).io, at('fixture.json'), NOW)).verdict).toBe('ok')
  })

  test('__proto__ and other hostile keys do not change what the reader sees or pollute anything', async () => {
    const text = FILES['fixture.valid.json']!.replace('"station": null,', '"station": null, "__proto__": {"polluted": true}, "constructor": 1,')
    const r = await readSideFile(memIo({ [at('fixture.json')]: text }).io, at('fixture.json'), NOW)
    expect(r.verdict).toBe('ok')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // a document that lacks kind but inherits it from the prototype chain is still missing it
    const noKind = await fixtureWith(o => void delete o.kind)
    expectNa(noKind, 'malformed', /kind/)
    const protoOnly = FILES['fixture.valid.json']!.replace('"kind": "fixture",', '"__proto__": {"kind": "fixture"},')
    expectNa(await readSideFile(memIo({ [at('fixture.json')]: protoOnly }).io, at('fixture.json'), NOW), 'malformed', /kind/)
  })

  test('text from the file is shown only where the contract shows it: error.message, nowhere else', async () => {
    const hostile = (field: string) => fixtureWith(o => void (o[field] = '<script>' + cp(0x1b) + '[31m'))
    for (const f of ['kind', 'station', 'run_id', 'collection_status']) {
      const r = await hostile(f)
      expect(r.verdict).toBe('malformed')
      if (r.verdict !== 'ok') expect(r.text).not.toContain('script')
    }
  })

  test('bytesFromBase64 inverts btoa for every length remainder and refuses what is not base64', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', cp(0xe9, 0x1f600)]) {
      const bytes = enc(s)
      const b64 = btoa(String.fromCharCode(...bytes))
      expect([s, [...(bytesFromBase64(b64) ?? [])]]).toEqual([s, [...bytes]])
    }
    for (const bad of ['a', 'abcde', '!!!!', 'ab=c', 'a===', 'ab cd', '=', 'YQ=', 'YQ']) expect([bad, bytesFromBase64(bad)]).toEqual([bad, null])
    expect(bytesFromBase64(undefined as never)).toBeNull()
  })
})

describe('side file reader: the fixture card data', () => {
  test('ok: the count and the stamp of the observation', async () => {
    expect(fixtureOf(await readFile('fixture.valid.json'))).toEqual({ ok: true, v: { count: 3, observedAtSec: Date.parse('2026-10-10T11:59:30Z') / 1000 } })
  })
  test('every other case says why, in the contract text, and carries no count', async () => {
    for (const c of MANIFEST.cases) {
      if (c.case === 'valid') continue
      const r = fixtureOf(await readFile(c.file))
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.why).toMatch(/^n\/a（/)
        expect(JSON.stringify(r)).not.toContain('count')
      }
    }
  })
  test('data.count must be an integer: a string, a float, a bool, a missing key and a huge number are n/a, never 0', async () => {
    for (const v of ['3', 3.5, true, null, undefined, 1e21, -1, [3], { n: 3 }]) {
      const r = fixtureOf(await fixtureWith(o => void (o.data = v === undefined ? {} : { count: v })))
      expect([String(v), r.ok]).toEqual([String(v), v === -1])
      if (!r.ok) expect(r.why).toMatch(/^n\/a（格式錯誤：data\.count/)
    }
  })
})
