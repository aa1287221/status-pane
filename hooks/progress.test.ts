import { describe, expect, test } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'

import { boot, cardOf, deferred, installWorld, makeSnap, makeWorld, paneView, pair } from './fixture'
import { addRun, dropRun, fmtElapsed, progressOf, progressText, runOf } from './model'
import { layoutTree, paneLayout } from './pane'
import type { Layout } from './pane'
import type { NowState, Res, Snap } from './state'
import { FAKE_ELS, findOverflow, paneParts } from './tree'
import type { Node } from './tree'

// S1 for the PROGRESS card (its NOW row) and /progress: one view, two renderers.
const T0 = Date.parse('2026-10-10T12:00:00Z')
const SURFACES: RenderSurface[] = ['terminal', 'desktop', 'vscode', 'mobile']
const WIDTHS = [
  { columns: 36, tier: 'narrow' },
  { columns: 49, tier: 'medium' },
  { columns: 89, tier: 'wide' },
] as const

const ok = <T>(v: T): Res<T> => ({ ok: true, v })
const run = (id: string, tool: string, ageSec: number) => ({ id, tool, startedAt: T0 - ageSec * 1000 })
const state = (calls: ReturnType<typeof run>[], sid = 'S1'): Res<NowState | null> => ok({ sid, calls })
const SID_OK = ok('S1')

const layoutAt = (columns: number, tools: Res<NowState | null> | undefined, snap: Snap = makeSnap(), sid: Res<string> = SID_OK): Layout =>
  paneLayout(snap, { columns, nowMs: T0, tzMin: 0, raster: true, cpuHist: [], ...(tools ? { progress: { tools, sid } } : {}) })
const treeAt = (columns: number, tools: Res<NowState | null> | undefined, snap?: Snap, sid?: Res<string>) =>
  layoutTree(layoutAt(columns, tools, snap, sid), FAKE_ELS) as unknown as Node
const cardAt = (columns: number, tools: Res<NowState | null> | undefined, snap?: Snap, sid?: Res<string>) =>
  cardOf(paneParts(treeAt(columns, tools, snap, sid), columns), 'PROGRESS')

describe('progress: the bookkeeping of calls', () => {
  test('a main-loop call becomes a run; a subagent call, a nameless one and a missing id are handled', () => {
    expect(runOf({ tool: 'Bash', tool_use_id: 'u1' }, T0)).toEqual({ id: 'u1', tool: 'Bash', startedAt: T0 })
    expect(runOf({ tool: 'Bash', tool_use_id: 'u1', agentId: 'a1' }, T0)).toBeNull()
    expect(runOf({ tool: '' }, T0)).toBeNull()
    expect(runOf({ tool: 'Read' }, T0)?.id.startsWith(`Read@${T0}`)).toBe(true)
    // two nameless-id calls of one tool in the same millisecond do not collide
    expect(runOf({ tool: 'Read' }, T0)?.id).not.toBe(runOf({ tool: 'Read' }, T0)?.id)
    expect(runOf({ tool: 'x'.repeat(500), tool_use_id: 'u' }, T0)?.tool.length).toBe(80)
  })

  test('parallel calls are kept side by side and one ends alone', () => {
    let s: NowState | null = null
    s = addRun(s, 'S1', run('a', 'Read', 5))
    s = addRun(s, 'S1', run('b', 'Grep', 3))
    expect(s.calls.map(c => c.id)).toEqual(['a', 'b'])
    expect(dropRun(s, 'S1', 'a')?.calls.map(c => c.id)).toEqual(['b'])
    // an end that is never seen again, or twice, changes nothing
    expect(dropRun(dropRun(s, 'S1', 'zzz'), 'S1', 'zzz')?.calls.length).toBe(2)
    // the same id again replaces its run instead of doubling it
    expect(addRun(s, 'S1', run('a', 'Read', 1)).calls.filter(c => c.id === 'a').length).toBe(1)
  })

  test('another session id starts over; an end under another id leaves the record alone; the list is capped', () => {
    const s = addRun(null, 'S1', run('a', 'Read', 5))
    expect(addRun(s, 'S2', run('b', 'Grep', 1))).toEqual({ sid: 'S2', calls: [run('b', 'Grep', 1)] })
    expect(dropRun(s, 'S2', 'a')).toBe(s)
    expect(dropRun(null, 'S1', 'a')).toBeNull()
    let big: NowState | null = null
    for (let i = 0; i < 40; i++) big = addRun(big, 'S1', run(`c${i}`, 'Bash', 0))
    expect(big!.calls.length).toBe(16)
    expect(big!.calls.at(-1)!.id).toBe('c39')
  })

  test('elapsed reads in seconds, then minutes, then hours, at the edges', () => {
    expect([0, 1, 59, 60, 65, 3599, 3600, 3660, 90_000].map(fmtElapsed)).toEqual(['0s', '1s', '59s', '1m00s', '1m05s', '59m59s', '1h00m', '1h01m', '25h00m'])
    expect(fmtElapsed(-5)).toBe('0s')
    expect(fmtElapsed(NaN)).toBe('0s')
  })
})

describe('progress: the view', () => {
  test('running calls, oldest first, elapsed at the draw clock; a clock behind the start reads 0s', () => {
    const p = progressOf(state([run('b', 'Grep', 3), run('a', 'Bash', 12)]), SID_OK, T0)
    expect(p).toEqual({ ok: true, v: { running: [{ tool: 'Bash', sec: 12 }, { tool: 'Grep', sec: 3 }], more: 0 } })
    expect(progressOf(state([run('a', 'Bash', 12)]), SID_OK, T0 - 60_000)).toMatchObject({ v: { running: [{ sec: 0 }] } })
    expect(progressOf(state([run('a', 'Bash', 12)]), SID_OK, T0 + 30_000)).toMatchObject({ v: { running: [{ sec: 42 }] } })
  })

  test('more than three: three are shown and the rest are counted', () => {
    const calls = [1, 2, 3, 4, 5].map(i => run(`c${i}`, `T${i}`, 10 * (6 - i)))
    expect(progressOf(state(calls), SID_OK, T0)).toMatchObject({ ok: true, v: { running: [{ tool: 'T1' }, { tool: 'T2' }, { tool: 'T3' }], more: 2 } })
  })

  test('nothing running is an empty list, not an n/a', () => {
    expect(progressOf(state([]), SID_OK, T0)).toEqual({ ok: true, v: { running: [], more: 0 } })
  })

  test('each missing source is n/a with its own reason', () => {
    expect(progressOf({ ok: false, why: '工具紀錄讀不到：boom' }, SID_OK, T0)).toEqual({ ok: false, why: '工具紀錄讀不到：boom' })
    expect(progressOf(state([]), { ok: false, why: 'session id 讀不到：boom' }, T0)).toEqual({ ok: false, why: 'session id 讀不到：boom' })
    expect(progressOf(ok(null), SID_OK, T0)).toEqual({ ok: false, why: '本次載入後還沒有工具紀錄' })
  })

  test('records of another session are n/a, never shown as running', () => {
    const r = progressOf(state([run('a', 'Bash', 12)], 'OTHER'), SID_OK, T0)
    expect(r).toEqual({ ok: false, why: '紀錄屬於另一個 session' })
  })
})

describe('the PROGRESS card: layout', () => {
  for (const { columns, tier } of WIDTHS) {
    test(`${tier} (bodyColumns ${columns}): a band of its own after the header, NOW with the tool and its elapsed time`, () => {
      const layout = layoutAt(columns, state([run('a', 'Bash', 12)]))
      expect(layout.tier).toBe(tier)
      const bands = layout.blocks.flatMap(b => (b.kind === 'cards' ? [b.cards.map(c => `${c.id}:${c.width}`)] : []))
      expect(bands[0]).toEqual(['header:' + layout.w])
      expect(bands[1]).toEqual([`progress:${layout.w}`])
      const card = cardAt(columns, state([run('a', 'Bash', 12)]))
      expect(card.width).toBe(layout.w)
      expect(card.body).toEqual([pair('NOW', 'Bash 12s', layout.w - 4)])
    })

    test(`${tier}: idle says idle; n/a keeps the frame and says why in full`, () => {
      expect(cardAt(columns, state([])).body).toEqual([pair('NOW', 'idle', layoutAt(columns, state([])).w - 4)])
      for (const [tools, sid, why] of [
        [ok(null), SID_OK, 'n/a（本次載入後還沒有工具紀錄）'],
        [state([run('a', 'Bash', 1)], 'OTHER'), SID_OK, 'n/a（紀錄屬於另一個 session）'],
        [{ ok: false, why: '工具紀錄讀不到：boom' } as const, SID_OK, 'n/a（工具紀錄讀不到：boom）'],
        [state([]), { ok: false, why: 'session id 讀不到：boom' } as const, 'n/a（session id 讀不到：boom）'],
      ] as const) {
        const card = cardAt(columns, tools, undefined, sid)
        expect(card.body.join('').replace(/\s/g, '')).toBe(why.replace(/\s/g, ''))
        expect(card.raw[0]).toMatch(/^╭/)
        expect(card.raw.at(-1)).toMatch(/^╰/)
      }
    })

    test(`${tier}: parallel calls take a row each, the first labelled NOW; past three the rest are counted; nothing overflows`, () => {
      const calls = [run('a', 'Bash', 130), run('b', 'Read', 12), run('c', 'Grep', 3), run('d', 'Glob', 2), run('e', 'Edit', 1)]
      const card = cardAt(columns, state(calls))
      const inner = layoutAt(columns, state(calls)).w - 4
      expect(card.body).toEqual([pair('NOW', 'Bash 2m10s', inner), pair('', 'Read 12s', inner), pair('', 'Grep 3s', inner), pair('', '+2 more', inner)])
      for (const tools of [state(calls), state([]), ok(null), state([run('x', 'mcp__claude_ai_Notion__notion-search-with-a-very-long-name', 4000)])]) {
        expect(findOverflow(treeAt(columns, tools), columns)).toEqual([])
      }
    })

    test(`${tier}: a long tool name loses its head, the elapsed time stays whole`, () => {
      const name = `mcp__${'x'.repeat(100)}__tail`
      const body = cardAt(columns, state([run('x', name, 4000)])).body
      expect(body.length).toBe(1)
      expect(body[0]).toMatch(/^NOW +….*__tail 1h06m$/)
    })
  }

  test('without bookkeeping handed to the layout there is no card; with the row off there is none either', () => {
    for (const { columns } of WIDTHS) {
      expect(layoutAt(columns, undefined).blocks.flatMap(b => (b.kind === 'cards' ? b.cards.map(c => c.id) : []))).not.toContain('progress')
      const off = makeSnap()
      off.toggles.rows.progress = false
      expect(layoutAt(columns, state([])).blocks.flatMap(b => (b.kind === 'cards' ? b.cards.map(c => c.id) : []))).toContain('progress')
      expect(layoutAt(columns, state([]), off).blocks.flatMap(b => (b.kind === 'cards' ? b.cards.map(c => c.id) : []))).not.toContain('progress')
    }
  })
})

describe('/progress text: the same view as the card', () => {
  test('running: one line per shown call, the first labelled NOW; idle; the overflow count', () => {
    const calls = [run('a', 'Bash', 130), run('b', 'Read', 12), run('c', 'Grep', 3), run('d', 'Glob', 2)]
    expect(progressText(makeSnap(), state(calls), SID_OK, T0)).toBe(['NOW  Bash 2m10s', '     Read 12s', '     Grep 3s', '     +1 more'].join('\n'))
    expect(progressText(makeSnap(), state([]), SID_OK, T0)).toBe('NOW  idle')
  })

  test('n/a keeps the reason of the view', () => {
    expect(progressText(makeSnap(), ok(null), SID_OK, T0)).toBe('NOW  n/a（本次載入後還沒有工具紀錄）')
    expect(progressText(makeSnap(), state([run('a', 'Bash', 1)], 'OTHER'), SID_OK, T0)).toBe('NOW  n/a（紀錄屬於另一個 session）')
  })

  test('where the card is not drawn it says why instead of a stale answer', () => {
    const off = makeSnap()
    off.toggles.rows.progress = false
    const disabled = makeSnap()
    disabled.toggles.enabled = false
    expect(progressText(null, state([]), SID_OK, T0)).toBe('progress n/a（等待第一次更新）')
    expect(progressText(disabled, state([]), SID_OK, T0)).toBe('progress n/a（status-pane 已停用）')
    expect(progressText(off, state([]), SID_OK, T0)).toBe('progress n/a（progress 列已在 rows 檔關閉）')
  })

  for (const { columns, tier } of WIDTHS) {
    test(`${tier}: every call of the text is a row of the card with the same name and elapsed time`, () => {
      for (const calls of [[run('a', 'Bash', 12)], [run('a', 'Bash', 130), run('b', 'Read', 12), run('c', 'Grep', 3), run('d', 'Glob', 2)], []]) {
        const tools = state(calls)
        const text = progressText(makeSnap(), tools, SID_OK, T0).split('\n').map(l => l.slice(5).trim())
        const card = cardAt(columns, tools).body.map(l => l.replace(/^NOW/, '').replace(/\s+/g, ' ').trim())
        expect(card).toEqual(text.map(l => l.replace(/\s+/g, ' ')))
      }
    })
  }
})

describe('through the engine: tool.call bookkeeping, the pane and /progress', () => {
  const PROGRESS = { command: 'progress', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const
  const hold = (world: { toolResult: () => unknown }) => {
    const gate = deferred()
    world.toolResult = () => gate.promise.then(() => ({ result: {} }))
    return gate
  }
  // the NOW lines of the answer: BG and PERM follow them (inflight.test.ts)
  const nowOf = (text: string | undefined): string => (text ?? '').split('\nBG')[0]!
  const settle = async (clock: { settle: () => Promise<void> }) => {
    await clock.settle()
  }

  test('/progress is registered next to /status-pane, with immediate: true', async ($, on) => {
    const { world } = await boot($, on)
    expect(world.registered).toEqual(['status-pane', 'progress'])
    expect(world.commandSpecs.find(s => s.name === 'progress')).toMatchObject({ name: 'progress', immediate: true })
    expect(world.commandSpecs.find(s => s.name === 'status-pane')).not.toHaveProperty('immediate')
  })

  test('a fresh session reads idle at every width and surface', async ($, on) => {
    await boot($, on, w => (w.now = T0))
    for (const { columns } of WIDTHS) {
      for (const surface of SURFACES) {
        const card = cardOf(await paneView($, columns, surface), 'PROGRESS')
        expect(card.body.slice(0, 1)).toEqual([pair('NOW', 'idle', columns - 2 - 4)])
      }
    }
  })

  for (const { columns, tier } of WIDTHS) {
    test(`${tier} (bodyColumns ${columns}): a tool in flight shows with its elapsed time, follows the clock, and is gone when it ends`, async ($, on) => {
      const { world, clock } = await boot($, on, w => (w.now = T0))
      const gate = hold(world)
      const calling = $.tool.call({ tool: 'Bash', command: 'sleep 60' })
      await settle(clock)
      const inner = columns - 2 - 4
      for (const surface of SURFACES) expect(cardOf(await paneView($, columns, surface), 'PROGRESS').body.slice(0, 1)).toEqual([pair('NOW', 'Bash 0s', inner)])
      world.now = T0 + 75_000
      expect(cardOf(await paneView($, columns), 'PROGRESS').body.slice(0, 1)).toEqual([pair('NOW', 'Bash 1m15s', inner)])
      gate.release()
      await calling
      await settle(clock)
      expect(cardOf(await paneView($, columns), 'PROGRESS').body.slice(0, 1)).toEqual([pair('NOW', 'idle', inner)])
    })

    test(`${tier}: /progress answers from the same view as the card, mid-call, with no model call`, async ($, on) => {
      const { world, clock } = await boot($, on, w => (w.now = T0))
      const gate = hold(world)
      const first = $.tool.call({ tool: 'Bash', command: 'a' })
      await settle(clock)
      world.now = T0 + 12_000
      const second = $.tool.call({ tool: 'Read', file_path: '/x' })
      await settle(clock)
      world.now = T0 + 20_000
      const usageBefore = world.usageCalls
      const ran = await $.command.run(PROGRESS)
      expect(nowOf(ran.text)).toBe(['NOW  Bash 20s', '     Read 8s'].join('\n'))
      const card = cardOf(await paneView($, columns), 'PROGRESS').body.slice(0, 2).map(l => l.replace(/^NOW/, '').replace(/\s+/g, ' ').trim())
      expect(card).toEqual(nowOf(ran.text).split('\n').map(l => l.slice(5).replace(/\s+/g, ' ').trim()))
      // answering costs no refresh and no usage() call
      expect(world.usageCalls).toBe(usageBefore)
      gate.release()
      await Promise.all([first, second])
    })
  }

  test('two calls overlap and end in the other order: each leaves on its own', async ($, on) => {
    const { world, clock } = await boot($, on, w => (w.now = T0))
    const gateA = hold(world)
    const a = $.tool.call({ tool: 'Bash', command: 'a' })
    await settle(clock)
    const gateB = hold(world)
    const b = $.tool.call({ tool: 'Read', file_path: '/x' })
    await settle(clock)
    expect(nowOf((await $.command.run(PROGRESS)).text)).toMatch(/^NOW {2}Bash 0s\n {5}Read 0s$/)
    gateB.release()
    await b
    await settle(clock)
    expect(nowOf((await $.command.run(PROGRESS)).text)).toBe('NOW  Bash 0s')
    gateA.release()
    await a
    await settle(clock)
    expect(nowOf((await $.command.run(PROGRESS)).text)).toBe('NOW  idle')
  })

  test('a call that is denied still ends', async ($, on) => {
    const { world, clock } = await boot($, on, w => (w.now = T0))
    world.toolResult = () => ({ deny: 'no' })
    await $.tool.call({ tool: 'Bash', command: 'a' })
    await settle(clock)
    expect(nowOf((await $.command.run(PROGRESS)).text)).toBe('NOW  idle')
  })

  test('a call whose next() throws still ends', async ($, on) => {
    const { world, clock } = await boot($, on, w => (w.now = T0))
    world.toolResult = () => {
      throw new Error('boom')
    }
    await $.tool.call({ tool: 'Bash', command: 'a' }).catch(() => {})
    await settle(clock)
    expect(nowOf((await $.command.run(PROGRESS)).text)).toBe('NOW  idle')
  })

  test('a subagent call is not a main-loop run, and its turn ending leaves the main loop run alone', async ($, on) => {
    const { world, clock } = await boot($, on, w => (w.now = T0))
    const gate = hold(world)
    const sub = $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'a1' })
    await settle(clock)
    expect(nowOf((await $.command.run(PROGRESS)).text)).toBe('NOW  idle')
    gate.release()
    await sub
    const gate2 = hold(world)
    const main = $.tool.call({ tool: 'Agent', prompt: 'p' })
    await settle(clock)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
    await settle(clock)
    expect(nowOf((await $.command.run(PROGRESS)).text)).toBe('NOW  Agent 0s')
    gate2.release()
    await main
  })

  test('the turn ending clears a call whose end was never seen', async ($, on) => {
    const { world, clock } = await boot($, on, w => (w.now = T0))
    hold(world)
    void $.tool.call({ tool: 'Bash', command: 'a' })
    await settle(clock)
    expect(nowOf((await $.command.run(PROGRESS)).text)).toBe('NOW  Bash 0s')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await settle(clock)
    expect(nowOf((await $.command.run(PROGRESS)).text)).toBe('NOW  idle')
  })

  test('the elapsed time is repainted while a call runs, and the timer stops with it', async ($, on) => {
    const { world, clock, advance } = await boot($, on, w => (w.now = T0))
    const gate = hold(world)
    const before = world.invalidated.length
    const calling = $.tool.call({ tool: 'Bash', command: 'a' })
    await settle(clock)
    const armed = world.armed.filter(ms => ms !== 30_000)
    expect(armed).toEqual([2000])
    const mid = world.invalidated.length
    await advance(6000)
    expect(world.invalidated.length).toBeGreaterThanOrEqual(mid + 3)
    gate.release()
    await calling
    await settle(clock)
    const after = world.invalidated.length
    await advance(10_000)
    expect(world.invalidated.length).toBe(after)
    expect(before).toBeLessThanOrEqual(mid)
  })

  test('/progress answers n/a before the first refresh and never throws', async ($, on) => {
    installWorld(on, makeWorld())
    expect(nowOf((await $.command.run(PROGRESS)).text)).toBe('progress n/a（等待第一次更新）')
  })
})
