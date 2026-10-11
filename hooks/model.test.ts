import { describe, expect, test } from 'claude-code/testing'

import { trackerCommand, trackerHooks } from './fixture'
import {
  ALL_CONFIGURED,
  HOOK_SCRIPTS,
  aggMax,
  agoText,
  allTotals,
  configuredEffort,
  countGitStatus,
  countdownSec,
  cpuPercent,
  cumJson,
  effortColor,
  effortFrom,
  emptyCum,
  fmtDur,
  fmtGb,
  fmtReset5h,
  fmtReset7d,
  fmtResetClock,
  fmtTok,
  groupAgents,
  hooksConfigured,
  mcpInfo,
  mergeSnap,
  modelLabel,
  parseCpuStat,
  parseCum,
  parseCumStrict,
  parseMeminfo,
  parseToggles,
  parseTogglesStrict,
  patchLineCount,
  pctColor,
  repoName,
  resolveEffort,
  resolveSummary,
  rlWindow,
  shortDir,
  sidOf,
  step,
} from './model'
import type { RlSnap, RlSnaps } from './model'

import type { CpuSample } from './state'

describe('#1 sid', () => {
  test('a dashed uuid becomes the 24 alphanumerics the tracker hooks name their files by', () => {
    expect(sidOf('c07353bf-22c4-47df-8296-6f2dd4b68497')).toBe('c07353bf22c447df82966f2d')
  })

  test('an empty id falls back to default, as the trackers do', () => {
    expect(sidOf('')).toBe('default')
  })

  test('only alphanumerics survive, cut at 24', () => {
    expect(sidOf('ab_cd.ef-gh/ij 0123456789ABCDEFGHIJKLMNOP')).toBe('abcdefghij0123456789ABCD')
  })
})

describe('#2 step', () => {
  test('an increase adds the delta to the total and moves the base', () => {
    expect(step({ total: 5, base: 3 }, 10)).toEqual({ total: 12, base: 10 })
  })

  test('a drop re-baselines and leaves the total alone', () => {
    expect(step({ total: 12, base: 10 }, 4)).toEqual({ total: 12, base: 4 })
  })

  test('growth after a drop counts only from the new base', () => {
    expect(step(step({ total: 12, base: 10 }, 4), 6)).toEqual({ total: 14, base: 6 })
  })

  test('an unchanged reading adds nothing', () => {
    expect(step({ total: 7, base: 7 }, 7)).toEqual({ total: 7, base: 7 })
  })

  test('the first reading of a fresh counter counts in full', () => {
    expect(step({ total: 0, base: 0 }, 2.5)).toEqual({ total: 2.5, base: 2.5 })
  })

  test('the input counter is left untouched', () => {
    const c = Object.freeze({ total: 1, base: 1 })
    step(c, 9)
    expect(c).toEqual({ total: 1, base: 1 })
  })
})

// Taken from /tmp/claude-cum-<sid>.json as statusline.js wrote it.
const REAL_CUM =
  '{"cost":{"total":17.727567999999994,"base":17.727567999999994},"dur":{"total":2115686,"base":2115686},' +
  '"add":{"total":200,"base":200},"rm":{"total":4,"base":4},"tok":{"total":318421,"base":318421}}'

describe('#2 cum file format', () => {
  test('an existing file written by statusline.js is read as it stands', () => {
    const cum = parseCum(REAL_CUM)
    expect(cum.cost).toEqual({ total: 17.727567999999994, base: 17.727567999999994 })
    expect(cum.tok).toEqual({ total: 318421, base: 318421 })
    expect(cum.rm).toEqual({ total: 4, base: 4 })
  })

  test('writing it back is byte-identical, so a rollback keeps the same totals', () => {
    expect(cumJson(parseCum(REAL_CUM))).toBe(REAL_CUM)
  })

  test('a fresh file serializes the five counters in statusline.js key order', () => {
    expect(cumJson(emptyCum())).toBe(
      '{"cost":{"total":0,"base":0},"dur":{"total":0,"base":0},"add":{"total":0,"base":0},' +
        '"rm":{"total":0,"base":0},"tok":{"total":0,"base":0}}',
    )
  })

  test('the old flat format {cost, dur, ...} migrates to total = base = value', () => {
    const cum = parseCum('{"cost":3.5,"dur":4000}')
    expect(cum.cost).toEqual({ total: 3.5, base: 3.5 })
    expect(cum.dur).toEqual({ total: 4000, base: 4000 })
    expect(cum.add).toEqual({ total: 0, base: 0 })
  })

  test('a missing file or broken JSON reads as an empty cum', () => {
    expect(parseCum(null)).toEqual(emptyCum())
    expect(parseCum('{"cost":')).toEqual(emptyCum())
    expect(parseCum('[1,2]')).toEqual(emptyCum())
  })

  test('a counter with a non-numeric field is reset instead of poisoning the sums', () => {
    const cum = parseCum('{"cost":{"total":"x","base":2},"dur":{"total":5}}')
    expect(cum.cost).toEqual({ total: 0, base: 2 })
    expect(cum.dur).toEqual({ total: 5, base: 0 })
  })
})

const NOW = 1_000_000
const DAY = 86_400
const win = (used: number, resetsIn: number) => ({ used_percentage: used, resets_at: NOW + resetsIn })
const snap = (age: number, five: RlSnap['five_hour'], seven: RlSnap['seven_day'] = null): RlSnap => ({
  t: NOW - age,
  five_hour: five,
  seven_day: seven,
})

describe('R23 strict cum parsing', () => {
  test('a text that is not a JSON object is null, never an empty cum', () => {
    for (const text of ['', '{"cost":', '[1,2]', 'null', '"x"', '12']) expect(parseCumStrict(text)).toBeNull()
  })

  test('an object parses as parseCum reads it, an empty one as zeros', () => {
    expect(parseCumStrict(REAL_CUM)).toEqual(parseCum(REAL_CUM))
    expect(parseCumStrict('{}')).toEqual(emptyCum())
    expect(parseCumStrict('{"cost":3.5}')).toMatchObject({ cost: { total: 3.5, base: 3.5 } })
  })

  test('a number that is not finite (1e999 parses as Infinity) reads as zero', () => {
    expect(parseCumStrict('{"cost":1e999,"tok":{"total":1e999,"base":5}}')).toMatchObject({
      cost: { total: 0, base: 0 },
      tok: { total: 0, base: 5 },
    })
  })
})

describe('R22 strict toggles parsing', () => {
  test('a text that is not a JSON object is null, so the caller can keep what it had', () => {
    for (const text of ['', '{"enabled":', '[1]', 'null', '"x"']) expect(parseTogglesStrict(text)).toBeNull()
  })

  test('an object parses as parseToggles reads it', () => {
    expect(parseTogglesStrict('{"quota":false}')).toEqual(parseToggles('{"quota":false}'))
    expect(parseTogglesStrict('{"enabled":false}')?.enabled).toBe(false)
    expect(parseTogglesStrict('{}')).toEqual(parseToggles(null))
  })
})

describe('#3 aggMax', () => {
  test('an entry older than 300 s is dropped, one exactly 300 s old is kept', () => {
    const snaps: RlSnaps = {
      a: snap(10, win(40, 1000)),
      b: snap(301, win(90, 1000)),
      c: snap(300, win(55, 1000)),
    }
    expect(aggMax(snaps, 'five_hour', null, NOW)).toBe(55)
    expect(aggMax({ a: snaps.a!, b: snaps.b! }, 'five_hour', null, NOW)).toBe(40)
  })

  test('a reset more than 8 days ahead is dropped, exactly 8 days is kept', () => {
    const snaps: RlSnaps = {
      far: snap(0, win(99, 8 * DAY + 1)),
      edge: snap(0, win(61, 8 * DAY)),
      near: snap(0, win(30, 1000)),
    }
    expect(aggMax(snaps, 'five_hour', null, NOW)).toBe(61)
    expect(aggMax({ far: snaps.far!, near: snaps.near! }, 'five_hour', null, NOW)).toBe(30)
  })

  test('the group with the latest resets_at wins, and the max inside it', () => {
    const snaps: RlSnaps = {
      old: snap(0, win(80, 1000)),
      x: snap(0, win(20, 5000)),
      y: snap(0, win(35, 5000)),
    }
    expect(aggMax(snaps, 'five_hour', null, NOW)).toBe(35)
  })

  test('with no live entry the own window answers, when it has not rolled over', () => {
    expect(aggMax({}, 'five_hour', win(42, 500), NOW)).toBe(42)
    expect(aggMax({ gone: snap(0, win(77, -1)) }, 'five_hour', win(42, 500), NOW)).toBe(42)
  })

  test('everything rolled over reads 0', () => {
    expect(aggMax({ gone: snap(0, win(77, -1)) }, 'five_hour', null, NOW)).toBe(0)
    expect(aggMax({ gone: snap(0, win(77, 0)) }, 'five_hour', win(50, -5), NOW)).toBe(0)
    expect(aggMax({}, 'five_hour', null, NOW)).toBe(0)
  })

  test('each field aggregates on its own, and a null window is skipped', () => {
    const snaps: RlSnaps = {
      a: snap(0, win(10, 1000), win(60, 2 * DAY)),
      b: snap(0, null, win(70, 2 * DAY)),
    }
    expect(aggMax(snaps, 'five_hour', null, NOW)).toBe(10)
    expect(aggMax(snaps, 'seven_day', null, NOW)).toBe(70)
  })
})

describe('#3 mergeSnap', () => {
  test('sets the own entry and drops entries that are older than 300 s or have no t', () => {
    const before = {
      fresh: snap(299, win(1, 1000)),
      stale: snap(301, win(2, 1000)),
      broken: { five_hour: null, seven_day: null } as unknown as RlSnap,
    }
    const mine = snap(0, win(33, 900))
    const after = mergeSnap(before, 'me', mine, NOW)
    expect(Object.keys(after).sort()).toEqual(['fresh', 'me'])
    expect(after.me).toEqual(mine)
  })

  test('replaces an earlier own entry and leaves its input unchanged', () => {
    const before: RlSnaps = { me: snap(100, win(5, 500)) }
    const mine = snap(0, win(6, 600))
    const after = mergeSnap(before, 'me', mine, NOW)
    expect(after.me).toEqual(mine)
    expect(before.me).toEqual(snap(100, win(5, 500)))
  })
})

describe('#4 countdown', () => {
  const FIVE_H = 5 * 3600
  const SEVEN_D = 7 * 86_400

  test('before the reset it is the plain distance', () => {
    expect(countdownSec(NOW + 4000, FIVE_H, NOW)).toBe(4000)
  })

  test('after the reset passed it wraps by the period', () => {
    expect(countdownSec(NOW - 100, FIVE_H, NOW)).toBe(17_900)
    expect(countdownSec(NOW - (FIVE_H + 50), FIVE_H, NOW)).toBe(17_950)
    expect(countdownSec(NOW - 3600, SEVEN_D, NOW)).toBe(601_200)
  })

  test('a reset exactly one period back or exactly now shows a full period', () => {
    expect(countdownSec(NOW - FIVE_H, FIVE_H, NOW)).toBe(FIVE_H)
    expect(countdownSec(NOW, FIVE_H, NOW)).toBe(FIVE_H)
  })

  test('no reset time means no countdown', () => {
    expect(countdownSec(null, FIVE_H, NOW)).toBeNull()
    expect(countdownSec(undefined, FIVE_H, NOW)).toBeNull()
    expect(countdownSec(0, FIVE_H, NOW)).toBeNull()
  })

  test('the 5h quota reads hours and minutes, the 7d quota days and hours', () => {
    expect(fmtReset5h(7800)).toBe('2h 10m')
    expect(fmtReset5h(59)).toBe('0h 0m')
    expect(fmtReset7d(3 * 86_400 + 4 * 3600 + 99)).toBe('3d 4h')
    expect(fmtReset7d(86_399)).toBe('0d 23h')
  })
})

describe('#5 patch line count', () => {
  const edit = (lines: string[][]) => ({
    result: { filePath: '/a', structuredPatch: lines.map(l => ({ oldStart: 1, newStart: 1, lines: l })) },
  })

  test('+ and - lines are counted, context lines are not', () => {
    const ran = edit([[' keep', '-old', '+new1', '+new2', ' keep'], ['-gone']])
    expect(patchLineCount(ran)).toEqual({ add: 2, rm: 2 })
  })

  test('a removed line that itself starts with dashes still counts once', () => {
    expect(patchLineCount(edit([['--- a comment', '+++ b comment']]))).toEqual({ add: 1, rm: 1 })
  })

  test('a Write that creates a file with an empty patch counts every line of content as added', () => {
    const create = (content: string) => ({ result: { type: 'create', content, structuredPatch: [] } })
    expect(patchLineCount(create('a\nb\nc\n'))).toEqual({ add: 3, rm: 0 })
    expect(patchLineCount(create('a\nb'))).toEqual({ add: 2, rm: 0 })
    expect(patchLineCount(create('one'))).toEqual({ add: 1, rm: 0 })
    expect(patchLineCount(create(''))).toEqual({ add: 0, rm: 0 })
  })

  test('a Write that updates a file counts its patch, and a create with a patch does not count twice', () => {
    const patch = [{ oldStart: 1, newStart: 1, lines: ['-x', '+y', '+z'] }]
    expect(patchLineCount({ result: { type: 'update', content: 'y\nz\n', structuredPatch: patch } })).toEqual({
      add: 2,
      rm: 1,
    })
    expect(patchLineCount({ result: { type: 'create', content: 'y\nz\n', structuredPatch: patch } })).toEqual({
      add: 2,
      rm: 1,
    })
  })

  test('an error result counts 0 even when a patch rides along', () => {
    const ran = { isError: true, text: 'boom', result: { structuredPatch: [{ lines: ['+a', '-b'] }] } }
    expect(patchLineCount(ran)).toEqual({ add: 0, rm: 0 })
  })

  test('a denied call and an edit held back for review count 0', () => {
    expect(patchLineCount({ deny: 'not here' })).toEqual({ add: 0, rm: 0 })
    expect(patchLineCount({ deny: 'not here', result: { structuredPatch: [{ lines: ['+a'] }] } })).toEqual({
      add: 0,
      rm: 0,
    })
    const staged = { result: { staged: true, structuredPatch: [{ lines: ['+a'] }] } }
    expect(patchLineCount(staged)).toEqual({ add: 0, rm: 0 })
  })

  test('a result without a patch, or junk, counts 0', () => {
    expect(patchLineCount({ result: { stdout: '+1 line' } })).toEqual({ add: 0, rm: 0 })
    expect(patchLineCount({ result: { structuredPatch: [{ oldStart: 1 }, null, 'x'] } })).toEqual({ add: 0, rm: 0 })
    expect(patchLineCount(undefined)).toEqual({ add: 0, rm: 0 })
    expect(patchLineCount('text')).toEqual({ add: 0, rm: 0 })
  })
})

describe('#6 CPU delta', () => {
  // user nice system idle iowait irq softirq steal guest guest_nice
  const stat = (fields: string) => `cpu  ${fields}\ncpu0 1 1 1 1 1 1 1 0 0 0\ncpu1 2 2 2 2 2 2 2 0 0 0\nintr 5 6 7\n`

  test('the aggregate cpu line gives idle and the five counters os.cpus() sums', () => {
    expect(parseCpuStat(stat('100 0 50 800 10 0 5 0 0 0'))).toEqual({ idle: 800, total: 950 })
    expect(parseCpuStat(stat('1 2 3 4 5 6 7 8 9 10'))).toEqual({ idle: 4, total: 1 + 2 + 3 + 4 + 6 })
  })

  test('a text without an aggregate cpu line parses to null', () => {
    expect(parseCpuStat('cpu0 1 1 1 1 1 1 1\nintr 5\n')).toBeNull()
    expect(parseCpuStat('')).toBeNull()
    expect(parseCpuStat('cpu  x y z')).toBeNull()
  })

  test('two samples give the busy share of the interval', () => {
    const a = parseCpuStat(stat('100 0 50 800 10 0 5 0 0 0'))!
    const b = parseCpuStat(stat('160 0 90 840 20 0 9 0 0 0'))!
    expect(cpuPercent(a, b)).toBe(71)
  })

  test('the first sample has nothing to compare against and reads n/a', () => {
    expect(cpuPercent(null, { idle: 800, total: 950 })).toBeNull()
  })

  test('an interval with no progress, or counters that went backwards, reads 0', () => {
    const s: CpuSample = { idle: 800, total: 950 }
    expect(cpuPercent(s, s)).toBe(0)
    expect(cpuPercent({ idle: 900, total: 2000 }, s)).toBe(0)
  })

  test('a fully busy and a fully idle interval hit the ends of the scale', () => {
    expect(cpuPercent({ idle: 10, total: 100 }, { idle: 10, total: 200 })).toBe(100)
    expect(cpuPercent({ idle: 10, total: 100 }, { idle: 110, total: 200 })).toBe(0)
  })
})

describe('#7 meminfo', () => {
  const info = (total: number, available: number) =>
    `MemTotal:       ${total} kB\nMemFree:         1024 kB\nMemAvailable:   ${available} kB\nBuffers:          512 kB\n`

  test('used is MemTotal minus MemAvailable, with its share of the total', () => {
    expect(parseMeminfo(info(16_384_000, 9_000_000))).toEqual({ usedKb: 7_384_000, totalKb: 16_384_000, pct: 45 })
  })

  test('half of 16 GiB used reads 50% and 8.0/16.0 GB', () => {
    const m = parseMeminfo(info(16_777_216, 8_388_608))!
    expect(m.pct).toBe(50)
    expect(`${fmtGb(m.usedKb)}/${fmtGb(m.totalKb)} GB`).toBe('8.0/16.0 GB')
  })

  test('GB is kB over 1024 twice, to one decimal', () => {
    expect(fmtGb(7_384_000)).toBe('7.0')
    expect(fmtGb(16_384_000)).toBe('15.6')
  })

  test('a text missing MemTotal or MemAvailable, or with a zero total, parses to null', () => {
    expect(parseMeminfo('MemFree: 5 kB\n')).toBeNull()
    expect(parseMeminfo('MemTotal: 100 kB\nMemFree: 5 kB\n')).toBeNull()
    expect(parseMeminfo('MemTotal: 0 kB\nMemAvailable: 0 kB\n')).toBeNull()
    expect(parseMeminfo('')).toBeNull()
  })

  test('available above total never shows negative use', () => {
    expect(parseMeminfo(info(1000, 1500))).toEqual({ usedKb: 0, totalKb: 1000, pct: 0 })
  })
})

describe('#8 row toggles file', () => {
  const REAL_ROWS = `{
  "enabled": true, "summary": true, "dir": true, "repo": true, "model": true, "cost": true,
  "usage": true, "quota": true, "agents": true, "memory_mcp": true, "edited": true,
  "history": true, "summaryInterval": 30
}`
  // `fixture` is opt-in and has its own test below
  const off = (t: ReturnType<typeof parseToggles>) => Object.entries(t.rows).filter(([k, on]) => !on && k !== 'fixture' && k !== 'waiting').map(([k]) => k)

  test('fixture is the one row that is off until the file turns it on', () => {
    for (const text of [null, '', '{}', REAL_ROWS, '{"fixture":false}', '{"fixture":0}', '{"fixture":""}']) expect(parseToggles(text).rows.fixture).toBe(false)
    expect(parseToggles('{"fixture":true}').rows.fixture).toBe(true)
    // an opt-in row turns on only for the boolean true; any other truthy value leaves it off
    for (const text of ['{"fixture":1}', '{"fixture":"yes"}', '{"fixture":"true"}', '{"fixture":[1]}']) expect(parseToggles(text).rows.fixture).toBe(false)
    // a row that is on by default keeps the loose reading: only a falsy value switches it off
    expect(parseToggles('{"cost":1}').rows.cost).toBe(true)
  })

  test('a missing or unreadable file means everything on', () => {
    for (const text of [null, '', '{"enabled":', 'null', '[1]']) {
      const t = parseToggles(text)
      expect(t.enabled).toBe(true)
      expect(off(t)).toEqual([])
    }
  })

  test('the current file has no sys key, so sys stays on', () => {
    const t = parseToggles(REAL_ROWS)
    expect(t.enabled).toBe(true)
    expect(t.rows.sys).toBe(true)
    expect(off(t)).toEqual([])
  })

  test('enabled:false is the master switch and leaves the row flags as they were', () => {
    const t = parseToggles('{"enabled":false,"quota":false}')
    expect(t.enabled).toBe(false)
    expect(off(t)).toEqual(['quota'])
  })

  test('one key off clears only that row; truthiness decides, as in statusline.js', () => {
    expect(off(parseToggles('{"quota":false}'))).toEqual(['quota'])
    expect(off(parseToggles('{"sys":0,"edited":1,"agents":"","cost":"yes"}'))).toEqual(['agents', 'sys'])
  })

  test('keys it does not know are ignored', () => {
    expect(off(parseToggles('{"nope":false,"summaryInterval":0}'))).toEqual([])
  })
})

describe('formatters', () => {
  test('fmtDur: minutes under an hour, hr and min under a day, d and hr beyond', () => {
    expect(fmtDur(0)).toBe('0min')
    expect(fmtDur(59)).toBe('59min')
    expect(fmtDur(60)).toBe('1hr')
    expect(fmtDur(80)).toBe('1hr 20min')
    expect(fmtDur(1439)).toBe('23hr 59min')
    expect(fmtDur(1440)).toBe('1d')
    expect(fmtDur(1440 + 3 * 60 + 30)).toBe('1d 3hr')
    expect(fmtDur(2 * 1440)).toBe('2d')
  })

  test('fmtTok: plain under 1000, then K, M, B with one decimal', () => {
    expect(fmtTok(0)).toBe('0')
    expect(fmtTok(999)).toBe('999')
    expect(fmtTok(1000)).toBe('1.0K')
    expect(fmtTok(32_000)).toBe('32.0K')
    expect(fmtTok(1_234_567)).toBe('1.2M')
    expect(fmtTok(2_500_000_000)).toBe('2.5B')
  })

  test('agoText: now under a minute, minutes under an hour, then hours', () => {
    const NOW_MS = 10_000_000
    expect(agoText(NOW_MS, NOW_MS - 20_000)).toBe('now')
    expect(agoText(NOW_MS, NOW_MS - 5 * 60_000)).toBe('5m ago')
    expect(agoText(NOW_MS, NOW_MS - 59 * 60_000)).toBe('59m ago')
    expect(agoText(NOW_MS, NOW_MS - 125 * 60_000)).toBe('2h ago')
  })


  test('pctColor: green below 50, yellow from 50, red from 80', () => {
    expect([0, 49, 50, 79, 80, 100].map(pctColor)).toEqual(['green', 'green', 'yellow', 'yellow', 'red', 'red'])
  })

  test('fmtResetClock: the countdown run forward, HH:MM on the day of the start, the weekday on another day or when asked', () => {
    const at = Date.UTC(2026, 9, 9, 22, 30, 0)
    // 2026-10-09 is a Friday
    expect(fmtResetClock(at, 3600, 0, false)).toBe('23:30')
    expect(fmtResetClock(at, 3600, 0, true)).toBe('Fri 23:30')
    expect(fmtResetClock(at, 3 * 3600, 0, false)).toBe('Sat 01:30')
    expect(fmtResetClock(at, 90 * 60 - 1, 0, false)).toBe('23:59')
    expect(fmtResetClock(at, 90 * 60, 0, false)).toBe('Sat 00:00')
    expect(fmtResetClock(at, 3 * 86_400, 0, true)).toBe('Mon 22:30')
    expect(fmtResetClock(at, 7 * 86_400, 0, false)).toBe('Fri 22:30')
    expect(fmtResetClock(at, 0, 0, false)).toBe('22:30')
    // the same day of another month or year is another day
    expect(fmtResetClock(at, 31 * 86_400, 0, false)).toBe('Mon 22:30')
    expect(fmtResetClock(Date.UTC(2026, 11, 9, 10, 0, 0), 365 * 86_400, 0, false)).toBe('Thu 10:00')
    // across a month and a year
    expect(fmtResetClock(Date.UTC(2026, 11, 31, 23, 0, 0), 2 * 3600, 0, false)).toBe('Fri 01:00')
    expect(fmtResetClock(Date.UTC(2026, 9, 31, 23, 0, 0), 2 * 3600, 0, false)).toBe('Sun 01:00')
  })

  test('fmtResetClock: the zone moves the clock and the day with it', () => {
    const at = Date.UTC(2026, 9, 9, 22, 30, 0)
    expect(fmtResetClock(at, 3600, 480, false)).toBe('07:30')
    // 22:30 UTC is already Saturday 06:30 at +8, so 3 h on is the same day there
    expect(fmtResetClock(at, 3 * 3600, 480, false)).toBe('09:30')
    expect(fmtResetClock(at, 3 * 3600, 480, true)).toBe('Sat 09:30')
    expect(fmtResetClock(at, 3 * 3600, -300, false)).toBe('20:30')
    expect(fmtResetClock(at, 3 * 3600, -300, true)).toBe('Fri 20:30')
  })

  test('fmtResetClock: with no zone given it reads this machine, as the liveness does', () => {
    const at = Date.UTC(2026, 9, 9, 22, 30, 0)
    const local = (ms: number) => `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}`
    const sec = 2 * 3600 + 15 * 60
    const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'short' })
    const same = new Date(at).toDateString() === new Date(at + sec * 1000).toDateString()
    expect(fmtResetClock(at, sec, undefined, false)).toBe(same ? local(at + sec * 1000) : `${day(at + sec * 1000)} ${local(at + sec * 1000)}`)
    expect(fmtResetClock(at, sec, undefined, true)).toBe(`${day(at + sec * 1000)} ${local(at + sec * 1000)}`)
  })

  test('effortColor: low dim, default and medium green, high yellow, xhigh orange, max red, unknown green', () => {
    expect(effortColor('low')).toEqual({ dim: true })
    expect(effortColor('default')).toEqual({ color: 'green' })
    expect(effortColor('medium')).toEqual({ color: 'green' })
    expect(effortColor('high')).toEqual({ color: 'yellow' })
    expect(effortColor('xhigh')).toEqual({ color: '#ff8700' })
    expect(effortColor('max')).toEqual({ color: 'red' })
    expect(effortColor('turbo')).toEqual({ color: 'green' })
  })
})

describe('agents grouping', () => {
  const file = {
    id1: { name: 'Explore', status: 'done', started: 1, finished: 1000 },
    id2: { name: 'Explore', status: 'done', started: 2, finished: 3000 },
    id3: { name: 'Explore', status: 'running', started: 3 },
    id4: { name: 'general-purpose', status: 'done', finished: 2000 },
    id5: { name: 'critic', status: 'done', finished: 5000 },
    id6: { name: 'zeta', status: 'done', finished: 4000 },
    'old-name-key': { status: 'done', finished: 10 },
  }

  test('instances of one name are grouped, running names first, then the latest finish, three at most', () => {
    expect(groupAgents(file)).toEqual([
      { name: 'Explore', running: 1, done: 2, latest: 3000 },
      { name: 'critic', running: 0, done: 1, latest: 5000 },
      { name: 'zeta', running: 0, done: 1, latest: 4000 },
    ])
  })

  test('the old format, keyed by name with no name field, still groups under the key', () => {
    expect(groupAgents({ 'old-name-key': { status: 'done', finished: 10 } })).toEqual([
      { name: 'old-name-key', running: 0, done: 1, latest: 10 },
    ])
  })

  test('anything that is not an entry list groups to nothing', () => {
    expect(groupAgents(null)).toEqual([])
    expect(groupAgents([1, 2])).toEqual([])
    expect(groupAgents({ a: 'x', b: null })).toEqual([])
  })
})

describe('collector helpers', () => {
  test('shortDir: ~ under home on a path boundary, else the last two components', () => {
    expect(shortDir('/root/project', '/root')).toBe('~/project')
    expect(shortDir('/root/a/b', '/root/')).toBe('~/a/b')
    expect(shortDir('/root', '/root')).toBe('~')
    expect(shortDir('/root2/x', '/root')).toBe('root2/x')
    expect(shortDir('/project/a/b/c', '/root')).toBe('b/c')
    expect(shortDir('/project', '/root')).toBe('/project')
    expect(shortDir('/srv/app', undefined)).toBe('srv/app')
    expect(shortDir('', '/root')).toBe('')
  })

  test('countGitStatus: ?? untracked, a code containing A added, anything else modified', () => {
    const porcelain = [
      '?? new.txt',
      'A  added.txt',
      ' A intent-to-add',
      ' M mod.txt',
      'MM both.txt',
      'AM add-then-edit',
      ' D gone',
      'R  a -> b',
      '',
    ].join('\n')
    expect(countGitStatus(porcelain)).toEqual({ added: 3, modified: 4, untracked: 1 })
    expect(countGitStatus('')).toEqual({ added: 0, modified: 0, untracked: 0 })
  })

  test('repoName: owner/repo from the remote, else the top-level directory name', () => {
    expect(repoName('git@github.com:wky-org/claude-memory.git', '/x')).toBe('wky-org/claude-memory')
    expect(repoName('https://github.com/aa1287221/agent-roundtable', '/x')).toBe('aa1287221/agent-roundtable')
    expect(repoName('', '/root/x/proj')).toBe('proj')
    expect(repoName('', '')).toBe('')
  })

  test('resolveSummary: the summary file, then the first user message, then the session id', () => {
    const msgs = [
      { r: 'a', t: 'assistant first' },
      { r: 'u', t: 'first\nuser   message' },
      { r: 'u', t: 'second' },
    ]
    const sid = 'c07353bf22c447df82966f2d'
    expect(resolveSummary('My summary\nsecond line', msgs, sid)).toBe('My summary')
    expect(resolveSummary('\n\n  Hello  \n', msgs, sid)).toBe('Hello')
    expect(resolveSummary('y'.repeat(600), msgs, sid)).toBe('y'.repeat(500))
    expect(resolveSummary('   \n', msgs, sid)).toBe('first user   message')
    expect(resolveSummary(null, msgs, sid)).toBe('first user   message')
    expect(resolveSummary(null, [{ r: 'u', t: 'z'.repeat(90) }], sid)).toBe('z'.repeat(60))
    expect(resolveSummary(null, [{ r: 'a', t: 'only assistant' }, { r: 'u' }, null], sid)).toBe('session c07353bf')
    // R12: the first user entry decides, even when it is empty (statusline.js L572-576)
    expect(resolveSummary(null, [{ r: 'u', t: '  \n ' }, { r: 'u', t: 'second' }], sid)).toBe('session c07353bf')
    expect(resolveSummary(null, [{ r: 'u' }, { r: 'u', t: 'second' }], sid)).toBe('session c07353bf')
    expect(resolveSummary(null, 'not a list', sid)).toBe('session c07353bf')
    expect(resolveSummary(null, null, sid)).toBe('session c07353bf')
  })

  test('mcpInfo: counts, and the servers that are not connected with a short name and an auth flag', () => {
    const cache = {
      updated: 1,
      servers: {
        'claude.ai Notion': { status: 'connected' },
        'plugin:figma:figma': { status: 'failed' },
        'claude.ai Gmail': { status: 'auth' },
        notion: { status: 'disconnected' },
      },
    }
    expect(mcpInfo(cache)).toEqual({
      total: 4,
      healthy: 1,
      bad: [
        { name: 'figma', isAuth: false },
        { name: 'Gmail', isAuth: true },
        { name: 'notion', isAuth: false },
      ],
    })
    expect(mcpInfo({ servers: { a: { status: 'connected' }, b: { status: 'connected' } } })).toEqual({
      total: 2,
      healthy: 2,
      bad: [],
    })
    expect(mcpInfo({ servers: {} })).toBeNull()
    expect(mcpInfo({})).toBeNull()
    expect(mcpInfo(null)).toBeNull()
  })

  test('effortFrom: the level of a hook input, lower-cased; none for subagents or a bare string', () => {
    expect(effortFrom({ effort: { level: 'XHigh' } })).toBe('xhigh')
    expect(effortFrom({ effort: { level: 'high' }, agent_id: undefined })).toBe('high')
    expect(effortFrom({ effort: { level: 'high' }, agent_id: 'a1' })).toBeNull()
    expect(effortFrom({ effort: { level: 'high' }, agentId: 'a1' })).toBeNull()
    expect(effortFrom({ effort: 'high' })).toBeNull()
    expect(effortFrom({ effort: { level: '' } })).toBeNull()
    expect(effortFrom({})).toBeNull()
    expect(effortFrom(null)).toBeNull()
  })

  test('resolveEffort (L2): the newest hook level, then CLAUDE_EFFORT, else unknown; no file or settings', () => {
    expect(resolveEffort({ hook: 'xhigh', env: 'low' })).toBe('xhigh')
    expect(resolveEffort({ hook: null, env: 'Low' })).toBe('low')
    expect(resolveEffort({ hook: null, env: ' medium ' })).toBe('medium')
    expect(resolveEffort({ hook: null, env: undefined })).toBeNull()
    expect(resolveEffort({ hook: null, env: '  ' })).toBeNull()
    expect(resolveEffort({ hook: '', env: 'high' })).toBe('high')
  })

  test('configuredEffort: the top-level effortLevel beats any modelSettings entry', () => {
    const settings = { effortLevel: 'High', modelSettings: { 'claude-opus-5': { effortLevel: 'low' } } }
    expect(configuredEffort([settings], 'claude-opus-5-5')).toBe('high')
    expect(configuredEffort([{ modelSettings: { 'claude-opus-5': { effortLevel: 'low' } } }], 'claude-opus-5-5')).toBe('low')
  })

  test('configuredEffort: of the modelSettings keys that are a prefix of the model id the longest wins', () => {
    const modelSettings = {
      'claude-opus': { effortLevel: 'low' },
      'claude-opus-5': { effortLevel: 'medium' },
      'claude-opus-5-5': { effortLevel: 'xhigh' },
      'claude-sonnet': { effortLevel: 'max' },
      'opus-5': { effortLevel: 'max' },
    }
    expect(configuredEffort([{ modelSettings }], 'claude-opus-5-5[1m]')).toBe('xhigh')
    expect(configuredEffort([{ modelSettings }], 'claude-opus-5-1')).toBe('medium')
    expect(configuredEffort([{ modelSettings }], 'claude-opus-4-8')).toBe('low')
    expect(configuredEffort([{ modelSettings }], 'claude-haiku-5')).toBeNull()
    // a key longer than the id is not a prefix of it
    expect(configuredEffort([{ modelSettings }], 'claude-opus-5-')).toBe('medium')
  })

  test('configuredEffort: an entry with no usable level is passed over for a shorter one; case does not matter', () => {
    const modelSettings = { 'claude-opus-5-5': { thinking: true }, 'claude-opus-5': { effortLevel: ' MAX ' }, 'claude-opus': { effortLevel: 3 } }
    expect(configuredEffort([{ modelSettings }], 'Claude-Opus-5-5')).toBe('max')
    expect(configuredEffort([{ modelSettings: { 'CLAUDE-OPUS-5': { effortLevel: 'high' } } }], 'claude-opus-5-5')).toBe('high')
  })

  test('configuredEffort: nothing configured is null, whatever else the settings hold', () => {
    expect(configuredEffort([], 'claude-opus-5-5')).toBeNull()
    expect(configuredEffort([{}, null, 'text', 7], 'claude-opus-5-5')).toBeNull()
    expect(configuredEffort([{ effortLevel: '', modelSettings: 'oops' }], 'claude-opus-5-5')).toBeNull()
    expect(configuredEffort([{ effortLevel: 5, modelSettings: { '': { effortLevel: 'low' }, x: null } }], 'claude-opus-5-5')).toBeNull()
    expect(configuredEffort([{ modelSettings: { 'claude-opus-5': {} } }], 'claude-opus-5-5')).toBeNull()
  })

  test('configuredEffort: the sources come highest first; a key the merge hid is found, and a tie goes to the higher source', () => {
    const merged = { modelSettings: { 'claude-sonnet': { effortLevel: 'low' } } }
    const user = { modelSettings: { 'claude-opus-5': { effortLevel: 'medium' } } }
    const project = { modelSettings: { 'claude-opus-5': { effortLevel: 'high' } } }
    expect(configuredEffort([merged, project, user], 'claude-opus-5-5')).toBe('high')
    expect(configuredEffort([merged, user, project], 'claude-opus-5-5')).toBe('medium')
    // a longer key in a lower source beats a shorter one in a higher source
    const longer = { modelSettings: { 'claude-opus-5-5': { effortLevel: 'max' } } }
    expect(configuredEffort([merged, project, longer], 'claude-opus-5-5')).toBe('max')
    // a top-level level in any source beats every modelSettings entry
    expect(configuredEffort([merged, project, { effortLevel: 'low' }], 'claude-opus-5-5')).toBe('low')
  })

  test('rlWindow: percentUsed and the ISO reset time as epoch seconds', () => {
    expect(rlWindow({ percentUsed: 32, resetsAt: '2026-10-08T20:10:00Z' })).toEqual({
      used_percentage: 32,
      resets_at: 1_791_490_200,
    })
    expect(rlWindow({ percentUsed: 7.5, resetsAt: '2026-10-12T01:00:00.000+00:00' })).toEqual({
      used_percentage: 7.5,
      resets_at: 1_791_766_800,
    })
    expect(rlWindow({ percentUsed: 5 })).toBeNull()
    expect(rlWindow({ percentUsed: 5, resetsAt: 'soon' })).toBeNull()
    expect(rlWindow(undefined)).toBeNull()
  })

  test('allTotals: cost and tokens summed over every cum file, an unreadable one counting 0', () => {
    const one = '{"cost":{"total":1.5,"base":1.5},"tok":{"total":100,"base":100}}'
    const two = '{"cost":{"total":2.25,"base":2},"tok":{"total":50,"base":50}}'
    expect(allTotals([one, two, '{"cost":', null])).toEqual({ cost: 3.75, tok: 150 })
    expect(allTotals([])).toEqual({ cost: 0, tok: 0 })
  })
})

describe('L1 model label', () => {
  const cases: [string, string][] = [
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-opus-5-5[1m]', 'Opus 5.5 [1m]'],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
    ['claude-3-5-sonnet-20241022', 'Sonnet 3.5'],
    ['claude-haiku-4-5', 'Haiku 4.5'],
    ['claude-opus-5', 'Opus 5'],
    ['claude-sonnet-4-20250514[1m]', 'Sonnet 4 [1m]'],
  ]
  for (const [id, label] of cases) {
    test(`${id} reads ${label}`, () => {
      expect(modelLabel(id)).toBe(label)
    })
  }

  test('a display name loses its brand word, as before', () => {
    expect(modelLabel('Claude Opus 5.5')).toBe('Opus 5.5')
    expect(modelLabel('Opus 5.5')).toBe('Opus 5.5')
  })

  test('anything that does not parse as an id is shown verbatim', () => {
    for (const raw of [
      'claude-opus',
      'claude-opus-5-5-thinking',
      'claude-3-sonnet-4',
      'us.anthropic.claude-opus-4-5-20251101-v1:0',
      'gpt-5',
      'my-claude-opus-5-5',
      '',
    ]) {
      expect(modelLabel(raw)).toBe(raw)
    }
  })
})

describe('dependencies: the tracker hooks the settings wire', () => {
  /** Settings with `hooks` of the given events, each running the given commands. */
  const settingsOf = (hooks: Record<string, string[]>) => ({
    hooks: Object.fromEntries(
      Object.entries(hooks).map(([event, commands]) => [event, [{ hooks: commands.map(command => ({ type: 'command', command })) }]]),
    ),
  })
  const none = { agents: false, edited: false, summary: false, messages: false, compact: false }

  test('the settings as this machine has them wire all five', () => {
    expect(hooksConfigured({ hooks: trackerHooks() })).toEqual(ALL_CONFIGURED)
  })

  test('each dependency is a script and the events it must be wired to', () => {
    expect(HOOK_SCRIPTS).toEqual({
      agents: { script: 'subagent-tracker.js', events: ['SubagentStart', 'SubagentStop'] },
      edited: { script: 'file-tracker.js', events: ['PostToolUse'] },
      summary: { script: 'summary-updater.js', events: ['UserPromptSubmit'] },
      messages: { script: 'message-tracker.js', events: ['UserPromptSubmit', 'Stop'] },
      compact: { script: 'compact-monitor.js', events: ['PreCompact'] },
    })
  })

  test('the subagent tracker counts on SubagentStart or SubagentStop alone', () => {
    const one = (event: string) => hooksConfigured(settingsOf({ [event]: ['node subagent-tracker.js'] }))
    expect(one('SubagentStart')).toEqual({ ...none, agents: true })
    expect(one('SubagentStop')).toEqual({ ...none, agents: true })
    expect(one('Stop')).toEqual(none)
  })

  test('the message tracker counts on UserPromptSubmit or Stop, the summary updater on UserPromptSubmit only', () => {
    const at = (event: string, script: string) => hooksConfigured(settingsOf({ [event]: [`node ${script}`] }))
    expect(at('UserPromptSubmit', 'message-tracker.js')).toEqual({ ...none, messages: true })
    expect(at('Stop', 'message-tracker.js')).toEqual({ ...none, messages: true })
    expect(at('UserPromptSubmit', 'summary-updater.js')).toEqual({ ...none, summary: true })
    expect(at('Stop', 'summary-updater.js')).toEqual(none)
  })

  test('the file tracker needs PostToolUse and the compact monitor PreCompact; another event does not do', () => {
    const at = (event: string, script: string) => hooksConfigured(settingsOf({ [event]: [`node ${script}`] }))
    expect(at('PostToolUse', 'file-tracker.js')).toEqual({ ...none, edited: true })
    expect(at('PreToolUse', 'file-tracker.js')).toEqual(none)
    expect(at('PreCompact', 'compact-monitor.js')).toEqual({ ...none, compact: true })
    expect(at('SessionStart', 'compact-monitor.js')).toEqual(none)
  })

  test('a command names the script wherever it stands in it; a command of another script does not', () => {
    const cmd = (command: string) => hooksConfigured(settingsOf({ PostToolUse: [command] })).edited
    expect(cmd("bash -c 'node ~/.claude/scripts/hooks/file-tracker.js'")).toBe(true)
    expect(cmd('node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/hooks/file-tracker.js" --quiet')).toBe(true)
    expect(cmd('node ~/.claude/scripts/hooks/effort-tracker.js')).toBe(false)
    expect(cmd('node ~/.claude/scripts/hooks/file-trackr.js')).toBe(false)
  })

  test('a script may stand among others in one entry or one of several entries', () => {
    const many = {
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [trackerCommand('other.js')] },
          { hooks: [trackerCommand('other.js'), trackerCommand('file-tracker.js')] },
        ],
      },
    }
    expect(hooksConfigured(many).edited).toBe(true)
  })

  test('given several settings, a hook wired in any of them counts', () => {
    const user = settingsOf({ PostToolUse: ['node file-tracker.js'] })
    const project = settingsOf({ PreCompact: ['node compact-monitor.js'] })
    expect(hooksConfigured(user, project)).toEqual({ ...none, edited: true, compact: true })
    expect(hooksConfigured(project, {}, null)).toEqual({ ...none, compact: true })
    expect(hooksConfigured()).toEqual(none)
  })

  test('settings without hooks, or hooks of a shape that is not settings.json, wire nothing and never throw', () => {
    for (const settings of [
      undefined,
      null,
      {},
      [],
      { hooks: null },
      { hooks: 'x' },
      { hooks: [] },
      { hooks: { PostToolUse: 'file-tracker.js' } },
      { hooks: { PostToolUse: [null, 7, 'file-tracker.js', {}, { hooks: 'file-tracker.js' }, { hooks: [null, 3, {}, { command: 5 }] }] } },
    ]) {
      expect(hooksConfigured(settings)).toEqual(none)
    }
  })
})
