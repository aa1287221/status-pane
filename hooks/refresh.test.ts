import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  CWD,
  EDIT_CALL,
  HEADER_89_DETAIL,
  HEADER_89_MODEL,
  MOCKUP_AT,
  NOW_SEC,
  SID,
  TURN_DONE,
  WORLD_89,
  clockAfter,
  resetsLines,
  boot,
  cardOf,
  deferred,
  editResult,
  headerOf,
  hintText,
  paneView,
  setUsage,
  stallNext,
  summarize,
} from './fixture'
import type { Proc, World } from './fixture'
import type { PaneParts } from './tree'
import { dw } from './model'

const CUM_FILE = `/tmp/claude-cum-${SID}.json`
const SNAP_FILE = '/root/.claude/rate-limit-snapshots.json'
const ROWS_FILE = '/root/.claude/cc-statusline-rows.json'
const isoOf = (sec: number) => new Date(sec * 1000).toISOString()
const REFRESHER = ['node', '/root/.claude/hooks/mcp-status-refresh.js']

/** The errors chip at the end of the SYSTEM card. */
const ERRORS = (n: number) => new RegExp(` ${n} errors?$`)
const errorsOf = (parts: PaneParts) => cardOf(parts, 'SYSTEM').body.at(-1)
/** `left` and `right` at the two ends of a row `width` cells wide. */
const spread = (left: string, right: string, width: number) => left + ' '.repeat(width - dw(left) - dw(right)) + right
/** The rows under the title of a card of the pane at 89 columns, where CONTEXT and COST are 25 cells inside and the rest 24. */
const bodyOf = async ($: Engine, title: string) => cardOf(await paneView($), title).body
/** The dashes of an unknown COST figure: the session column is 7 cells wide and the total 5. */
const DASHES = `${' '.repeat(6)}—  ${' '.repeat(4)}—`
/** The GIT card of the pane at 89 columns (24 cells inside): the branch and directory, the lines, and the state. */
const GIT = (lines: string, state = '✗ +1 ~3 ?2', branch = 'main') => [
  spread('branch', branch, 24),
  spread('dir', '~/project', 24),
  spread('lines', lines, 24),
  spread('state', state, 24),
]
/** The same with no branch to name: the directory, the lines and the state. */
const GIT_NO_BRANCH = GIT('+200 −4 ≈').slice(1)
/** The summary row of the header at 89 columns, between the model and the liveness. */
const headerWith = (text: string) => new RegExp(`^Opus 5\\.5 · max · v2\\.1\\.294 +${text} · 1hr 20min +mcp ✗(?:  \\d+ errors?)? +● \\d\\d:\\d\\d$`)
const UNBORN_BRANCH_CMD = 'git symbolic-ref --short -q HEAD'
const UNBORN_STDERR =
  "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'\n"
const NEW_ID = 'ffffffff-0000-4000-8000-000000000001'
const NEW_CUM = '/tmp/claude-cum-ffffffff0000400080000000.json'
const turnUsage = (out: number) => ({
  input_tokens: 5,
  output_tokens: out,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'm',
})

const cumOf = (world: World) => JSON.parse(world.files.get(CUM_FILE) ?? 'null') as Record<string, unknown>
const cumAt = (world: World, path: string) => JSON.parse(world.files.get(path) ?? 'null') as Record<string, unknown>
const tmpFiles = (world: World) => [...world.files.keys()].filter(k => k.endsWith('.tmp'))
const kicks = (world: World) => world.ran.filter(r => r.argv.join(' ') === REFRESHER.join(' ')).length

describe('the cum file', () => {
  test('the first refresh steps every counter from the existing file and writes it back byte-compatible', async ($, on) => {
    const { world } = await boot($, on)

    expect(world.files.get(CUM_FILE)).toBe(
      '{"cost":{"total":3.5,"base":3.5},"dur":{"total":4800000,"base":4800000},' +
        '"add":{"total":200,"base":200},"rm":{"total":4,"base":4},"tok":{"total":32000,"base":32000}}',
    )
  })

  test('a later refresh adds only the growth; a drop re-baselines without touching the total', async ($, on) => {
    const { world, advance, clock } = await boot($, on)

    setUsage(world, { cost: { usd: 5 }, context: { tokens: 40_000, window: 1_000_000, percent: 4 } })
    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toEqual({
      cost: { total: 5, base: 5 },
      dur: { total: 4_830_000, base: 4_830_000 },
      add: { total: 200, base: 200 },
      rm: { total: 4, base: 4 },
      tok: { total: 40_000, base: 40_000 },
    })

    setUsage(world, { cost: { usd: 1 }, context: { tokens: 5000, window: 1_000_000, percent: 1 } })
    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ cost: { total: 5, base: 1 }, tok: { total: 40_000, base: 5000 } })

    setUsage(world, { cost: { usd: 2.5 } })
    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ cost: { total: 6.5, base: 2.5 } })
  })

  test('a usage without a cost ledger leaves the cost counter where it was', async ($, on) => {
    const { world, advance, clock } = await boot($, on)

    setUsage(world, { cost: undefined })
    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ cost: { total: 3.5, base: 3.5 } })

    setUsage(world, { cost: { usd: 4.5 } })
    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ cost: { total: 4.5, base: 4.5 } })
  })

  test('a fresh session with no context figures reads a dash, not 0%, in the pane and leaves ctx out of the tail', async ($, on) => {
    const { world, advance, clock } = await boot($, on)

    setUsage(world, { context: { window: 200_000 } })
    await advance(30_000)
    await clock.settle()

    const context = cardOf(await paneView($), 'CONTEXT')
    expect([context.value, context.body]).toEqual(['—', ['░'.repeat(25), spread('used', '— / 200.0K', 25), spread('compact', '2', 25)]])
    expect(await hintText($)).toMatch(/^\? for shortcuts\|5h 23% · 7d 61% · \$3\.50 · \d\d:\d\d$/)
  })

  test('the session length is rounded to the minute, as statusline.js rounds it', async ($, on) => {
    await boot($, on, w => setUsage(w, { startedAt: MOCKUP_AT - 90_000 }))
    expect(headerOf(await paneView($)).body.join(' ')).toMatch(/遷移 statusline 到 mod pane 的討論與實作 · 2min$/)
  })

  test('a session with no cum file starts from zero', async ($, on) => {
    const { world } = await boot($, on, w => w.files.delete(CUM_FILE))
    expect(cumOf(world)).toMatchObject({
      cost: { total: 3.5, base: 3.5 },
      add: { total: 0, base: 0 },
      rm: { total: 0, base: 0 },
    })
  })
})

describe('R23 a damaged cum file', () => {
  test('a corrupt file reads n/a for the rows it feeds and is never overwritten', async ($, on) => {
    const { world } = await boot($, on, w => w.files.set(CUM_FILE, '{"cost":'))

    expect(world.files.get(CUM_FILE)).toBe('{"cost":')
    expect(world.moves.some(m => m.to === CUM_FILE)).toBe(false)
    expect(world.writes.some(w => w.path.startsWith(CUM_FILE))).toBe(false)
    const parts = await paneView($)
    // cost and tokens fail with the same file: each row of the COST matrix reads dashes and says why
    expect(cardOf(parts, 'COST').body).toEqual([
      '─'.repeat(25),
      `$${' '.repeat(10)}${DASHES}`,
      `tokens${' '.repeat(5)}${DASHES}`,
      'cost n/a (cum file is',
      'corrupt)',
      'tokens n/a (cum file is',
      'corrupt)',
    ])
    expect(cardOf(parts, 'GIT').body).toEqual([
      spread('branch', 'main', 24),
      spread('dir', '~/project', 24),
      'lines n/a (cum file is',
      'corrupt)',
      spread('state', '✗ +1 ~3 ?2', 24),
    ])
    expect(errorsOf(parts)).toMatch(ERRORS(3))
  })

  test('an empty file, as a write cut short leaves it, is corrupt too', async ($, on) => {
    const { world } = await boot($, on, w => w.files.set(CUM_FILE, ''))
    expect(world.files.get(CUM_FILE)).toBe('')
    expect((await bodyOf($, 'GIT')).join(' ')).toContain('lines n/a (cum file is corrupt)')
  })

  test('one that exists but cannot be read is not mistaken for a fresh file', async ($, on) => {
    const { world } = await boot($, on, w => w.denyRead.add(CUM_FILE))
    expect(world.files.get(CUM_FILE)).toContain('"add":{"total":200')
    expect(world.moves.some(m => m.to === CUM_FILE)).toBe(false)
    expect((await bodyOf($, 'GIT')).join(' ')).toContain('lines n/a (cum file unreadable: EACCES')
  })

  test('a missing file is zero, and it is written', async ($, on) => {
    const { world } = await boot($, on, w => w.files.delete(CUM_FILE))
    expect(cumOf(world)).toMatchObject({ add: { total: 0 }, cost: { total: 3.5 } })
    expect(await bodyOf($, 'GIT')).toEqual(GIT('+0 −0 ≈'))
  })
})

describe('R14 the shared files are written atomically', () => {
  test('the cum file goes in through a temp file and mv; no temp file is left and nothing is written in place', async ($, on) => {
    const { world } = await boot($, on)

    const temps = world.writes.filter(w => w.path.startsWith(`${CUM_FILE}.`))
    expect(temps).toHaveLength(1)
    expect(temps[0]?.path).toMatch(/^\/tmp\/claude-cum-c07353bf22c447df82966f2d\.json\.[0-9a-f]{8}\.tmp$/)
    expect(world.writes.some(w => w.path === CUM_FILE)).toBe(false)
    expect(world.moves.filter(m => m.to === CUM_FILE)).toEqual([{ from: temps[0]?.path ?? '', to: CUM_FILE }])
    expect(tmpFiles(world)).toEqual([])
  })

  test('so does the shared rate-limit file, whose temp name differs on every try', async ($, on) => {
    const { world } = await boot($, on)

    expect(world.writes.some(w => w.path === SNAP_FILE)).toBe(false)
    expect(world.moves.filter(m => m.to === SNAP_FILE)).toHaveLength(1)
    expect(world.ran.filter(r => r.argv[0] === 'mv' && r.argv[1] === '-f')).toHaveLength(2)
  })

  test('when mv fails the data is still written, directly, and each fallback counts as an error in the SYSTEM card', async ($, on) => {
    const { world } = await boot($, on, w => {
      w.denyMv = true
    })

    expect(cumOf(world)).toMatchObject({ cost: { total: 3.5 } })
    expect(world.writes.some(w => w.path === CUM_FILE)).toBe(true)
    expect(world.writes.some(w => w.path === SNAP_FILE)).toBe(true)
    expect(tmpFiles(world)).toEqual([])
    expect(errorsOf(await paneView($))).toMatch(ERRORS(2))
  })

  test('a fallback on an early try of the shared file still counts when a later try goes through mv', async ($, on) => {
    let clobbered = false
    const { world } = await boot($, on, w => {
      w.denyMvFor.add(SNAP_FILE)
      w.onWrite = path => {
        if (path !== SNAP_FILE || clobbered) return
        clobbered = true
        // a competing writer replaces the file, and mv works again for the retry
        w.denyMvFor.delete(SNAP_FILE)
        w.files.set(SNAP_FILE, JSON.stringify({ competing: { t: NOW_SEC, five_hour: null, seven_day: null } }))
      }
    })

    expect(world.moves.filter(m => m.to === SNAP_FILE)).toHaveLength(1)
    expect(errorsOf(await paneView($))).toMatch(ERRORS(1))
  })
})

describe('lines and tokens counted by the hooks', () => {
  test('an edit adds its + and - lines once, however many refreshes follow', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.toolResult = () => editResult(['-old', '+n1', '+n2', '+n3'])

    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()

    expect(cumOf(world)).toMatchObject({ add: { total: 203, base: 203 }, rm: { total: 5, base: 5 } })
    expect(await bodyOf($, 'GIT')).toEqual(GIT('+203 −5 ≈'))

    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 203 }, rm: { total: 5 } })
  })

  test('lines wait for the next refresh when the cum file cannot be written', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.toolResult = () => editResult(['+a', '+b', '+c'])
    world.denyWrite.add(CUM_FILE)

    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 200 } })
    expect((await bodyOf($, 'GIT')).join(' ')).toContain('lines n/a (EACCES')

    world.denyWrite.clear()
    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 203, base: 203 } })
  })

  test('a subagent turn adds nothing to the session tokens, a main-loop turn does (Q1)', async ($, on) => {
    const { world, clock } = await boot($, on)

    world.now += 6000
    await $.turn.complete({ ...TURN_DONE, agentId: 'sub1', usage: turnUsage(5000) })
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ tok: { total: 32_000, base: 32_000 } })

    world.now += 6000
    await $.turn.complete({ ...TURN_DONE, usage: turnUsage(700) })
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ tok: { total: 32_700, base: 32_700 } })
  })

  test('a failed edit counts nothing', async ($, on) => {
    const { world, clock } = await boot($, on)
    world.toolResult = () => ({ ...editResult(['+a', '+b']), isError: true, text: 'boom' })

    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()

    expect(cumOf(world)).toMatchObject({ add: { total: 200 }, rm: { total: 4 } })
  })

  test('the output tokens of every turn add to the session tokens', async ($, on) => {
    const { world, clock } = await boot($, on)
    const usage = (out: number) => ({
      input_tokens: 5,
      output_tokens: out,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      model: 'm',
    })

    world.now += 6000
    await $.turn.complete({ ...TURN_DONE, usage: usage(1000) })
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ tok: { total: 33_000, base: 33_000 } })

    world.now += 6000
    await $.turn.complete({ ...TURN_DONE, usage: usage(500) })
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ tok: { total: 33_500, base: 33_500 } })
    // the session's 33.5K and the total's 35.0K, in the tokens row of the matrix
    expect((await bodyOf($, 'COST')).at(-1)).toBe(`tokens${' '.repeat(4)} 33.5K≈  35.0K≈`)
  })
})

describe('R3 R17 R20 a new session id starts the counters over', () => {
  test('the new cum file does not inherit the old output tokens, with no session.end to tell it', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.now += 6000
    await $.turn.complete({ ...TURN_DONE, usage: turnUsage(1000) })
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ tok: { total: 33_000 } })

    world.session.id = NEW_ID
    await advance(30_000)
    await clock.settle()

    expect(cumAt(world, NEW_CUM)).toMatchObject({ tok: { total: 32_000, base: 32_000 }, add: { total: 0 }, cost: { total: 3.5 } })
  })

  test('output tokens counted under the old id are not added to the new session by a turn that follows the change', async ($, on) => {
    const { world, clock } = await boot($, on)
    world.now += 6000
    await $.turn.complete({ ...TURN_DONE, usage: turnUsage(1000) })
    await clock.settle()

    world.session.id = NEW_ID
    world.now += 6000
    await $.turn.complete({ ...TURN_DONE, usage: turnUsage(500) })
    await clock.settle()

    expect(cumAt(world, NEW_CUM)).toMatchObject({ tok: { total: 32_500, base: 32_500 } })
  })

  test('lines counted for the old session are not carried into the new one', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.toolResult = () => editResult(['+a', '+b', '+c'])
    world.denyWrite.add(CUM_FILE)
    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()

    world.denyWrite.clear()
    world.session.id = NEW_ID
    await advance(30_000)
    await clock.settle()

    expect(cumAt(world, NEW_CUM)).toMatchObject({ add: { total: 0 } })
    expect(cumOf(world)).toMatchObject({ add: { total: 200 } })
  })

  test('a refresh that straddles the change takes nothing of the new session; lines still pending at the change are dropped (R20a)', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.toolResult = () => editResult(['+a', '+b', '+c'])
    const release = stallNext(world, 'fs.list:/tmp')
    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()

    world.session.id = NEW_ID
    world.toolResult = () => editResult(['+n1', '+n2'])
    await $.tool.call(EDIT_CALL)
    release()
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 200 } })

    world.now += 6000
    await advance(30_000)
    await clock.settle()
    expect(cumAt(world, NEW_CUM)).toMatchObject({ add: { total: 2 } })
    expect((await bodyOf($, 'GIT'))[2]).toBe(spread('lines', '+2 −0 ≈', 24))
  })
})

describe('the all-sessions totals', () => {
  test('only claude-cum-<sid>.json files count, not other files that look alike', async ($, on) => {
    await boot($, on, w => {
      const decoy = '{"cost":{"total":100,"base":100},"tok":{"total":100000,"base":100000}}'
      w.files.set('/tmp/claude-cumulative.json', decoy)
      w.files.set('/tmp/claude-agents-zzz.json', decoy)
      w.files.set('/tmp/claude-cum-notes.txt', decoy)
    })
    // the decoys change neither the total cost nor the total tokens
    expect(await bodyOf($, 'COST')).toEqual(WORLD_89.cards.COST?.body)
  })
})

describe('R1 R5 R9 R18 the cum write is the commit point', () => {
  test('a listing that fails leaves the file and the pending lines alone; the next refresh flushes them once', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.toolResult = () => editResult(['+a', '+b', '+c'])
    world.denyList.add('/tmp')

    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 200 } })
    expect((await bodyOf($, 'GIT')).join(' ')).toContain('lines n/a (EACCES')

    world.denyList.clear()
    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 203, base: 203 } })

    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 203 } })
  })

  test('a collector that outlasts the 5 s guard settles what it persisted when it finally writes', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.toolResult = () => editResult(['+a', '+b', '+c'])
    const release = stallNext(world, 'fs.list:/tmp')

    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()
    await advance(5000)
    await clock.settle()
    expect((await bodyOf($, 'GIT')).join(' ')).toContain('lines n/a (timeout)')
    expect(cumOf(world)).toMatchObject({ add: { total: 200 } })

    release()
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 203 } })

    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 203 } })
    expect(await bodyOf($, 'GIT')).toEqual(GIT('+203 −4 ≈'))
  })

  test('a late collector of a refresh that a newer one has replaced does not write over it (R21)', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    const release = stallNext(world, 'fs.list:/tmp')

    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    await advance(5000)
    await clock.settle()

    setUsage(world, { cost: { usd: 5 } })
    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ cost: { total: 5, base: 5 } })
    const counted = world.stateSets.filter(k => k === 'pending').length

    release()
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ cost: { total: 5, base: 5 } })
    // and it did not even touch the pending lines on its way out
    expect(world.stateSets.filter(k => k === 'pending')).toHaveLength(counted)
  })
})

describe('S1 the pending lines are taken before the write, so they are persisted once', () => {
  const noLines = () => ({ result: { ok: true } })
  const cumWrites = (world: World) => world.moves.filter(m => m.to === CUM_FILE).length

  test('lines that arrive while the cum file is being written stay pending for the next refresh', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.toolResult = () => editResult(['+a', '+b', '+c'])
    const release = stallNext(world, `fs.write:${CUM_FILE}`)
    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()

    world.toolResult = () => editResult(['+n1', '+n2'])
    await $.tool.call(EDIT_CALL)
    release()
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 203 } })

    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 205 } })
  })

  test('a newer refresh that reads the lines before an older one has taken them does not persist them twice', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.toolResult = () => editResult(['+a', '+b', '+c'])
    const releaseList = stallNext(world, 'fs.list:/tmp')
    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()
    await advance(5000)
    await clock.settle()

    // the older refresh goes on as the current one, and holds at the take
    const releaseTake = stallNext(world, 'state.get:pending')
    releaseList()
    await clock.settle()

    world.toolResult = noLines
    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 203 } })

    releaseTake()
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 203 }, rm: { total: 4 } })

    world.toolResult = () => editResult(['+x', '+y'])
    await $.tool.call(EDIT_CALL)
    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 205 } })
    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 205 } })
  })

  test('an older refresh that finds itself replaced once it holds the lines gives them back and does not write', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.toolResult = () => editResult(['+a', '+b', '+c'])
    const releaseList = stallNext(world, 'fs.list:/tmp')
    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()
    await advance(5000)
    await clock.settle()

    // the take lands, and the call that made it holds before it answers
    const releaseTaken = stallNext(world, 'state.set:pending')
    releaseList()
    await clock.settle()

    setUsage(world, { cost: { usd: 5 } })
    world.toolResult = noLines
    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 200 }, cost: { total: 5 } })
    const written = cumWrites(world)

    releaseTaken()
    await clock.settle()
    expect(cumWrites(world)).toBe(written)
    expect(cumOf(world)).toMatchObject({ add: { total: 200 }, cost: { total: 5 } })

    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 203 }, cost: { total: 5 } })
  })

  test('a pending count that stands below zero, as an older version could leave it, is cleared and never added', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.readOnce.set('pending', { sid: SID, add: -3, rm: -1 })

    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 200 }, rm: { total: 4 } })

    // the same count met by an edit before any refresh has taken it
    world.readOnce.set('pending', { sid: SID, add: -3, rm: 0 })
    world.toolResult = () => editResult(['+x', '+y'])
    await $.tool.call(EDIT_CALL)
    await advance(30_000)
    await clock.settle()
    expect(cumOf(world)).toMatchObject({ add: { total: 202 }, rm: { total: 4 } })
  })

  test('lines given back after a failed write do not land in the count of another session', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    world.toolResult = () => editResult(['+a', '+b', '+c'])
    const release = stallNext(world, `fs.write:${CUM_FILE}`)
    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()

    world.session.id = NEW_ID
    world.toolResult = () => editResult(['+n1', '+n2'])
    await $.tool.call(EDIT_CALL)
    world.denyWrite.add(CUM_FILE)
    release()
    await clock.settle()
    world.denyWrite.clear()
    expect(cumOf(world)).toMatchObject({ add: { total: 200 } })

    world.now += 6000
    await advance(30_000)
    await clock.settle()
    expect(cumAt(world, NEW_CUM)).toMatchObject({ add: { total: 2 } })
  })
})

describe('R21 who may still write', () => {
  test('a late quota collector of a refresh that a newer one has replaced does not write the shared file', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    const release = stallNext(world, `fs.read:${SNAP_FILE}`)

    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    await advance(5000)
    await clock.settle()

    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    const written = world.moves.filter(m => m.to === SNAP_FILE).length

    release()
    await clock.settle()
    expect(world.moves.filter(m => m.to === SNAP_FILE)).toHaveLength(written)
  })

  test('a refresh that was replaced while it was finishing does not write its snapshot over the newer one', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    const hold = deferred()
    world.nowGate = { after: 2, promise: hold.promise }

    world.now += 6000
    await $.tool.call(EDIT_CALL)
    await clock.settle()
    expect(world.usageCalls).toBe(2)

    setUsage(world, { cost: { usd: 5 } })
    await advance(60_000)
    await clock.settle()
    expect(world.usageCalls).toBe(3)

    hold.release()
    await clock.settle()
    // the session cost of the newer refresh, in the `$` row of the matrix
    expect((await bodyOf($, 'COST'))[1]).toMatch(/^\$ +5\.00 +/)
  })

  test('a rows file that never answers costs 2 s, not the whole refresh', async ($, on) => {
    const { advance, clock } = await boot($, on, w => {
      w.files.set(ROWS_FILE, '{"quota":false}')
      stallNext(w, `fs.read:${ROWS_FILE}`)
    })
    expect((await paneView($)).cards.map(c => c.body)).toEqual([['waiting for the first refresh']])

    await advance(1900)
    await clock.settle()
    expect((await paneView($)).cards.map(c => c.body)).toEqual([['waiting for the first refresh']])

    await advance(200)
    await clock.settle()
    expect((await paneView($)).cards.some(c => c.title === '5H')).toBe(true)
  })
})

describe('event-driven refreshes', () => {
  test('a turn or an edit refreshes at once, at most once per 5 s', async ($, on) => {
    const { world, clock } = await boot($, on)
    expect(world.usageCalls).toBe(1)

    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    expect(world.usageCalls).toBe(2)

    world.now += 1000
    await $.turn.complete(TURN_DONE)
    await $.tool.call(EDIT_CALL)
    await clock.settle()
    expect(world.usageCalls).toBe(2)

    world.now += 5000
    await $.tool.call(EDIT_CALL)
    await clock.settle()
    expect(world.usageCalls).toBe(3)
  })

  test('a refresh that is still running is joined, not doubled', async ($, on) => {
    const { world, clock } = await boot($, on, w => w.hang.add('session.usage'))
    expect(world.usageCalls).toBe(1)

    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()

    expect(world.usageCalls).toBe(1)
  })

  test('a refresh stuck for a minute is abandoned so the next timer tick can run', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    expect(world.usageCalls).toBe(1)

    world.hang.add('clock.now')
    await advance(30_000)
    await clock.settle()
    expect(world.usageCalls).toBe(1)

    await advance(30_000)
    await clock.settle()
    world.hang.delete('clock.now')
    for (const _ of [1, 2]) {
      await advance(30_000)
      await clock.settle()
    }
    expect(world.usageCalls).toBeGreaterThanOrEqual(2)
  })

  test('an abandoned refresh that finishes late does not clear the pointer of the one that replaced it (R21)', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    const releaseA = stallNext(world, 'state.get:effort')
    const releaseB = stallNext(world, 'state.get:effort')

    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    await advance(60_000)
    await clock.settle()

    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    expect(world.usageCalls).toBe(1)

    releaseA()
    await clock.settle()
    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    expect(world.usageCalls).toBe(1)

    releaseB()
    await clock.settle()
    expect(world.usageCalls).toBe(2)
  })

  test('the watchdog of a refresh that has finished does not free a newer one that is still running (R21)', async ($, on) => {
    const { world, advance, clock } = await boot($, on, w => w.hang.add('clock.every'))
    const release = stallNext(world, 'state.get:effort')

    await advance(10_000)
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    expect(world.usageCalls).toBe(1)

    await advance(51_000)
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    await advance(2000)
    await clock.settle()
    expect(world.usageCalls).toBe(1)

    release()
    await clock.settle()
  })

  test('a follow-up that falls due while a refresh is still running waits for it and then refreshes', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    stallNext(world, 'fs.list:/tmp')

    world.now += 6000
    await $.turn.complete(TURN_DONE)
    await clock.settle()
    expect(world.usageCalls).toBe(2)

    await advance(3000)
    await clock.settle()
    expect(world.usageCalls).toBe(2)

    await advance(2000)
    await clock.settle()
    expect(world.usageCalls).toBe(3)
  })

  test('the hooks hand back what the engine answered', async ($, on) => {
    const { world } = await boot($, on)
    world.toolResult = () => ({ result: { marker: 1 }, text: 'kept' })

    expect(await $.turn.complete(TURN_DONE)).toEqual({ text: '' })
    expect(await $.tool.call(EDIT_CALL)).toMatchObject({ result: { marker: 1 }, text: 'kept' })
  })
})

describe('the shared rate-limit file', () => {
  const R5 = NOW_SEC + 7800
  const entry = (t: number, used: number, resets: number) => ({
    t,
    five_hour: { used_percentage: used, resets_at: resets },
    seven_day: null,
  })

  test('this session joins the file, stale entries leave, and the newest window decides the percentage', async ($, on) => {
    const { world } = await boot($, on, w =>
      w.files.set(
        SNAP_FILE,
        JSON.stringify({ other: entry(NOW_SEC - 20, 40, NOW_SEC + 9000), gone: entry(NOW_SEC - 400, 99, NOW_SEC + 9000) }),
      ),
    )

    expect(JSON.parse(world.files.get(SNAP_FILE) ?? '')).toEqual({
      other: entry(NOW_SEC - 20, 40, NOW_SEC + 9000),
      [SID]: {
        t: NOW_SEC,
        five_hour: { used_percentage: 23, resets_at: R5 },
        seven_day: { used_percentage: 61, resets_at: NOW_SEC + 3 * 86_400 + 4 * 3600 },
      },
    })
    // the other session's window resets later, so its 40% wins; the countdown is this session's own
    const parts = await paneView($)
    expect(cardOf(parts, '5H')).toMatchObject({ value: '40%', body: [`${'█'.repeat(9)}▋${'░'.repeat(14)}`, ...resetsLines('2h 10m', clockAfter(MOCKUP_AT, 7800, false), 24)] })
    expect(cardOf(parts, '7D').value).toBe('61%')
  })

  test('a write that another session clobbers is retried until this entry is visible', async ($, on) => {
    let clobbered = false
    const { world } = await boot($, on, w => {
      w.onWrite = (path, _text) => {
        if (path !== SNAP_FILE || clobbered) return
        clobbered = true
        w.files.set(path, JSON.stringify({ competing: entry(NOW_SEC, 10, R5) }))
      }
    })

    expect(world.moves.filter(m => m.to === SNAP_FILE)).toHaveLength(2)
    expect(Object.keys(JSON.parse(world.files.get(SNAP_FILE) ?? '')).sort()).toEqual(['competing', SID].sort())
  })

  test('a percentage with a fraction is rounded, as statusline.js rounds it', async ($, on) => {
    await boot($, on, w =>
      setUsage(w, {
        rateLimits: [
          { kind: 'five_hour', percentUsed: 23.6, resetsAt: isoOf(NOW_SEC + 7800) },
          { kind: 'seven_day', percentUsed: 61.4, resetsAt: isoOf(NOW_SEC + 3 * 86_400 + 4 * 3600) },
        ],
      }),
    )
    const parts = await paneView($)
    expect(cardOf(parts, '5H')).toMatchObject({ value: '24%', body: [`${'█'.repeat(5)}▊${'░'.repeat(18)}`, ...resetsLines('2h 10m', clockAfter(MOCKUP_AT, 7800, false), 24)] })
    expect(cardOf(parts, '7D').value).toBe('61%')
    expect(await hintText($)).toMatch(/5h 24% · 7d 61%/)
  })

  test('a reset that has passed leaves the percentage unknown and wraps the countdown by its own period: 5 h, 7 d', async ($, on) => {
    await boot($, on, w =>
      setUsage(w, {
        rateLimits: [
          { kind: 'five_hour', percentUsed: 80, resetsAt: isoOf(NOW_SEC - 3600) },
          { kind: 'seven_day', percentUsed: 50, resetsAt: isoOf(NOW_SEC - 86_400) },
        ],
      }),
    )
    const parts = await paneView($)
    expect(cardOf(parts, '5H')).toMatchObject({ value: '—', body: ['░'.repeat(24), ...resetsLines('4h 0m', clockAfter(MOCKUP_AT, 4 * 3600, false), 24)] })
    expect(cardOf(parts, '7D')).toMatchObject({ value: '—', body: ['░'.repeat(24), ...resetsLines('6d 0h', clockAfter(MOCKUP_AT, 6 * 86_400, true), 24)] })
  })

  test('a session with no live reading shows a dash and a bare track, not 0%, and leaves 5h and 7d out of the tail (R4 R10)', async ($, on) => {
    await boot($, on, w => setUsage(w, { rateLimits: [] }))
    const parts = await paneView($)
    expect(cardOf(parts, '5H')).toMatchObject({ value: '—', body: ['░'.repeat(24)] })
    expect(cardOf(parts, '7D')).toMatchObject({ value: '—', body: ['░'.repeat(24)] })
    expect(await hintText($)).toMatch(/^\? for shortcuts\|ctx 3% · \$3\.50 · \d\d:\d\d$/)
  })
})

describe('system rows', () => {
  test('the second refresh has a baseline and reads the CPU share of the interval', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    expect(await bodyOf($, 'SYSTEM')).toEqual(WORLD_89.cards.SYSTEM?.body)

    world.files.set('/proc/stat', 'cpu  160 0 90 840 20 0 9 0 0 0\ncpu0 1 1 1 1 1 1 1 0 0 0\n')
    await advance(30_000)
    await clock.settle()
    // one reading of 71% on the 0..100 axis: the bottom row full, the top row three eighths; the chart and its value take 20 cells
    expect(await bodyOf($, 'SYSTEM')).toEqual([
      `${' '.repeat(63)}${'░'.repeat(15)}▃`,
      spread('cpu', `${'░'.repeat(15)}█ 71%`, 83),
      ...WORLD_89.cards.SYSTEM!.body.slice(1),
    ])

    await advance(30_000)
    await clock.settle()
    expect((await bodyOf($, 'SYSTEM')).slice(0, 2)).toEqual([`${' '.repeat(64)}${'░'.repeat(14)}▃░`, spread('cpu', `${'░'.repeat(14)}█░ 0%`, 83)])
  })

  test('a failed refresh of /proc/stat keeps the previous baseline for the next one', async ($, on) => {
    const { world, advance, clock } = await boot($, on)

    world.denyRead.add('/proc/stat')
    await advance(30_000)
    await clock.settle()
    world.denyRead.delete('/proc/stat')
    world.files.set('/proc/stat', 'cpu  160 0 90 840 20 0 9 0 0 0\n')
    await advance(30_000)
    await clock.settle()

    expect((await bodyOf($, 'SYSTEM')).some(l => /^cpu +\S{16} 71%$/.test(l))).toBe(true)
  })
})

describe('git and memory rows', () => {
  test('git runs in the session directory with the three commands, and no top-level lookup when the remote names the repo', async ($, on) => {
    const { world } = await boot($, on)
    const git = world.ran.filter(r => r.argv[0] === 'git')

    expect(git.map(r => r.argv.join(' ')).sort()).toEqual([
      'git remote get-url origin',
      'git rev-parse --abbrev-ref HEAD',
      'git status --porcelain',
    ])
    expect(git.every(r => r.cwd === CWD)).toBe(true)
    // a status poll must not take the index lock the person's own git may want
    expect(git.every(r => r.env?.GIT_OPTIONAL_LOCKS === '0')).toBe(true)
    // and in English, so "not a git repository" can be told from a real failure
    expect(git.every(r => r.env?.LC_ALL === 'C')).toBe(true)
  })

  test('without a remote the repository is named from the top-level directory', async ($, on) => {
    const { world } = await boot($, on, w => w.procs.set('git remote get-url origin', { exitCode: 2, stdout: '' }))
    expect(world.ran.map(r => r.argv.join(' '))).toContain('git rev-parse --show-toplevel')
  })

  test('outside a repository there is no branch, no change counts and no complaint', async ($, on) => {
    const { world } = await boot($, on, w => {
      for (const key of w.procs.keys()) {
        if (key.startsWith('git ')) {
          w.procs.set(key, { exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' })
        }
      }
    })
    const parts = await paneView($)
    expect(cardOf(parts, 'GIT').body).toEqual([spread('branch', 'not a git repo', 24), ...GIT_NO_BRANCH.slice(0, 2)])
    expect(cardOf(parts, 'SYSTEM').body).toEqual(WORLD_89.cards.SYSTEM?.body)
    expect(world.ran.filter(r => r.argv[0] === 'git').length).toBeGreaterThan(0)
  })

  test('a git status that exits non-zero reads n/a with its first stderr line, and the branch stays (R6)', async ($, on) => {
    await boot($, on, w =>
      w.procs.set('git status --porcelain', { exitCode: 128, stderr: 'fatal: this operation must be run in a work tree\nsecond line\n' }),
    )
    const parts = await paneView($)
    expect(cardOf(parts, 'GIT').body).toEqual([...GIT('+200 −4 ≈').slice(0, 3), 'git n/a (fatal: this', 'operation must be run in', 'a work tree)'])
    expect(errorsOf(parts)).toMatch(ERRORS(1))
  })

  test('a status that is refused outright keeps the branch too (R24)', async ($, on) => {
    await boot($, on, w => w.procs.set('git status --porcelain', new Error('timed out after 4000 ms')))
    expect(await bodyOf($, 'GIT')).toEqual([...GIT('+200 −4 ≈').slice(0, 3), 'git n/a (timed out after', '4000 ms)'])
  })

  // anything but a missing repository or a repository with no commits is a real failure (R6); the reason is
  // the first stderr line cut to 60 cells, and the 70-cell unit then no longer fits beside the rest
  const REAL_FAILURES: [string, string, string][] = [
    ['an unsafe repository', "fatal: detected dubious ownership in repository at '/root/project'\nsecond line\n", "fatal: detected dubious ownership in repository at '/root/pr"],
    ['an ambiguous argument that is not HEAD', "fatal: ambiguous argument 'main': unknown revision or path not in the working tree.\n", "fatal: ambiguous argument 'main': unknown revision or path n"],
  ]
  for (const [what, stderr, shown] of REAL_FAILURES) {
    test(`rev-parse failing on ${what} reads n/a with its first stderr line (R6)`, async ($, on) => {
      const { world } = await boot($, on, w => w.procs.set('git rev-parse --abbrev-ref HEAD', { exitCode: 128, stdout: 'HEAD\n', stderr }))
      const parts = await paneView($)
      // no branch to draw, so the reason comes first and the directory and the lines follow it
      const body = cardOf(parts, 'GIT').body
      expect(body.slice(-2)).toEqual(GIT_NO_BRANCH.slice(0, 2))
      expect(body.slice(0, -2).join(' ')).toBe(`git n/a (${shown})`)
      expect(errorsOf(parts)).toMatch(ERRORS(1))
      expect(world.ran.map(r => r.argv.join(' '))).not.toContain(UNBORN_BRANCH_CMD)
    })
  }

  describe('a repository with no commits yet', () => {
    const unborn = (w: World, branch: Proc) => {
      w.procs.set('git rev-parse --abbrev-ref HEAD', { exitCode: 128, stdout: 'HEAD\n', stderr: UNBORN_STDERR })
      w.procs.set(UNBORN_BRANCH_CMD, branch)
    }

    test('draws the branch HEAD points at, with no n/a and no error', async ($, on) => {
      const { world } = await boot($, on, w => unborn(w, { stdout: 'master\n' }))
      const parts = await paneView($)
      expect(cardOf(parts, 'GIT').body).toEqual(GIT('+200 −4 ≈', undefined, 'master'))
      expect(cardOf(parts, 'SYSTEM').body).toEqual(WORLD_89.cards.SYSTEM?.body)
      const named = world.ran.filter(r => r.argv.join(' ') === UNBORN_BRANCH_CMD)
      expect(named).toHaveLength(1)
      expect(named[0]?.cwd).toBe(CWD)
      expect(named[0]?.env).toEqual({ GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' })
    })

    const UNNAMED: [string, Proc][] = [
      ['exits non-zero, even with text on stdout', { exitCode: 1, stdout: 'HEAD\n' }],
      ['is refused', new Error('process refused')],
    ]
    for (const [how, branch] of UNNAMED) {
      test(`draws no branch, and no complaint, when naming it ${how}`, async ($, on) => {
        await boot($, on, w => unborn(w, branch))
        const parts = await paneView($)
        expect(cardOf(parts, 'GIT').body).toEqual(GIT_NO_BRANCH)
        expect(cardOf(parts, 'SYSTEM').body).toEqual(WORLD_89.cards.SYSTEM?.body)
      })
    }

    test('a slow status does not hold up naming it: the branch is drawn with the status (R24)', async ($, on) => {
      const { advance, clock } = await boot($, on, w => {
        unborn(w, { stdout: 'master\n' })
        w.delay.set('process.run:git status --porcelain', 4000)
        w.delay.set(`process.run:${UNBORN_BRANCH_CMD}`, 2000)
      })
      await advance(4100)
      await clock.settle()

      const parts = await paneView($)
      expect(cardOf(parts, 'GIT').body).toEqual(GIT('+200 −4 ≈', undefined, 'master'))
      expect(cardOf(parts, 'SYSTEM').body).toEqual(WORLD_89.cards.SYSTEM?.body)
    })

    test('gives up on naming it after the same 2 s as any other git call, and still draws the rest', async ($, on) => {
      const { advance, clock } = await boot($, on, w => {
        unborn(w, { stdout: 'master\n' })
        w.hang.add(`process.run:${UNBORN_BRANCH_CMD}`)
      })
      await advance(2400)
      await clock.settle()
      expect((await paneView($)).cards.map(c => c.body)).toEqual([['waiting for the first refresh']])

      await advance(200)
      await clock.settle()
      const parts = await paneView($)
      expect(cardOf(parts, 'GIT').body).toEqual(GIT_NO_BRANCH)
      expect(cardOf(parts, 'SYSTEM').body).toEqual(WORLD_89.cards.SYSTEM?.body)
    })
  })

  test('a slow status and a missing origin still draw the branch: the top-level lookup does not wait for the status (R24)', async ($, on) => {
    const { advance, clock } = await boot($, on, w => {
      w.procs.set('git remote get-url origin', { exitCode: 2, stderr: "error: No such remote 'origin'\n" })
      w.delay.set('process.run:git status --porcelain', 4000)
      w.delay.set('process.run:git rev-parse --show-toplevel', 2000)
    })
    await advance(4100)
    await clock.settle()

    const parts = await paneView($)
    expect(cardOf(parts, 'GIT').body).toEqual(GIT('+200 −4 ≈'))
    expect(cardOf(parts, 'SYSTEM').body).toEqual(WORLD_89.cards.SYSTEM?.body)
  })

  test('a hung remote and a hung top-level lookup, one after the other, still leave the branch (R24)', async ($, on) => {
    const { advance, clock } = await boot($, on, w => {
      w.hang.add('process.run:git remote get-url origin')
      w.hang.add('process.run:git rev-parse --show-toplevel')
    })
    await advance(5100)
    await clock.settle()

    const parts = await paneView($)
    expect(cardOf(parts, 'GIT').body).toEqual(GIT('+200 −4 ≈'))
    expect(cardOf(parts, 'SYSTEM').body).toEqual(WORLD_89.cards.SYSTEM?.body)
  })

  test('a remote that does not exist is normal: no complaint, the repository is named from the top level (R6)', async ($, on) => {
    const { world } = await boot($, on, w =>
      w.procs.set('git remote get-url origin', { exitCode: 2, stderr: "error: No such remote 'origin'\n" }),
    )
    expect(summarize(await paneView($))).toEqual(WORLD_89)
    expect(world.ran.map(r => r.argv.join(' '))).toContain('git rev-parse --show-toplevel')
  })

  test('the memory row counts the global file, the project file and the rules', async ($, on) => {
    await boot($, on, w => {
      w.files.delete('/root/.claude/CLAUDE.md')
      w.files.delete(`${CWD}/CLAUDE.md`)
      w.files.delete(`${CWD}/.claude/rules/b.md`)
      w.files.delete(`${CWD}/.claude/rules/c.md`)
    })
    expect(await bodyOf($, 'SYSTEM')).toEqual([...WORLD_89.cards.SYSTEM!.body.slice(0, 3), spread('memory', '1 rules', 83)])
  })

  test('with no memory files and no mcp cache the row is left out', async ($, on) => {
    await boot($, on, w => {
      for (const key of [...w.files.keys()]) {
        if (key.endsWith('.md') || key.endsWith('mcp-status-cache.json')) w.files.delete(key)
      }
    })
    expect(await bodyOf($, 'SYSTEM')).toEqual(WORLD_89.cards.SYSTEM!.body.slice(0, 2))
  })
})

describe('the MCP status refresher', () => {
  test('it starts on the first refresh, then at most every 5 minutes', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    expect(kicks(world)).toBe(1)

    world.now += 240_000
    await advance(30_000)
    await clock.settle()
    expect(kicks(world)).toBe(1)

    await advance(30_000)
    await clock.settle()
    expect(kicks(world)).toBe(2)
  })

  test('nothing waits for it: a refresher that never exits still leaves the pane drawn', async ($, on) => {
    await boot($, on, w => w.hang.add(`process.run:${REFRESHER.join(' ')}`))
    expect(summarize(await paneView($))).toEqual(WORLD_89)
  })

  test('it is not started without the script, or when the memory and mcp row is off', async ($, on) => {
    const noScript = await boot($, on, w => w.files.delete('/root/.claude/hooks/mcp-status-refresh.js'))
    expect(kicks(noScript.world)).toBe(0)
  })

  test('it is not started when the memory and mcp row is off', async ($, on) => {
    const { world } = await boot($, on, w => w.files.set('/root/.claude/cc-statusline-rows.json', '{"memory_mcp":false}'))
    expect(kicks(world)).toBe(0)
  })
})

describe('the tracker files directory', () => {
  test('TMPDIR moves where the side files are read and written', async ($, on) => {
    const { world } = await boot($, on, w => {
      w.env.TMPDIR = '/var/scratch/'
      for (const [path, text] of [...w.files]) {
        if (!path.startsWith('/tmp/')) continue
        w.files.delete(path)
        w.files.set(path.replace('/tmp/', '/var/scratch/'), text)
      }
    })

    expect(JSON.parse(world.files.get(`/var/scratch/claude-cum-${SID}.json`) ?? 'null')).toMatchObject({
      cost: { total: 3.5 },
    })
    const header = headerOf(await paneView($))
    expect(header.body[0]).toMatch(HEADER_89_MODEL)
    expect(header.body[1]).toBe(HEADER_89_DETAIL)
    expect([...world.files.keys()].filter(k => k.startsWith('/tmp/'))).toEqual([])
  })
})

describe('the summary row', () => {
  test('without a summary file it falls back to the first user message', async ($, on) => {
    await boot($, on, w => {
      w.files.delete(`/tmp/claude-summary-${SID}.txt`)
      w.files.set(`/tmp/claude-msgs-${SID}.json`, JSON.stringify([{ r: 'a', t: 'x' }, { r: 'u', t: 'hello\nworld' }]))
    })
    expect(headerOf(await paneView($)).body[0]).toMatch(headerWith('hello world'))
  })

  test('with neither it shows the session id', async ($, on) => {
    await boot($, on, w => w.files.delete(`/tmp/claude-summary-${SID}.txt`))
    expect(headerOf(await paneView($)).body[0]).toMatch(headerWith('session c07353bf'))
  })

  test('the first user entry decides, even when it is empty (R12)', async ($, on) => {
    await boot($, on, w => {
      w.files.delete(`/tmp/claude-summary-${SID}.txt`)
      w.files.set(`/tmp/claude-msgs-${SID}.json`, JSON.stringify([{ r: 'u', t: '  ' }, { r: 'u', t: 'second' }]))
    })
    expect(headerOf(await paneView($)).body[0]).toMatch(headerWith('session c07353bf'))
  })

  test('a message log the host will not read (over 4 MiB) falls back to the session id, the documented cap (R12)', async ($, on) => {
    await boot($, on, w => {
      w.files.delete(`/tmp/claude-summary-${SID}.txt`)
      w.files.set(`/tmp/claude-msgs-${SID}.json`, JSON.stringify([{ r: 'u', t: 'hello' }]))
      w.denyRead.add(`/tmp/claude-msgs-${SID}.json`)
    })
    expect(headerOf(await paneView($)).body[0]).toMatch(headerWith('session c07353bf'))
  })

  test('the message log is not read while the summary file has text', async ($, on) => {
    const { world } = await boot($, on, w => w.files.set(`/tmp/claude-msgs-${SID}.json`, '[]'))
    expect(world.reads).not.toContain(`/tmp/claude-msgs-${SID}.json`)
  })
})

describe('agents and edited rows', () => {
  test('a name list with entries that are not strings keeps only the names', async ($, on) => {
    await boot($, on, w => w.files.set(`/tmp/claude-files-${SID}.json`, JSON.stringify(['a.ts', 7, null, { x: 1 }, 'b.ts'])))
    expect((await bodyOf($, 'ACTIVITY')).at(-1)).toBe(spread('edited', 'a.ts → b.ts', 24))
  })

  test('with no tracker files they read idle', async ($, on) => {
    await boot($, on, w => {
      w.files.delete(`/tmp/claude-agents-${SID}.json`)
      w.files.delete(`/tmp/claude-files-${SID}.json`)
    })
    expect(await bodyOf($, 'ACTIVITY')).toEqual([spread('in-flight', '0/6', 24), spread('agents', 'idle', 24), spread('edited', 'idle', 24)])
  })
})
