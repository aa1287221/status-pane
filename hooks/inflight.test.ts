import { describe, expect, test } from 'claude-code/testing'

import { boot, cardOf, installWorld, makeSnap, makeWorld, paneView, pair } from './fixture'
import { endTask, inflightOf, noteStop, progressText, startOf, addStart } from './model'
import { layoutTree, paneLayout } from './pane'
import type { InflightState, NowState, Res } from './state'
import { FAKE_ELS, findOverflow, paneParts } from './tree'
import type { Node } from './tree'

// S1 for the IN-FLIGHT rows (BG, PERM) of the PROGRESS card and `/progress`: background work from the Stop snapshot.
const T0 = Date.parse('2026-10-10T12:00:00Z')
const WIDTHS = [
  { columns: 36, tier: 'narrow' },
  { columns: 49, tier: 'medium' },
  { columns: 89, tier: 'wide' },
] as const

const ok = <T>(v: T): Res<T> => ({ ok: true, v })
const SID_OK = ok('S1')
const IDLE: Res<NowState | null> = ok({ sid: 'S1', calls: [] })
const PERM_TEXT = 'PERM n/a（-p 下 PermissionRequest 未觸發，TUI 未驗）'
const RLO = String.fromCharCode(0x202e)
const squash = (s: string) => s.replace(/\s/g, '')

const item = (id: string, label: string, ageSec: number, exact = true) => ({ id, kind: 'shell' as const, label, since: T0 - ageSec * 1000, exact })
const flight = (items: ReturnType<typeof item>[], seenAgoSec = 180, sid = 'S1'): Res<InflightState | null> =>
  ok({ sid, seenAt: T0 - seenAgoSec * 1000, items, starts: [] })

const bt = (over: Record<string, unknown> = {}) => ({ id: 'b1', type: 'shell', status: 'running', description: 'd', command: 'sleep 600', ...over })
const cron = (over: Record<string, unknown> = {}) => ({ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'p', ...over })

const layoutAt = (columns: number, inflight: Res<InflightState | null> | undefined, sid: Res<string> = SID_OK) =>
  paneLayout(makeSnap(), { columns, nowMs: T0, tzMin: 0, raster: true, cpuHist: [], progress: { tools: IDLE, sid, ...(inflight ? { inflight } : {}) } })
const cardAt = (columns: number, inflight: Res<InflightState | null> | undefined, sid?: Res<string>) =>
  cardOf(paneParts(layoutTree(layoutAt(columns, inflight, sid), FAKE_ELS) as unknown as Node, columns), 'PROGRESS')

describe('inflight: where a background start comes from', () => {
  test('Bash and Agent with run_in_background, CronCreate and ScheduleWakeup are starts; the rest are not', () => {
    expect(startOf({ tool: 'Bash', run_in_background: true }, T0)).toEqual({ kind: 'shell', at: T0 })
    expect(startOf({ tool: 'Agent', run_in_background: true }, T0)).toEqual({ kind: 'subagent', at: T0 })
    expect(startOf({ tool: 'CronCreate' }, T0)).toEqual({ kind: 'cron', at: T0 })
    expect(startOf({ tool: 'ScheduleWakeup' }, T0)).toEqual({ kind: 'cron', at: T0 })
    expect(startOf({ tool: 'Bash' }, T0)).toBeNull()
    expect(startOf({ tool: 'Bash', run_in_background: 'true' }, T0)).toBeNull()
    expect(startOf({ tool: 'Agent', run_in_background: false }, T0)).toBeNull()
    expect(startOf({ tool: 'Read', run_in_background: true }, T0)).toBeNull()
  })

  test('starts keep to their session and are capped', () => {
    let s: InflightState | null = null
    for (let i = 0; i < 40; i++) s = addStart(s, 'S1', { kind: 'shell', at: T0 + i })
    expect(s!.starts.length).toBe(16)
    expect(s!.starts.at(-1)!.at).toBe(T0 + 39)
    expect(addStart(s, 'S2', { kind: 'cron', at: T0 })).toEqual({ sid: 'S2', seenAt: null, items: [], starts: [{ kind: 'cron', at: T0 }] })
  })
})

describe('inflight: the Stop snapshot', () => {
  test('a task with exactly one start of its kind waited since that call; the snapshot clears the starts', () => {
    const s0 = addStart(null, 'S1', { kind: 'shell', at: T0 - 90_000 })
    const s1 = noteStop(s0, 'S1', { background_tasks: [bt()], session_crons: [] }, T0)!
    expect(s1.items).toEqual([{ id: 'b1', kind: 'shell', label: 'shell', since: T0 - 90_000, exact: true }])
    expect(s1.starts).toEqual([])
    expect(s1.seenAt).toBe(T0)
  })

  test('no matching start, or several that cannot be told apart: first seen at the Stop, not exact', () => {
    expect(noteStop(null, 'S1', { background_tasks: [bt()], session_crons: [] }, T0)!.items[0]).toMatchObject({ since: T0, exact: false })
    let s: InflightState | null = addStart(null, 'S1', { kind: 'shell', at: T0 - 50_000 })
    s = addStart(s, 'S1', { kind: 'shell', at: T0 - 40_000 })
    const out = noteStop(s, 'S1', { background_tasks: [bt()], session_crons: [] }, T0)!
    expect(out.items[0]).toMatchObject({ since: T0, exact: false })
  })

  test('two fresh items of one kind and one start: neither is exact', () => {
    const s0 = addStart(null, 'S1', { kind: 'shell', at: T0 - 90_000 })
    const out = noteStop(s0, 'S1', { background_tasks: [bt(), bt({ id: 'b2' })], session_crons: [] }, T0)!
    expect(out.items.map(i => [i.id, i.exact, i.since])).toEqual([['b1', false, T0], ['b2', false, T0]])
  })

  test('a task seen before keeps its start; one gone from the snapshot is dropped', () => {
    const a = noteStop(addStart(null, 'S1', { kind: 'shell', at: T0 - 90_000 }), 'S1', { background_tasks: [bt(), bt({ id: 'b2' })], session_crons: [] }, T0)!
    const b = noteStop(a, 'S1', { background_tasks: [bt({ id: 'b2' })], session_crons: [] }, T0 + 60_000)!
    expect(b.items.map(i => i.id)).toEqual(['b2'])
    const c = noteStop(a, 'S1', { background_tasks: [bt()], session_crons: [] }, T0 + 60_000)!
    expect(c.items[0]).toMatchObject({ id: 'b1', since: a.items.find(i => i.id === 'b1')!.since })
  })

  test('kinds: subagent, monitor, workflow, an unknown type and crons are labelled from what the engine gives, nothing else', () => {
    const out = noteStop(
      null,
      'S1',
      {
        background_tasks: [
          bt({ id: 's', type: 'subagent', agent_type: 'Explore', command: undefined }),
          bt({ id: 'm', type: 'monitor', server: 'srv', tool: 'watch', command: undefined }),
          bt({ id: 'w', type: 'workflow', name: 'review', command: undefined }),
          bt({ id: 'o', type: 'weird', command: undefined }),
        ],
        session_crons: [cron(), cron({ id: 'c2', recurring: false })],
      },
      T0,
    )!
    expect(out.items.map(i => i.label)).toEqual(['agent Explore', 'monitor srv:watch', 'workflow review', 'weird', 'cron', 'wakeup'])
    // neither a command line nor a cron prompt is kept
    expect(JSON.stringify(out)).not.toContain('sleep 600')
    expect(JSON.stringify(out)).not.toContain('"p"')
  })

  test('engine strings are cleaned and clipped: control and bidi characters go, a long name is cut', () => {
    const out = noteStop(null, 'S1', { background_tasks: [bt({ type: 'workflow', name: `a${RLO}b\nc${'x'.repeat(100)}`, command: undefined })], session_crons: [] }, T0)!
    expect(out.items[0].label).toMatch(/^workflow abc/)
    expect(out.items[0].label.length).toBeLessThanOrEqual(48)
    expect(out.items[0].label).not.toMatch(new RegExp(`[${RLO}\\n]`))
  })

  test('a field the engine left out is not an empty list: the earlier items of that class stay', () => {
    const a = noteStop(null, 'S1', { background_tasks: [bt()], session_crons: [cron()] }, T0)!
    const b = noteStop(a, 'S1', { background_tasks: [] }, T0 + 1000)!
    expect(b.items.map(i => i.label)).toEqual(['cron'])
    const c = noteStop(a, 'S1', { session_crons: [] }, T0 + 1000)!
    expect(c.items.map(i => i.label)).toEqual(['shell'])
    // neither field: no snapshot at all
    expect(noteStop(a, 'S1', {}, T0 + 1000)).toBe(a)
  })

  test('another session id starts over', () => {
    const a = noteStop(null, 'S1', { background_tasks: [bt()], session_crons: [] }, T0)!
    expect(noteStop(a, 'S2', { background_tasks: [], session_crons: [] }, T0)).toMatchObject({ sid: 'S2', items: [] })
  })

  test('a notification ends its task by id; an unknown id or another session changes nothing', () => {
    const a = noteStop(null, 'S1', { background_tasks: [bt(), bt({ id: 'b2' })], session_crons: [] }, T0)!
    expect(endTask(a, 'S1', 'b1')?.items.map(i => i.id)).toEqual(['b2'])
    expect(endTask(a, 'S1', 'nope')).toBe(a)
    expect(endTask(a, 'S2', 'b1')).toBe(a)
    expect(endTask(null, 'S1', 'b1')).toBeNull()
  })
})

describe('inflight: the view', () => {
  test('oldest first, elapsed at the draw clock, three shown and the rest counted, with the snapshot age', () => {
    const items = [item('d', 'wakeup', 5), item('a', 'shell', 190), item('b', 'cron', 60), item('c', 'shell', 12, false)]
    expect(inflightOf(flight(items), SID_OK, T0)).toEqual({
      ok: true,
      v: { items: [{ label: 'shell', sec: 190, exact: true }, { label: 'cron', sec: 60, exact: true }, { label: 'shell', sec: 12, exact: false }], more: 1, ageSec: 180 },
    })
    expect(inflightOf(flight([item('a', 'shell', 10)]), SID_OK, T0 - 400_000)).toMatchObject({ v: { items: [{ sec: 0 }], ageSec: 0 } })
  })

  test('nothing in flight is an empty list, not an n/a', () => {
    expect(inflightOf(flight([]), SID_OK, T0)).toEqual({ ok: true, v: { items: [], more: 0, ageSec: 180 } })
  })

  test('each missing source is n/a with its own reason; another session is never shown', () => {
    expect(inflightOf({ ok: false, why: '背景工作紀錄讀不到：boom' }, SID_OK, T0)).toEqual({ ok: false, why: '背景工作紀錄讀不到：boom' })
    expect(inflightOf(flight([]), { ok: false, why: 'session id 讀不到：boom' }, T0)).toEqual({ ok: false, why: 'session id 讀不到：boom' })
    expect(inflightOf(ok(null), SID_OK, T0)).toEqual({ ok: false, why: '還沒有回合結束的快照' })
    expect(inflightOf(ok({ sid: 'S1', seenAt: null, items: [], starts: [{ kind: 'shell', at: T0 }] }), SID_OK, T0)).toEqual({ ok: false, why: '還沒有回合結束的快照' })
    expect(inflightOf(flight([item('a', 'shell', 5)], 10, 'OTHER'), SID_OK, T0)).toEqual({ ok: false, why: '紀錄屬於另一個 session' })
  })
})

describe('the PROGRESS card: BG and PERM rows at the three layouts', () => {
  for (const { columns, tier } of WIDTHS) {
    const inner = columns - 2 - 4
    test(`${tier} (bodyColumns ${columns}): NOW, then BG with each item and its wait, the snapshot age, and the PERM n/a`, () => {
      const card = cardAt(columns, flight([item('a', 'shell', 190), item('b', 'cron', 60), item('c', 'shell', 12, false), item('d', 'wakeup', 3)]))
      expect(card.body.slice(0, 6)).toEqual([
        pair('NOW', 'idle', inner),
        pair('BG', 'shell 3m10s', inner),
        pair('', 'cron 1m00s', inner),
        pair('', '≥shell 12s', inner),
        pair('', '+1 more', inner),
        pair('', 'snapshot 3m00s ago', inner),
      ])
      expect(squash(card.body.slice(6).join(''))).toBe(squash(PERM_TEXT))
    })

    test(`${tier}: nothing in flight says none; every n/a keeps the frame and is read in full`, () => {
      expect(cardAt(columns, flight([])).body.slice(0, 3)).toEqual([pair('NOW', 'idle', inner), pair('BG', 'none', inner), pair('', 'snapshot 3m00s ago', inner)])
      for (const [inflight, why] of [
        [ok(null), 'BG n/a（還沒有回合結束的快照）'],
        [{ ok: false, why: '背景工作紀錄讀不到：boom' } as const, 'BG n/a（背景工作紀錄讀不到：boom）'],
        [flight([item('a', 'shell', 5)], 10, 'OTHER'), 'BG n/a（紀錄屬於另一個 session）'],
      ] as const) {
        const card = cardAt(columns, inflight)
        expect(squash(card.body.join(''))).toBe(squash(`NOWidle${why}${PERM_TEXT}`))
        expect(card.raw[0]).toMatch(/^╭/)
        expect(card.raw.at(-1)).toMatch(/^╰/)
      }
    })

    test(`${tier}: a long label loses its tail to the row, the wait stays whole; nothing overflows`, () => {
      const long = item('a', `workflow ${'x'.repeat(38)}`, 4000)
      for (const inflight of [flight([long]), flight([]), ok(null), flight([item('a', 'shell', 1), item('b', 'cron', 2), item('c', 'shell', 3), item('d', 'cron', 4)])]) {
        expect(findOverflow(layoutTree(layoutAt(columns, inflight), FAKE_ELS) as unknown as Node, columns)).toEqual([])
      }
      const row = cardAt(columns, flight([long])).body[1]
      expect(row).toMatch(/^BG +workflow x+.* 1h06m$/)
    })
  }

  test('without inflight handed to the layout the card is the NOW band alone', () => {
    for (const { columns } of WIDTHS) {
      expect(cardAt(columns, undefined).body).toEqual([pair('NOW', 'idle', columns - 2 - 4)])
    }
  })
})

describe('/progress text: the same rows as the card', () => {
  test('BG lines under NOW, the snapshot age, then PERM', () => {
    const text = progressText(makeSnap(), IDLE, SID_OK, T0, flight([item('a', 'shell', 190), item('b', 'cron', 60)]))
    expect(text).toBe(['NOW  idle', 'BG   shell 3m10s', '     cron 1m00s', '     snapshot 3m00s ago', PERM_TEXT].join('\n'))
    expect(progressText(makeSnap(), IDLE, SID_OK, T0, flight([]))).toBe(['NOW  idle', 'BG   none', '     snapshot 3m00s ago', PERM_TEXT].join('\n'))
    expect(progressText(makeSnap(), IDLE, SID_OK, T0, ok(null))).toBe(['NOW  idle', 'BG   n/a（還沒有回合結束的快照）', PERM_TEXT].join('\n'))
  })

  for (const { columns, tier } of WIDTHS) {
    test(`${tier}: every BG line of the text is a row of the card`, () => {
      for (const inflight of [flight([item('a', 'shell', 190), item('b', 'cron', 60), item('c', 'shell', 12, false), item('d', 'cron', 3)]), flight([])]) {
        const text = progressText(makeSnap(), IDLE, SID_OK, T0, inflight).split('\n').slice(1, -1).map(l => l.slice(5).replace(/\s+/g, ' ').trim())
        const card = cardAt(columns, inflight).body.slice(1).map(l => l.replace(/^BG/, '').replace(/\s+/g, ' ').trim())
        expect(card.slice(0, text.length)).toEqual(text)
      }
    })
  }

  test('where the card is not drawn it says why, before any BG line', () => {
    const off = makeSnap()
    off.toggles.rows.progress = false
    expect(progressText(off, IDLE, SID_OK, T0, flight([]))).toBe('progress n/a（progress 列已在 rows 檔關閉）')
  })
})

describe('through the engine: Stop snapshot, tool.call starts and notifications', () => {
  const PROGRESS = { command: 'progress', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const
  const bgBody = async ($: Parameters<typeof paneView>[0], columns: number) => (await paneView($, columns)).cards.find(c => c.title === 'PROGRESS')!.body
  const NOTE = (id: string) =>
    ({ text: 'done', origin: { kind: 'task-notification' }, isExpanded: false, task: { id, status: 'completed' } }) as never

  test('a fresh session reads n/a for BG at every width, and says why in /progress', async ($, on) => {
    await boot($, on, w => (w.now = T0))
    for (const { columns } of WIDTHS) {
      const body = await bgBody($, columns)
      expect(squash(body.join(''))).toBe(squash(`NOWidleBG n/a（還沒有回合結束的快照）${PERM_TEXT}`))
    }
    expect((await $.command.run(PROGRESS)).text).toBe(['NOW  idle', 'BG   n/a（還沒有回合結束的快照）', PERM_TEXT].join('\n'))
  })

  for (const { columns, tier } of WIDTHS) {
    test(`${tier} (bodyColumns ${columns}): a background shell started this turn waits from its call, and is gone when its notification comes`, async ($, on) => {
      const { world, clock } = await boot($, on, w => (w.now = T0))
      const inner = columns - 2 - 4
      await $.tool.call({ tool: 'Bash', command: 'sleep 600', run_in_background: true })
      world.now = T0 + 90_000
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [bt()], session_crons: [] })
      await clock.settle()
      world.now = T0 + 100_000
      const body = await bgBody($, columns)
      expect(body.slice(0, 3)).toEqual([pair('NOW', 'idle', inner), pair('BG', 'shell 1m40s', inner), pair('', 'snapshot 10s ago', inner)])
      expect((await $.command.run(PROGRESS)).text).toBe(['NOW  idle', 'BG   shell 1m40s', '     snapshot 10s ago', PERM_TEXT].join('\n'))
      const msg = await $.ui.mount({ plugin: 'status-pane', surface: 'terminal', component: 'UserMessage', props: NOTE('b1') })
      await msg.drawn()
      await msg.unmount()
      await clock.settle()
      expect((await bgBody($, columns)).slice(0, 2)).toEqual([pair('NOW', 'idle', inner), pair('BG', 'none', inner)])
    })
  }

  for (const mode of ['deny', 'error', 'throw', 'subagent'] as const) {
    test(`a background call that ends as ${mode} leaves no start: a fresh shell at the Stop is only a lower bound`, async ($, on) => {
      const { world, clock } = await boot($, on, w => (w.now = T0))
      if (mode === 'deny') world.toolResult = () => ({ deny: 'no' })
      if (mode === 'error') world.toolResult = () => ({ result: {}, isError: true })
      if (mode === 'throw') world.toolResult = () => { throw new Error('boom') }
      await $.tool.call({ tool: 'Bash', command: 'sleep 600', run_in_background: true, ...(mode === 'subagent' ? { agentId: 'a1' } : {}) } as never).catch(() => undefined)
      world.now = T0 + 600_000
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [bt()], session_crons: [] })
      await clock.settle()
      expect((await $.command.run(PROGRESS)).text).toContain('BG   ≥shell 0s')
    })
  }

  test('a start is dated by when the call began, not when it settled', async ($, on) => {
    const { world, clock } = await boot($, on, w => (w.now = T0))
    world.toolResult = () => {
      world.now = T0 + 5_000
      return { result: {} }
    }
    await $.tool.call({ tool: 'Bash', command: 'x', run_in_background: true })
    world.now = T0 + 60_000
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [bt()], session_crons: [] })
    await clock.settle()
    expect((await $.command.run(PROGRESS)).text).toContain('BG   shell 1m00s')
  })

  test('the hidden ids last until the next Stop only: a reused id is shown again', async ($, on) => {
    const { clock } = await boot($, on, w => (w.now = T0))
    const note = async (id: string) => {
      const m = await $.ui.mount({ plugin: 'status-pane', surface: 'terminal', component: 'UserMessage', props: NOTE(id) })
      await m.drawn()
      await m.unmount()
    }
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [bt()], session_crons: [] })
    await note('b1')
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [bt()], session_crons: [] })
    await clock.settle()
    expect((await $.command.run(PROGRESS)).text).toContain('BG   ≥shell 0s')
  })

  test('only 64 notification ids are held: the 65th hides nothing', async ($, on) => {
    const { clock } = await boot($, on, w => (w.now = T0))
    const ids = Array.from({ length: 65 }, (_, i) => `n${i}`)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: ids.map(id => bt({ id })), session_crons: [] })
    for (const id of ids) {
      const m = await $.ui.mount({ plugin: 'status-pane', surface: 'terminal', component: 'UserMessage', props: NOTE(id) })
      await m.drawn()
      await m.unmount()
    }
    await clock.settle()
    expect((await $.command.run(PROGRESS)).text).toContain('BG   ≥shell 0s\n')
  })

  test('hidden ids belong to the session that drew them', async ($, on) => {
    const { world, clock } = await boot($, on, w => (w.now = T0))
    const note = async (id: string) => {
      const m = await $.ui.mount({ plugin: 'status-pane', surface: 'terminal', component: 'UserMessage', props: NOTE(id) })
      await m.drawn()
      await m.unmount()
    }
    const sid = world.session.id
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [bt(), bt({ id: 'b2' })], session_crons: [] })
    await note('b1')
    world.session.id = 'S2-other'
    await note('b2')
    world.session.id = sid
    await clock.settle()
    expect((await $.command.run(PROGRESS)).text).toContain('BG   ≥shell 0s\n     ≥shell 0s')
  })

  test('a cron in the snapshot shows as cron, a one-shot as wakeup; a later empty Stop clears both', async ($, on) => {
    const { world, clock } = await boot($, on, w => (w.now = T0))
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [cron(), cron({ id: 'c2', recurring: false })] })
    await clock.settle()
    expect((await $.command.run(PROGRESS)).text).toBe(['NOW  idle', 'BG   ≥cron 0s', '     ≥wakeup 0s', '     snapshot 0s ago', PERM_TEXT].join('\n'))
    world.now = T0 + 30_000
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
    await clock.settle()
    expect((await $.command.run(PROGRESS)).text).toBe(['NOW  idle', 'BG   none', '     snapshot 0s ago', PERM_TEXT].join('\n'))
  })

  test('a subagent Stop is not the session snapshot; a Stop with neither field changes nothing', async ($, on) => {
    const { clock } = await boot($, on, w => (w.now = T0))
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [bt()], session_crons: [] })
    await clock.settle()
    await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'a1', agent_type: 'Explore', background_tasks: [], session_crons: [] } as never)
    await $.classic.Stop({ stop_hook_active: false, agent_id: 'a1', background_tasks: [], session_crons: [] } as never)
    await clock.settle()
    expect((await $.command.run(PROGRESS)).text).toContain('BG   ≥shell 0s')
    await $.classic.Stop({ stop_hook_active: false })
    await clock.settle()
    expect((await $.command.run(PROGRESS)).text).toContain('BG   ≥shell 0s')
  })

  test('the main loop turn ending does not clear the snapshot', async ($, on) => {
    const { clock } = await boot($, on, w => (w.now = T0))
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [bt()], session_crons: [] })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    expect((await $.command.run(PROGRESS)).text).toContain('BG   ≥shell 0s')
  })

  test('a message that is not a task notification, or names another id, ends nothing; /progress never throws before the first refresh', async ($, on) => {
    const { clock } = await boot($, on, w => (w.now = T0))
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [bt()], session_crons: [] })
    await clock.settle()
    const plain = await $.ui.mount({ plugin: 'status-pane', surface: 'terminal', component: 'UserMessage', props: { text: 'hi', origin: { kind: 'user' }, isExpanded: false, task: { id: 'b1' } } as never })
    await plain.drawn()
    await plain.unmount()
    const other = await $.ui.mount({ plugin: 'status-pane', surface: 'terminal', component: 'UserMessage', props: NOTE('zzz') })
    await other.drawn()
    await other.unmount()
    await clock.settle()
    expect((await $.command.run(PROGRESS)).text).toContain('BG   ≥shell 0s')
  })

  test('/progress answers n/a before the first refresh', async ($, on) => {
    installWorld(on, makeWorld())
    expect((await $.command.run(PROGRESS)).text).toBe('progress n/a（等待第一次更新）')
  })
})
