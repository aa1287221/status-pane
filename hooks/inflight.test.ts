import { describe, expect, test } from 'claude-code/testing'

import { boot, cardOf, deferred, installWorld, makeSnap, makeWorld, paneView, pair } from './fixture'
import type { World } from './fixture'
import { addStart, bgStartOf, dw, endTask, inflightOf, mayStartBg, noteStop, progressText, startOf, taskIdOf } from './model'
import { layoutTree, paneLayout } from './pane'
import type { BgStart, InflightState, NowState, Res } from './state'
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

const withStarts = (starts: BgStart[], over: Partial<InflightState> = {}): InflightState => ({ sid: 'S1', seenAt: null, items: [], starts, ...over })
const stopWith = (s: InflightState | null, tasks: Record<string, unknown>[], now = T0, crons: Record<string, unknown>[] = []) =>
  noteStop(s, 'S1', { background_tasks: tasks, session_crons: crons }, now)!
const waits = (s: InflightState) => s.items.map(i => [i.id, i.exact, i.since])

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

  test('a ScheduleWakeup that only cancels (stop: true) starts nothing; any other stop value is still a start', () => {
    expect(startOf({ tool: 'ScheduleWakeup', stop: true }, T0)).toBeNull()
    expect(startOf({ tool: 'ScheduleWakeup', stop: false }, T0)).toEqual({ kind: 'cron', at: T0 })
    expect(startOf({ tool: 'ScheduleWakeup', stop: 'true' }, T0)).toEqual({ kind: 'cron', at: T0 })
  })

  test('starts keep to their session and are capped', () => {
    let s: InflightState | null = null
    for (let i = 0; i < 100; i++) s = addStart(s, 'S1', { kind: 'shell', at: T0 + i })
    expect(s!.starts.length).toBe(64)
    expect(s!.starts.at(-1)!.at).toBe(T0 + 99)
    expect(s!.dropped).toBe(true)
    expect(addStart(s, 'S2', { kind: 'cron', at: T0 })).toEqual({ sid: 'S2', seenAt: null, items: [], starts: [{ kind: 'cron', at: T0 }] })
  })

  test('64 starts are all kept and nothing is marked cut; the 65th evicts the oldest and marks it', () => {
    let s: InflightState | null = null
    for (let i = 0; i < 64; i++) s = addStart(s, 'S1', { kind: 'shell', at: T0 + i })
    expect(s!.starts.length).toBe(64)
    expect(s!.starts[0].at).toBe(T0)
    expect(s).not.toHaveProperty('dropped')
    s = addStart(s, 'S1', { kind: 'shell', at: T0 + 64 })
    expect(s.starts.length).toBe(64)
    expect(s.starts[0].at).toBe(T0 + 1)
    expect(s.dropped).toBe(true)
  })

  test('a cut once stays marked until the Stop, even through an add that cuts nothing', () => {
    const marked: InflightState = { sid: 'S1', seenAt: T0, items: [], starts: [{ kind: 'shell', at: T0 }], dropped: true }
    expect(addStart(marked, 'S1', { kind: 'cron', at: T0 + 1 }).dropped).toBe(true)
    expect(addStart(marked, 'S2', { kind: 'cron', at: T0 + 1 })).not.toHaveProperty('dropped')
  })
})

describe('inflight: the task id a call names', () => {
  test('Bash names backgroundTaskId, an async Agent launch its agentId, CronCreate its id', () => {
    expect(taskIdOf('Bash', { result: { backgroundTaskId: 'b7', backgroundedByUser: true } })).toBe('b7')
    expect(taskIdOf('Agent', { result: { status: 'async_launched', agentId: 'agent-a' } })).toBe('agent-a')
    expect(taskIdOf('CronCreate', { result: { id: 'c9', humanSchedule: 'every 5 minutes', recurring: true, durable: false } })).toBe('c9')
  })

  test('anything else names nothing: a finished agent, a wakeup, another tool, another key, an empty or non-string id', () => {
    expect(taskIdOf('Agent', { result: { status: 'completed', agentId: 'agent-a' } })).toBeNull()
    expect(taskIdOf('Agent', { result: { agentId: 'agent-a' } })).toBeNull()
    expect(taskIdOf('ScheduleWakeup', { result: { scheduledFor: 1, id: 'w1', backgroundTaskId: 'w1', agentId: 'w1' } })).toBeNull()
    expect(taskIdOf('Read', { result: { id: 'r1', backgroundTaskId: 'r1', agentId: 'r1' } })).toBeNull()
    // each tool reads its own key only
    expect(taskIdOf('Bash', { result: { id: 'x', agentId: 'x' } })).toBeNull()
    expect(taskIdOf('CronCreate', { result: { backgroundTaskId: 'x', agentId: 'x' } })).toBeNull()
    expect(taskIdOf('Agent', { result: { status: 'async_launched', id: 'x', backgroundTaskId: 'x' } })).toBeNull()
    for (const id of ['', 7, null, undefined, {}, ['b1']]) {
      expect(taskIdOf('Bash', { result: { backgroundTaskId: id } })).toBeNull()
      expect(taskIdOf('CronCreate', { result: { id } })).toBeNull()
      expect(taskIdOf('Agent', { result: { status: 'async_launched', agentId: id } })).toBeNull()
    }
  })

  test('a result that is not the expected shape names nothing and never throws', () => {
    for (const ran of [null, undefined, 'x', 7, true, [], {}, { result: 'x' }, { result: null }, { result: 7 }, { result: [] }, { deny: 'no' }]) {
      for (const tool of ['Bash', 'Agent', 'CronCreate', 'ScheduleWakeup', 'Read']) expect(taskIdOf(tool, ran)).toBeNull()
    }
    // control: the same calls do name a task when the result has the shape
    expect(taskIdOf('Bash', { result: { backgroundTaskId: 'ok' } })).toBe('ok')
  })
})

describe('inflight: the start a finished call leaves', () => {
  test('only Bash, Agent, CronCreate and ScheduleWakeup may start background work, by own name', () => {
    for (const tool of ['Bash', 'Agent', 'CronCreate', 'ScheduleWakeup']) expect(mayStartBg({ tool })).toBe(true)
    for (const tool of ['Read', 'Edit', 'bash', 'agent', '', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) expect(mayStartBg({ tool })).toBe(false)
    expect(bgStartOf({ tool: 'constructor', run_in_background: true }, { result: { backgroundTaskId: 'b1' } }, T0)).toBeNull()
  })

  const NAMES = (key: string, id: string) => ({ result: { [key]: id } })
  const NONE = { result: {} }
  const rows: [string, Record<string, unknown>, unknown, BgStart | null][] = [
    ['main Bash in the background, its result names the task: keyed', { tool: 'Bash', run_in_background: true }, NAMES('backgroundTaskId', 'b1'), { kind: 'shell', at: T0, id: 'b1' }],
    ['Bash without the flag whose result names a task (moved by hand): keyed', { tool: 'Bash' }, { result: { backgroundTaskId: 'b7', backgroundedByUser: true } }, { kind: 'shell', at: T0, id: 'b7' }],
    ['main Bash in the background, no id: an open start', { tool: 'Bash', run_in_background: true }, NONE, { kind: 'shell', at: T0 }],
    ['main Bash in the background, no result at all: an open start', { tool: 'Bash', run_in_background: true }, undefined, { kind: 'shell', at: T0 }],
    ['subagent Bash in the background, no id: a veto', { tool: 'Bash', run_in_background: true, agentId: 'a1' }, NONE, { kind: 'shell', at: T0, veto: true }],
    ['subagent Bash in the background, its result names the task: keyed', { tool: 'Bash', run_in_background: true, agentId: 'a1' }, NAMES('backgroundTaskId', 'sub1'), { kind: 'shell', at: T0, id: 'sub1' }],
    ['subagent Bash in the foreground, no id: nothing', { tool: 'Bash', agentId: 'a1' }, NONE, null],
    ['main Bash in the foreground, no id: nothing', { tool: 'Bash' }, NONE, null],
    ['main Agent with the flag, no id: an open start', { tool: 'Agent', run_in_background: true }, NONE, { kind: 'subagent', at: T0 }],
    ['main Agent without the flag, no id: a veto, the engine runs it in the background by default', { tool: 'Agent' }, NONE, { kind: 'subagent', at: T0, veto: true }],
    ['subagent Agent without the flag, no id: a veto', { tool: 'Agent', agentId: 'a1' }, NONE, { kind: 'subagent', at: T0, veto: true }],
    ['subagent Agent with the flag, no id: a veto', { tool: 'Agent', run_in_background: true, agentId: 'a1' }, NONE, { kind: 'subagent', at: T0, veto: true }],
    ['Agent with run_in_background false: nothing', { tool: 'Agent', run_in_background: false }, NONE, null],
    ['Agent async launch, with the flag: keyed', { tool: 'Agent', run_in_background: true }, { result: { status: 'async_launched', agentId: 'agent-a' } }, { kind: 'subagent', at: T0, id: 'agent-a' }],
    ['Agent async launch, without the flag: keyed', { tool: 'Agent' }, { result: { status: 'async_launched', agentId: 'agent-b' } }, { kind: 'subagent', at: T0, id: 'agent-b' }],
    ['Agent with the flag whose result is a finished run: an open start, not keyed', { tool: 'Agent', run_in_background: true }, { result: { status: 'completed', agentId: 'agent-a' } }, { kind: 'subagent', at: T0 }],
    ['main CronCreate, no id: an open start', { tool: 'CronCreate' }, NONE, { kind: 'cron', at: T0 }],
    ['CronCreate, its result names the cron: keyed', { tool: 'CronCreate' }, NAMES('id', 'c9'), { kind: 'cron', at: T0, id: 'c9' }],
    ['subagent CronCreate, no id: a veto', { tool: 'CronCreate', agentId: 'a1' }, NONE, { kind: 'cron', at: T0, veto: true }],
    ['subagent CronCreate, its result names the cron: keyed', { tool: 'CronCreate', agentId: 'a1' }, NAMES('id', 'c9'), { kind: 'cron', at: T0, id: 'c9' }],
    ['main ScheduleWakeup (its result has no id): an open start', { tool: 'ScheduleWakeup' }, { result: { scheduledFor: T0, clampedDelaySeconds: 60, wasClamped: false } }, { kind: 'cron', at: T0 }],
    ['subagent ScheduleWakeup: a veto', { tool: 'ScheduleWakeup', agentId: 'a1' }, NONE, { kind: 'cron', at: T0, veto: true }],
    ['ScheduleWakeup with stop true: nothing', { tool: 'ScheduleWakeup', stop: true }, { result: { stopped: true, cancelledWakeups: 0 } }, null],
    ['subagent ScheduleWakeup with stop true: nothing', { tool: 'ScheduleWakeup', stop: true, agentId: 'a1' }, NONE, null],
    ['Read: nothing', { tool: 'Read' }, { result: 'text' }, null],
  ]
  for (const [name, input, ran, want] of rows) {
    test(`bgStartOf: ${name}`, () => {
      expect(bgStartOf(input as never, ran, T0)).toEqual(want)
    })
  }
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

  test('a task whose id a start names is exact with that start, whatever else is fresh or open', () => {
    const s = withStarts([{ kind: 'shell', at: T0 - 90_000, id: 'b1' }, { kind: 'shell', at: T0 - 60_000, id: 'b2' }, { kind: 'shell', at: T0 - 30_000 }])
    expect(waits(stopWith(s, [bt(), bt({ id: 'b2' })]))).toEqual([['b1', true, T0 - 90_000], ['b2', true, T0 - 60_000]])
  })

  test('a keyed task does not count against the open start: the other fresh task is dated by it', () => {
    const s = withStarts([{ kind: 'shell', at: T0 - 90_000, id: 'b1' }, { kind: 'shell', at: T0 - 30_000 }])
    expect(waits(stopWith(s, [bt(), bt({ id: 'b2' })]))).toEqual([['b1', true, T0 - 90_000], ['b2', true, T0 - 30_000]])
  })

  test('a key whose task the Stop does not list dates no other task', () => {
    expect(waits(stopWith(withStarts([{ kind: 'shell', at: T0 - 90_000, id: 'gone' }]), [bt()]))).toEqual([['b1', false, T0]])
  })

  test('a start keyed to the same id but another kind does not date the task; the same kind does', () => {
    expect(waits(stopWith(withStarts([{ kind: 'cron', at: T0 - 90_000, id: 'b1' }]), [bt()]))).toEqual([['b1', false, T0]])
    expect(waits(stopWith(withStarts([{ kind: 'shell', at: T0 - 90_000, id: 'c1' }]), [], T0, [cron()]))).toEqual([['c1', false, T0]])
    expect(waits(stopWith(withStarts([{ kind: 'shell', at: T0 - 90_000, id: 'a1' }]), [bt({ id: 'a1', type: 'subagent', command: undefined })]))).toEqual([['a1', false, T0]])
    expect(waits(stopWith(withStarts([{ kind: 'cron', at: T0 - 90_000, id: 'c1' }]), [], T0, [cron()]))).toEqual([['c1', true, T0 - 90_000]])
  })

  test('a veto of the kind makes the count rule give up, beside an open start or alone; a veto of another kind does not', () => {
    const open: BgStart = { kind: 'shell', at: T0 - 90_000 }
    const veto: BgStart = { kind: 'shell', at: T0 - 30_000, veto: true }
    expect(waits(stopWith(withStarts([open, veto]), [bt()]))).toEqual([['b1', false, T0]])
    expect(waits(stopWith(withStarts([veto]), [bt()]))).toEqual([['b1', false, T0]])
    expect(waits(stopWith(withStarts([open]), [bt()]))).toEqual([['b1', true, T0 - 90_000]])
    expect(waits(stopWith(withStarts([open, { kind: 'subagent', at: T0 - 30_000, veto: true }]), [bt()]))).toEqual([['b1', true, T0 - 90_000]])
  })

  test('a start list that lost starts to the cap gives up the count rule but not a key, and the Stop clears the mark', () => {
    const s = withStarts([{ kind: 'shell', at: T0 - 90_000 }, { kind: 'cron', at: T0 - 60_000, id: 'c1' }], { dropped: true })
    const out = stopWith(s, [bt()], T0, [cron()])
    expect(waits(out)).toEqual([['b1', false, T0], ['c1', true, T0 - 60_000]])
    expect(out).not.toHaveProperty('dropped')
    expect(out.starts).toEqual([])
  })

  test('a key that arrives after a Stop listed the task dates it at the next Stop', () => {
    const first = stopWith(null, [bt()])
    expect(waits(first)).toEqual([['b1', false, T0]])
    const keyed = addStart(first, 'S1', { kind: 'shell', at: T0 - 50_000, id: 'b1' })
    expect(waits(stopWith(keyed, [bt()], T0 + 60_000))).toEqual([['b1', true, T0 - 50_000]])
  })

  test('a late key is used for its own kind only, and never moves a task that is already exact', () => {
    const first = stopWith(null, [bt()])
    expect(waits(stopWith(addStart(first, 'S1', { kind: 'cron', at: T0 - 50_000, id: 'b1' }), [bt()], T0 + 60_000))).toEqual([['b1', false, T0]])
    const exact = stopWith(withStarts([{ kind: 'shell', at: T0 - 90_000 }]), [bt()])
    expect(waits(exact)).toEqual([['b1', true, T0 - 90_000]])
    expect(waits(stopWith(addStart(exact, 'S1', { kind: 'shell', at: T0 - 10_000, id: 'b1' }), [bt()], T0 + 60_000))).toEqual([['b1', true, T0 - 90_000]])
  })

  test('a monitor, a workflow or a task of an unknown type is never dated by a shell start, open or keyed', () => {
    const tasks: [string, Record<string, unknown>][] = [
      ['m', bt({ id: 'm', type: 'monitor', server: 'srv', tool: 'watch', command: undefined })],
      ['w', bt({ id: 'w', type: 'workflow', name: 'review', command: undefined })],
      ['o', bt({ id: 'o', type: 'weird', command: undefined })],
    ]
    for (const [id, task] of tasks) {
      expect(waits(stopWith(withStarts([{ kind: 'shell', at: T0 - 90_000 }]), [task]))).toEqual([[id, false, T0]])
      expect(waits(stopWith(withStarts([{ kind: 'shell', at: T0 - 90_000, id }]), [task]))).toEqual([[id, false, T0]])
    }
    // the same start does date a shell
    expect(waits(stopWith(withStarts([{ kind: 'shell', at: T0 - 90_000 }]), [bt()]))).toEqual([['b1', true, T0 - 90_000]])
  })

  test('tasks of other kinds that are new at the same Stop do not take the start from the one task of its kind', () => {
    const s = withStarts([{ kind: 'shell', at: T0 - 90_000 }])
    const out = stopWith(s, [bt(), bt({ id: 'w', type: 'workflow', name: 'review', command: undefined })], T0, [cron()])
    expect(waits(out)).toEqual([['b1', true, T0 - 90_000], ['w', false, T0], ['c1', false, T0]])
  })

  test('an open start dates only a task of its own kind', () => {
    const s = withStarts([{ kind: 'shell', at: T0 - 90_000 }])
    expect(waits(stopWith(s, [bt({ id: 'a', type: 'subagent', command: undefined })], T0, [cron()]))).toEqual([['a', false, T0], ['c1', false, T0]])
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

  const CJK = String.fromCodePoint(0x4e2d)
  const EMOJI = String.fromCodePoint(0x1f600)
  const labelOf = (name: string) => noteStop(null, 'S1', { background_tasks: [bt({ type: 'workflow', name, command: undefined })], session_crons: [] }, T0)!.items[0].label
  // a high surrogate without its low one, or a low one without its high
  const loneSurrogate = (text: string): boolean => {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = text.charCodeAt(i + 1)
        if (!(d >= 0xdc00 && d <= 0xdfff)) return true
        i++
      } else if (c >= 0xdc00 && c <= 0xdfff) return true
    }
    return false
  }

  test('label check: the detector finds a split pair and passes a whole one', () => {
    expect(loneSurrogate(`x${EMOJI.slice(0, 1)}`)).toBe(true)
    expect(loneSurrogate(`${EMOJI.slice(1)}x`)).toBe(true)
    expect(loneSurrogate(`x${EMOJI}x`)).toBe(false)
  })

  test('label: a long CJK name is cut at 48 cells with an ellipsis, not at 48 characters', () => {
    const label = labelOf(CJK.repeat(60))
    expect(dw(label)).toBeLessThanOrEqual(48)
    expect(label).toBe(`workflow ${CJK.repeat(19)}…`)
  })

  test('label: an emoji that straddles the cut is dropped whole, never split', () => {
    const label = labelOf(`${'x'.repeat(38)}${EMOJI}more text`)
    expect(loneSurrogate(label)).toBe(false)
    expect(dw(label)).toBeLessThanOrEqual(48)
    expect(label).toBe(`workflow ${'x'.repeat(38)}…`)
    // one cell earlier its two cells still do not fit, and its halves are not tried one by one
    const early = labelOf(`${'x'.repeat(37)}${EMOJI}more text`)
    expect(loneSurrogate(early)).toBe(false)
    expect(early).toBe(`workflow ${'x'.repeat(37)}…`)
    // the emoji that fits is kept whole
    const kept = labelOf(`${'x'.repeat(36)}${EMOJI}more text`)
    expect(loneSurrogate(kept)).toBe(false)
    expect(kept).toBe(`workflow ${'x'.repeat(36)}${EMOJI}…`)
  })

  test('label: 48 cells fit as they are; 49 are cut to 47 and an ellipsis; a space at the cut goes with it', () => {
    expect(labelOf('x'.repeat(39))).toBe(`workflow ${'x'.repeat(39)}`)
    expect(labelOf('x'.repeat(40))).toBe(`workflow ${'x'.repeat(38)}…`)
    expect(labelOf(`${'x'.repeat(37)} yyy`)).toBe(`workflow ${'x'.repeat(37)}…`)
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

  // 15 s: normal 0.7 s (load 2-4), 5.2 s at load 70-84
  test('a fresh session reads n/a for BG at every width, and says why in /progress', { timeoutMs: 15_000 }, async ($, on) => {
    await boot($, on, w => (w.now = T0))
    for (const { columns } of WIDTHS) {
      const body = await bgBody($, columns)
      expect(squash(body.join(''))).toBe(squash(`NOWidleBG n/a（還沒有回合結束的快照）${PERM_TEXT}`))
    }
    expect((await $.command.run(PROGRESS)).text).toBe(['NOW  idle', 'BG   n/a（還沒有回合結束的快照）', PERM_TEXT].join('\n'))
  })

  for (const { columns, tier } of WIDTHS) {
    // load 68 in the whole-suite run: 3.8 s (5 s limit); 15 s here, the assertions are unchanged
    test(`${tier} (bodyColumns ${columns}): a background shell started this turn waits from its call, and is gone when its notification comes`, { timeoutMs: 15_000 }, async ($, on) => {
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
    test(`a background call that ends as ${mode} leaves nothing that dates the item: a fresh shell at the Stop is only a lower bound`, async ($, on) => {
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

  // a call of the fake machine at `at`, and the Stop at `at` with what /progress then says
  type Eng = Parameters<typeof paneView>[0]
  type Booted = Awaited<ReturnType<typeof boot>>
  const launch = async ($: Eng, b: Booted, at: number, input: Record<string, unknown>, result: unknown = {}) => {
    b.world.now = at
    b.world.toolResult = () => ({ result })
    await $.tool.call(input as never)
  }
  const stopSays = async ($: Eng, b: Booted, at: number, tasks: Record<string, unknown>[], crons: Record<string, unknown>[] = []) => {
    b.world.now = at
    await $.classic.Stop({ stop_hook_active: false, background_tasks: tasks, session_crons: crons } as never)
    await b.clock.settle()
    return (await $.command.run(PROGRESS)).text
  }
  const agent = (id: string) => bt({ id, type: 'subagent', agent_type: 'Explore', command: undefined })

  test('a main shell that ended and a shell a subagent started: the one shell the Stop lists is not dated by the main call', async ($, on) => {
    const b = await boot($, on, w => (w.now = T0))
    await launch($, b, T0, { tool: 'Bash', command: 'a', run_in_background: true })
    await launch($, b, T0 + 30_000, { tool: 'Bash', command: 'b', run_in_background: true, agentId: 'a1' })
    expect(await stopSays($, b, T0 + 60_000, [bt()])).toContain('BG   ≥shell 0s')
  })

  test('the same with the ids the results name: the Stop lists the subagent shell and its own call dates it', async ($, on) => {
    const b = await boot($, on, w => (w.now = T0))
    await launch($, b, T0, { tool: 'Bash', command: 'a', run_in_background: true }, { backgroundTaskId: 'm1' })
    await launch($, b, T0 + 30_000, { tool: 'Bash', command: 'b', run_in_background: true, agentId: 'a1' }, { backgroundTaskId: 'sub1' })
    expect(await stopSays($, b, T0 + 60_000, [bt({ id: 'sub1' })])).toContain('BG   shell 30s')
  })

  test('a main wakeup that has fired and a cron a subagent created: the cron is a lower bound without an id, dated by it with one', async ($, on) => {
    const b = await boot($, on, w => (w.now = T0))
    await launch($, b, T0, { tool: 'ScheduleWakeup', delaySeconds: 60 }, { scheduledFor: T0 + 60_000, clampedDelaySeconds: 60, wasClamped: false })
    await launch($, b, T0 + 45_000, { tool: 'CronCreate', cron: '*/5 * * * *', agentId: 'a1' }, { humanSchedule: 'every 5 minutes', recurring: true, durable: false })
    expect(await stopSays($, b, T0 + 90_000, [], [cron({ id: 'c9' })])).toContain('BG   ≥cron 0s')
  })

  test('the same cron, its result naming the id: it waited since the subagent call', async ($, on) => {
    const b = await boot($, on, w => (w.now = T0))
    await launch($, b, T0, { tool: 'ScheduleWakeup', delaySeconds: 60 }, { scheduledFor: T0 + 60_000, clampedDelaySeconds: 60, wasClamped: false })
    await launch($, b, T0 + 45_000, { tool: 'CronCreate', cron: '*/5 * * * *', agentId: 'a1' }, { id: 'c9', humanSchedule: 'every 5 minutes', recurring: true, durable: false })
    expect(await stopSays($, b, T0 + 90_000, [], [cron({ id: 'c9' })])).toContain('BG   cron 45s')
  })

  test('a main agent with the flag that ended and one without it still running: the engine runs both in the background, so the wait is a lower bound', async ($, on) => {
    const b = await boot($, on, w => (w.now = T0))
    await launch($, b, T0, { tool: 'Agent', subagent_type: 'Explore', prompt: 'a', run_in_background: true })
    await launch($, b, T0 + 20_000, { tool: 'Agent', subagent_type: 'Explore', prompt: 'b' })
    expect(await stopSays($, b, T0 + 50_000, [agent('x1')])).toContain('BG   ≥agent Explore 0s')
  })

  test('the same agents with the ids their results name: the one listed waited since its own call', async ($, on) => {
    const b = await boot($, on, w => (w.now = T0))
    await launch($, b, T0, { tool: 'Agent', subagent_type: 'Explore', prompt: 'a', run_in_background: true }, { status: 'async_launched', agentId: 'agent-a' })
    await launch($, b, T0 + 20_000, { tool: 'Agent', subagent_type: 'Explore', prompt: 'b' }, { status: 'async_launched', agentId: 'agent-b' })
    expect(await stopSays($, b, T0 + 50_000, [agent('agent-b')])).toContain('BG   agent Explore 30s')
  })

  test('a shell moved to the background by hand (no flag on the call) is dated by the id its result names', async ($, on) => {
    const b = await boot($, on, w => (w.now = T0))
    await launch($, b, T0, { tool: 'Bash', command: 'sleep 600' }, { stdout: '', backgroundTaskId: 'b7', backgroundedByUser: true })
    expect(await stopSays($, b, T0 + 40_000, [bt({ id: 'b7' })])).toContain('BG   shell 40s')
  })

  test('a ScheduleWakeup that only cancels (stop: true) leaves no start', async ($, on) => {
    const b = await boot($, on, w => (w.now = T0))
    await launch($, b, T0, { tool: 'ScheduleWakeup', stop: true }, { stopped: true, cancelledWakeups: 0 })
    expect(await stopSays($, b, T0 + 60_000, [], [cron()])).toContain('BG   ≥cron 0s')
  })

  test('a ScheduleWakeup without stop dates the cron it leaves', async ($, on) => {
    const b = await boot($, on, w => (w.now = T0))
    await launch($, b, T0, { tool: 'ScheduleWakeup', delaySeconds: 60 }, { scheduledFor: T0 + 60_000, clampedDelaySeconds: 60, wasClamped: false })
    expect(await stopSays($, b, T0 + 60_000, [], [cron({ recurring: false })])).toContain('BG   wakeup 1m00s')
  })

  test('a task listed before its call returned is dated at the next Stop by the key that arrived late', async ($, on) => {
    const b = await boot($, on, w => (w.now = T0))
    const gate = deferred()
    b.world.toolResult = () => gate.promise.then(() => ({ result: { backgroundTaskId: 'b1' } }))
    const held = $.tool.call({ tool: 'Bash', command: 'x', run_in_background: true, agentId: 'a1' } as never)
    // the call is dated once it is held inside the engine
    await b.clock.settle()
    expect(await stopSays($, b, T0 + 10_000, [bt()])).toContain('BG   ≥shell 0s')
    gate.release()
    await held
    expect(await stopSays($, b, T0 + 60_000, [bt()])).toContain('BG   shell 1m00s')
  })

  // 15 s: normal 0.7 s (load 2-4), 4.5 s at load 70-84
  test('63 keyed starts and an open one after a veto push the veto out: the cut start list gives up the count rule', { timeoutMs: 15_000 }, async ($, on) => {
    const b = await boot($, on, w => (w.now = T0))
    await launch($, b, T0, { tool: 'Bash', command: 'sub', run_in_background: true, agentId: 'a1' })
    let n = 0
    b.world.toolResult = () => ({ result: { id: `k${n++}` } })
    for (let i = 0; i < 63; i++) await $.tool.call({ tool: 'CronCreate', cron: '* * * * *' } as never)
    await launch($, b, T0 + 30_000, { tool: 'Bash', command: 'main', run_in_background: true })
    expect(await stopSays($, b, T0 + 60_000, [bt()])).toContain('BG   ≥shell 0s')
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
    expect((await $.command.run(PROGRESS)).text).toContain('BG   ≥shell 0s\n     snapshot 0s ago')
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

  test('a notification of another session starts the hidden ids over: the first session\'s are gone when it draws again', async ($, on) => {
    const { world, clock } = await boot($, on, w => (w.now = T0))
    const note = async (id: string) => {
      const m = await $.ui.mount({ plugin: 'status-pane', surface: 'terminal', component: 'UserMessage', props: NOTE(id) })
      await m.drawn()
      await m.unmount()
    }
    const sid = world.session.id
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [bt(), bt({ id: 'b2' })], session_crons: [] })
    world.session.id = 'S2-other'
    await note('b2')
    world.session.id = sid
    await note('b1')
    await clock.settle()
    expect((await $.command.run(PROGRESS)).text).toContain('BG   ≥shell 0s\n     snapshot 0s ago')
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
