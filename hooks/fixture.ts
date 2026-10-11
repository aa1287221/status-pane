// Test-only helpers: a ready snapshot, and (below it) a fake machine for the engine-bound tests.
// register.tsx never imports this file, so the engine never loads it.

import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type {
  FsEntry,
  On,
  PaneOpenArgs,
  ProcessRunResult,
  RenderSurface,
  SessionUsage,
  UiOpenResult,
} from 'claude-code'

import { dw } from './model'
import { cardTitled, paneParts, renderTree } from './tree'
import type { CardView, PaneParts } from './tree'
import type { Snap } from './state'

/** A label at the left edge of a row `inner` cells wide and its value against the right edge. */
export const pair = (label: string, value: string, inner: number): string => label + ' '.repeat(inner - dw(label) - dw(value)) + value

/** A value against the right edge of a row `inner` cells wide. */
export const right = (value: string, inner: number): string => ' '.repeat(inner - dw(value)) + value

const two = (n: number) => String(n).padStart(2, '0')

/** The clock `sec` seconds after `startMs` on this machine: HH:MM, with the weekday on another day or when `always`. Read off Date and Intl, not off the pane's code. */
export const clockAfter = (startMs: number, sec: number, always: boolean): string => {
  const end = new Date(startMs + sec * 1000)
  const hm = `${two(end.getHours())}:${two(end.getMinutes())}`
  return always || end.toDateString() !== new Date(startMs).toDateString() ? `${end.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}` : hm
}

/** The `resets` line of a card `inner` cells wide: the countdown and the clock on one row, else the clock under it, against the right edge. */
export const resetsLines = (countdown: string, clock: string, inner: number): string[] =>
  dw('resets') + 2 + dw(countdown) + 3 + dw(clock) <= inner
    ? [pair('resets', `${countdown} · ${clock}`, inner)]
    : [pair('resets', countdown, inner), right(clock, inner)]

/** 2026-10-09 02:41:13 UTC, the instant the SPEC mockup stamps. */
export const MOCKUP_AT = Date.UTC(2026, 9, 9, 2, 41, 13)

const ok = <T>(v: T) => ({ ok: true as const, v })

/** The settings.json entry for one of the tracker scripts, as the real file spells it. */
export const trackerCommand = (script: string) => ({ type: 'command', command: `bash -c 'node ~/.claude/scripts/hooks/${script}'` })

/** `hooks` of a settings that wires every tracker the pane reads (and the effort tracker, which it does not). */
export const trackerHooks = (): Record<string, unknown> => ({
  UserPromptSubmit: [
    { hooks: [trackerCommand('effort-tracker.js')] },
    { hooks: [trackerCommand('message-tracker.js')] },
    { hooks: [trackerCommand('summary-updater.js')] },
  ],
  Stop: [{ hooks: [trackerCommand('message-tracker.js')] }],
  SubagentStart: [{ hooks: [trackerCommand('subagent-tracker.js')] }],
  SubagentStop: [{ hooks: [trackerCommand('subagent-tracker.js')] }],
  PreCompact: [{ hooks: [trackerCommand('compact-monitor.js')] }],
  PostToolUse: [{ matcher: 'Write|Edit', hooks: [trackerCommand('file-tracker.js')] }],
})

/** The snapshot behind the SPEC's 89-column mockup; `over` replaces whole fields. */
export const makeSnap = (over: Partial<Snap> = {}): Snap => ({
  at: MOCKUP_AT,
  errors: 0,
  toggles: {
    enabled: true,
    rows: {
      summary: true,
      dir: true,
      repo: true,
      model: true,
      cost: true,
      usage: true,
      quota: true,
      agents: true,
      memory_mcp: true,
      sys: true,
      edited: true,
      history: true,
      progress: true,
      fixture: false,
    },
  },
  summary: ok('遷移 statusline 到 mod pane 的討論與實作'),
  dir: ok('~/project'),
  git: ok({ branch: 'main', repo: 'wky-org/example', status: ok({ added: 1, modified: 3, untracked: 2 }) }),
  lines: ok({ add: 120, rm: 45 }),
  model: ok({ name: 'Opus 5.5', version: '2.1.294', effort: 'max' }),
  cost: ok({ all: 12.34, session: 3.2, durMin: 80 }),
  agents: ok([
    { name: 'general-purpose', running: 1, done: 0, latest: 0 },
    { name: 'Explore', running: 0, done: 3, latest: MOCKUP_AT - 5 * 60_000 },
  ]),
  context: ok({ pct: 3, used: 32_000, max: 1_000_000, compacts: ok(0) }),
  tokens: ok({ all: 1_200_000, session: 230_000 }),
  quota: ok({
    five: { pct: 23, resetSec: 2 * 3600 + 10 * 60 },
    seven: { pct: 61, resetSec: 3 * 86_400 + 4 * 3600 },
  }),
  cpu: ok(12),
  ram: ok({ usedKb: 7_384_000, totalKb: 16_384_000, pct: 45 }),
  memory: ok(['global', 'project', '3 rules']),
  mcp: ok({ total: 6, healthy: 5, bad: [{ name: 'notion', isAuth: false }] }),
  edited: ok(['register.tsx', 'SPEC.md', 'settings.json']),
  hooks: { agents: true, edited: true, summary: true, messages: true, compact: true },
  ...over,
})

// ---- a fake machine beneath the plugin ----

export type Proc = Partial<ProcessRunResult> | Error

/** What the engine would hold: files, env, session facts, command output. Tests edit it, then drive events. */
export type World = {
  /** Read by `clock.now`; the mock clock only paces the timers. */
  now: number
  files: Map<string, string>
  env: Record<string, string>
  session: { id: string; cwd: string; model: string; version: string }
  usage: SessionUsage | Error
  /** The merged settings `$.settings.read()` answers. */
  settings: Record<string, unknown>
  /** What `$.settings.read({ source })` answers for a source; `{}` for one with no entry. */
  settingsBySource: Record<string, Record<string, unknown>>
  /** Makes `$.settings.read()` refuse. */
  denySettings: boolean
  procs: Map<string, Proc | ((argv: readonly string[]) => Proc)>
  openResult: UiOpenResult
  denyRead: Set<string>
  denyWrite: Set<string>
  /** Directories whose listing is refused. */
  denyList: Set<string>
  /** Makes every `mv` exit 1, so the atomic write has to fall back. */
  denyMv: boolean
  /** Makes the `mv` onto these paths exit 1. */
  denyMvFor: Set<string>
  /** Environment variables whose reads are refused. */
  denyEnv: Set<string>
  /** Makes the next this-many `clock.now` calls refuse. */
  denyNow: number
  /** Holds the first `clock.now` that comes once the usage has been asked `after` times. */
  nowGate: { after: number; promise: Promise<void> } | null
  /** `$.state` keys of the plugin whose writes are refused. */
  denyState: Set<string>
  /** `$.state` keys of the plugin whose reads are refused. */
  denyGet: Set<string>
  /** A value the next `state.get` of a key answers instead of what stands there (the version stays real). */
  readOnce: Map<string, unknown>
  /**
   * Calls that wait for a test to release them, one release per call: `fs.list:<dir>`, `fs.read:<path>`,
   * `fs.write:<path>` (the file or its `.tmp` siblings), `state.get:<key>` (held before it answers) or
   * `state.set:<key>` (held after the write landed).
   */
  stalls: Map<string, Promise<void>[]>
  /** Milliseconds of mock time a command takes to answer, by `process.run:<argv>`. */
  delay: Map<string, number>
  /** Calls that never answer, to prove nothing waits on them: an event name, or `process.run:<argv>`. */
  hang: Set<string>
  /** What `tool.call` answers beneath the plugin. */
  toolResult: () => unknown
  /** Called after a write is stored; a test uses it to play a competing writer. */
  onWrite: ((path: string, text: string) => void) | null
  /** Recorders. */
  usageCalls: number
  settingsCalls: number
  /** The events `$.ui.invalidate` was asked for. */
  invalidated: string[]
  /** The `$.state` keys of the plugin, one entry per write that landed. */
  stateSets: string[]
  /** The last value written under each of those keys. */
  stateValues: Map<string, unknown>
  reads: string[]
  opened: PaneOpenArgs[]
  registered: string[]
  /** The whole spec of each `command.register`, in order. */
  commandSpecs: Record<string, unknown>[]
  writes: { path: string; text: string }[]
  /** Every `mv` the plugin ran that moved something. */
  moves: { from: string; to: string }[]
  ran: { argv: string[]; cwd: string | undefined; env: Record<string, string> | undefined }[]
  armed: number[]
}

/** What a test compares of a pane: the cards by title (the header apart) and the lines under them. */
export type PaneSummary = { cards: Record<string, { value: string; body: string[] }>; footer: string[] }

/** PROGRESS is left out: it changes with every tool call and has its own suite, `progress.test.ts`. */
export const summarize = (parts: PaneParts): PaneSummary => ({
  cards: Object.fromEntries(parts.cards.filter(c => c.title !== '' && c.title !== 'PROGRESS').map(c => [c.title, { value: c.value, body: c.body }])),
  footer: parts.footer,
})

/** `cards` without the named ones. */
export const without = (cards: PaneSummary['cards'], ...titles: string[]): PaneSummary['cards'] =>
  Object.fromEntries(Object.entries(cards).filter(([title]) => !titles.includes(title)))

/** The card with this title, or a card of nothing. */
export const cardOf = (parts: PaneParts, title: string): CardView =>
  cardTitled(parts, title) ?? { title, value: '', width: 0, raw: [], body: [], node: { type: 'Box' } }

/** The header card: the model and the liveness, then the summary. */
export const headerOf = (parts: PaneParts): CardView => parts.cards[0] ?? cardOf(parts, '')

/** The pane of a healthy `makeWorld()` after its first refresh at 89 columns (wide), as `summarize` reads it. */
export const WORLD_89: PaneSummary = {
  cards: {
    CONTEXT: { value: '3%', body: [`▊${'░'.repeat(24)}`, pair('used', '32.0K / 1.0M', 25), pair('compact', '2', 25)] },
    '5H': { value: '23%', body: [`█████▌${'░'.repeat(18)}`, ...resetsLines('2h 10m', clockAfter(MOCKUP_AT, 7800, false), 24)] },
    '7D': { value: '61%', body: [`${'█'.repeat(14)}▋${'░'.repeat(9)}`, ...resetsLines('3d 4h', clockAfter(MOCKUP_AT, 3 * 86_400 + 4 * 3600, true), 24)] },
    COST: {
      value: 'session   total',
      body: ['─'.repeat(25), `$${' '.repeat(9)}   3.50   10.25`, `tokens${' '.repeat(4)} 32.0K≈  33.5K≈`],
    },
    GIT: {
      value: '',
      body: [pair('branch', 'main', 24), pair('dir', '~/project', 24), pair('lines', '+200 −4 ≈', 24), pair('state', '✗ +1 ~3 ?2', 24)],
    },
    ACTIVITY: {
      value: '',
      body: [
        pair('in-flight', '0 · 1 stale', 24),
        pair('agents', 'general-purp ○', 24),
        right('Explore ✓×2', 24),
        right('5m ago', 24),
        pair('edited', 'register.tsx →', 24),
        right('SPEC.md →', 24),
        right('settings.json', 24),
      ],
    },
    SYSTEM: {
      value: '',
      body: [pair('cpu', '—', 83), pair('ram', '45%  7.0/15.6G', 83), pair('mcp', '2/3  figma ✗', 83), pair('memory', 'global · project · 3 rules', 83)],
    },
  },
  footer: [],
}

/** The header at 89 columns: the model row with the liveness at its right edge, then the summary and the session length. */
export const HEADER_89_MODEL = /^Opus 5\.5 · max · v2\.1\.294 +mcp ✗(?:  \d+ errors?)? +● \d\d:\d\d$/
export const HEADER_89_DETAIL = '遷移 statusline 到 mod pane 的討論與實作 · 1hr 20min'

/** The same at 49 columns (medium): the full matrix needs 23 cells here and COST can have 22, so it reads sess and tok; GIT keeps 18. */
export const WORLD_49: PaneSummary = {
  cards: {
    CONTEXT: { value: '3%', body: [`█▎${'░'.repeat(41)}`, pair('used 32.0K / 1.0M', 'compact 2', 43)] },
    '5H': { value: '23%', body: [`████▍${'░'.repeat(14)}`, ...resetsLines('2h10m', clockAfter(MOCKUP_AT, 7800, false), 19)] },
    '7D': { value: '61%', body: [`${'█'.repeat(11)}▋${'░'.repeat(7)}`, ...resetsLines('3d4h', clockAfter(MOCKUP_AT, 3 * 86_400 + 4 * 3600, true), 19)] },
    COST: {
      value: 'sess   total',
      body: ['─'.repeat(20), `$${' '.repeat(7)}3.50${' '.repeat(3)}10.25`, `tok${' '.repeat(3)}32.0K≈  33.5K≈`],
    },
    GIT: {
      value: '',
      body: [pair('branch', 'main', 18), pair('dir', '~/project', 18), pair('lines', '+200 −4 ≈', 18), pair('state', '✗ +1 ~3 ?2', 18)],
    },
    ACTIVITY: {
      value: '',
      body: [pair('in-flight', '0 · 1 stale', 43), pair('agents', 'general-purp ○', 43), right('Explore ✓×2 5m ago', 43), pair('edited', 'register.tsx → SPEC.md →', 43), right('settings.json', 43)],
    },
    SYSTEM: {
      value: '',
      body: [pair('cpu', '—', 43), pair('ram', '45%  7.0/15.6G', 43), pair('mcp', '2/3  figma ✗', 43), pair('memory', 'global · project · 3 rules', 43)],
    },
  },
  footer: [],
}

export const SESSION_ID = 'c07353bf-22c4-47df-8296-6f2dd4b68497'
export const SID = 'c07353bf22c447df82966f2d'
export const CWD = '/root/project'
export const NOW_SEC = Math.floor(MOCKUP_AT / 1000)

const iso = (sec: number) => new Date(sec * 1000).toISOString()

/** A healthy session: every row of the SPEC mockup has data, nothing is on disk that should not be. */
export const makeWorld = (): World => {
  const files = new Map<string, string>()
  const put = (path: string, text: string) => files.set(path, text)
  put('/root/.claude/CLAUDE.md', '# global')
  put(`${CWD}/CLAUDE.md`, '# project')
  for (const f of ['a.md', 'b.md', 'c.md', 'notes.txt']) put(`${CWD}/.claude/rules/${f}`, 'r')
  put(
    '/root/.claude/mcp-status-cache.json',
    JSON.stringify({
      updated: 1,
      servers: {
        'claude.ai Notion': { status: 'connected' },
        'claude.ai Docs': { status: 'connected' },
        'plugin:figma:figma': { status: 'failed' },
      },
    }),
  )
  put('/root/.claude/hooks/mcp-status-refresh.js', '// refresher')
  put(`/tmp/claude-cum-${SID}.json`, '{"cost":{"total":2,"base":2},"dur":{"total":0,"base":0},"add":{"total":200,"base":200},"rm":{"total":4,"base":4},"tok":{"total":10000,"base":10000}}')
  put('/tmp/claude-cum-othersession0000000001.json', '{"cost":{"total":6.25,"base":6.25},"tok":{"total":1000,"base":1000}}')
  put('/tmp/claude-cum-othersession0000000002.json', '{"cost":{"total":0.5,"base":0.5},"tok":{"total":500,"base":500}}')
  put(`/tmp/claude-summary-${SID}.txt`, '遷移 statusline 到 mod pane 的討論與實作\nsecond line')
  put(`/tmp/claude-files-${SID}.json`, JSON.stringify(['register.tsx', 'SPEC.md', 'settings.json']))
  put(`/tmp/claude-compacts-${SID}.json`, '{"count":2,"last":1}')
  put(
    `/tmp/claude-agents-${SID}.json`,
    JSON.stringify({
      a1: { name: 'Explore', status: 'done', started: 1, finished: MOCKUP_AT - 5 * 60_000 },
      a2: { name: 'Explore', status: 'done', started: 2, finished: MOCKUP_AT - 10 * 60_000 },
      a3: { name: 'general-purpose', status: 'running', started: 3 },
    }),
  )
  put('/proc/stat', 'cpu  100 0 50 800 10 0 5 0 0 0\ncpu0 1 1 1 1 1 1 1 0 0 0\n')
  put('/proc/meminfo', 'MemTotal:       16384000 kB\nMemFree:         1024000 kB\nMemAvailable:    9000000 kB\n')
  // global and stale on purpose: the plugin must not read it (L2)
  put('/root/.claude/effort-current.txt', 'low\n')

  const git = (out: string, exitCode = 0): Proc => ({ exitCode, stdout: out, stderr: '' })
  const procs = new Map<string, Proc>([
    ['git rev-parse --abbrev-ref HEAD', git('main\n')],
    ['git status --porcelain', git('A  new.ts\n M a.ts\n M b.ts\n M c.ts\n?? x\n?? y\n')],
    ['git remote get-url origin', git('git@github.com:wky-org/example.git\n')],
    ['git rev-parse --show-toplevel', git(`${CWD}\n`)],
    ['node /root/.claude/hooks/mcp-status-refresh.js', git('')],
  ])

  return {
    now: MOCKUP_AT,
    files,
    env: { HOME: '/root', CLAUDE_EFFORT: 'max' },
    session: { id: SESSION_ID, cwd: CWD, model: 'claude-opus-5-5', version: '2.1.294' },
    settings: { hooks: trackerHooks() },
    settingsBySource: {},
    denySettings: false,
    usage: {
      startedAt: MOCKUP_AT - 80 * 60_000,
      context: { tokens: 32_000, window: 1_000_000, percent: 3 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: iso(NOW_SEC + 7800) },
        { kind: 'seven_day', percentUsed: 61, resetsAt: iso(NOW_SEC + 3 * 86_400 + 4 * 3600) },
      ],
      cost: { usd: 3.5 },
    },
    procs,
    openResult: { isPlaced: true },
    denyRead: new Set(),
    denyWrite: new Set(),
    denyList: new Set(),
    denyMv: false,
    denyMvFor: new Set(),
    denyEnv: new Set(),
    denyNow: 0,
    nowGate: null,
    denyState: new Set(),
    denyGet: new Set(),
    readOnce: new Map(),
    stalls: new Map(),
    delay: new Map(),
    hang: new Set(),
    toolResult: () => ({ result: { ok: true } }),
    onWrite: null,
    usageCalls: 0,
    settingsCalls: 0,
    invalidated: [],
    stateSets: [],
    stateValues: new Map(),
    reads: [],
    opened: [],
    registered: [],
    commandSpecs: [],
    writes: [],
    moves: [],
    ran: [],
    armed: [],
  }
}

const STEP_MS = 1000

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'

/**
 * Registers the bottom of every `$` call the plugin makes, from `world`. Must run before the test's
 * first call on `$`. Returns the mock clock that paces the plugin's timers.
 */
export const installWorld = (on: On, world: World): { clock: MockClock; advance: (ms: number) => Promise<void> } => {
  // `now` comes from the world, so a test can age the data without firing the timers; the mock clock
  // beneath only paces them. `every` is counted per arm (and per period the mock clock re-asks).
  on('clock.*', async (_$, e, next) => {
    if (next.event === 'clock.now') {
      if (world.denyNow > 0) {
        world.denyNow -= 1
        return { deny: 'clock unavailable' } as never
      }
      if (world.hang.has('clock.now')) return new Promise<never>(() => {}) as never
      const gate = world.nowGate
      if (gate && world.usageCalls >= gate.after) {
        world.nowGate = null
        await gate.promise
      }
      return { value: world.now } as never
    }
    if (next.event === 'clock.every') {
      world.armed.push((e as { ms: number }).ms)
      // a timer that never fires, as when the hooks worker was replaced
      if (world.hang.has('clock.every')) return new Promise<never>(() => {}) as never
    }
    return next(e as never) as never
  })
  const clock = mock.clock(on, { now: world.now })
  on('env.get', (_$, e) => (world.denyEnv.has(e.name) ? { deny: `env ${e.name} refused` } : { value: world.env[e.name] }))
  on('ui.invalidate', (_$, e, next) => {
    world.invalidated.push(e.event)
    return next(e)
  })

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: world.session.id }))
  on('session.cwd', () => ({ value: world.session.cwd }))
  on('session.model', () => ({ value: world.session.model }))
  on('session.version', () => ({ value: { version: world.session.version } }))
  on('session.usage', () => {
    world.usageCalls += 1
    if (world.hang.has('session.usage')) return new Promise<never>(() => {})
    return world.usage instanceof Error ? { deny: world.usage.message } : { value: world.usage }
  })
  on('settings.read', (_$, e) => {
    world.settingsCalls += 1
    if (world.hang.has('settings.read')) return new Promise<never>(() => {})
    if (world.denySettings) return { deny: 'settings refused' }
    return { value: e.source ? (world.settingsBySource[e.source] ?? {}) : world.settings }
  })
  on('command.register', (_$, e) => {
    world.registered.push(e.name)
    world.commandSpecs.push({ ...e })
    return { value: { command: e.name } }
  })
  on('ui.open', (_$, e) => {
    world.opened.push(e)
    return { value: world.openResult }
  })

  on('fs.exists', (_$, e) => ({
    value: world.files.has(e.path) || [...world.files.keys()].some(k => k.startsWith(`${e.path}/`)),
  }))
  on('fs.stat', (_$, e) => {
    const text = world.files.get(e.path)
    if (text === undefined) return { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
    return { value: { kind: 'file', size: new TextEncoder().encode(text).length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', async (_$, e) => {
    world.reads.push(e.path)
    const gate = world.stalls.get(`fs.read:${e.path}`)?.shift()
    if (gate) await gate
    if (world.denyRead.has(e.path)) return { deny: `EACCES: permission denied, open '${e.path}'` }
    const text = world.files.get(e.path)
    if (text === undefined) return { deny: `ENOENT: no such file or directory, open '${e.path}'` }
    if (e.as === 'bytes') return { value: { base64: btoa(unescape(encodeURIComponent(text))) } }
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    const gate = stallGate(world, 'fs.write:', e.path)
    if (gate) await gate
    // a refused file refuses its `<file>.<id>.tmp` siblings too
    if ([...world.denyWrite].some(d => e.path === d || e.path.startsWith(`${d}.`))) {
      return { deny: `EACCES: permission denied, open '${e.path}'` }
    }
    world.files.set(e.path, e.text)
    world.writes.push({ path: e.path, text: e.text })
    world.onWrite?.(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    const gate = world.stalls.get(`fs.list:${e.path.replace(/\/+$/, '')}`)?.shift()
    if (gate) await gate
    if (world.denyList.has(e.path)) return { deny: `EACCES: permission denied, scandir '${e.path}'` }
    const dir = e.path.replace(/\/+$/, '')
    const entries: FsEntry[] = []
    for (const path of world.files.keys()) {
      if (dirOf(path) === dir) {
        entries.push({ name: path.slice(dir.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })
      }
    }
    return { value: entries }
  })
  on('process.run', async (_$, e) => {
    world.ran.push({ argv: [...e.argv], cwd: e.init?.cwd, env: e.init?.env })
    if (world.hang.has(`process.run:${e.argv.join(' ')}`)) return new Promise<never>(() => {})
    const wait = world.delay.get(`process.run:${e.argv.join(' ')}`)
    if (wait) await clock.sleep(wait)
    const done = (exitCode: number, stderr = '') => ({
      value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'mv') {
      const [, , from = '', to = ''] = e.argv
      const text = world.files.get(from)
      if (world.denyMv || world.denyMvFor.has(to) || text === undefined) return done(1, `mv: cannot move '${from}': Permission denied\n`)
      world.files.delete(from)
      world.files.set(to, text)
      world.moves.push({ from, to })
      world.onWrite?.(to, text)
      return done(0)
    }
    if (e.argv[0] === 'rm') {
      for (const f of e.argv.slice(2)) world.files.delete(f)
      return done(0)
    }
    const proc = world.procs.get(e.argv.join(' '))
    const out = typeof proc === 'function' ? proc(e.argv) : proc
    if (out === undefined) return { deny: `no fake for: ${e.argv.join(' ')}` }
    if (out instanceof Error) return { deny: out.message }
    return {
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...out },
    }
  })

  on('state.get', async (_$, e, next) => {
    if (world.denyGet.has(e.key)) return { deny: 'state read refused' } as never
    const gate = world.stalls.get(`state.get:${e.key}`)?.shift()
    if (gate) await gate
    const read = await next(e)
    if (!world.readOnce.has(e.key)) return read
    // the answer is `{ value: { value, version } }`: only the stored value is replaced
    const value = world.readOnce.get(e.key)
    world.readOnce.delete(e.key)
    return { ...read, value: { ...(read as { value?: object }).value, value } } as never
  })

  on('state.set', async (_$, e, next) => {
    if (world.denyState.has(e.key)) return { deny: 'state write refused' } as never
    const landed = await next(e)
    world.stateSets.push(e.key)
    world.stateValues.set(e.key, e.value)
    const gate = world.stalls.get(`state.set:${e.key}`)?.shift()
    if (gate) await gate
    return landed
  })

  on('turn.complete', () => ({ text: '' }))
  on('classic.PostToolUse', () => ({}))
  on('classic.Stop', () => ({}))
  on('classic.SubagentStop', () => ({}))
  on('tool.call', () => world.toolResult() as never)
  on('ui.render', { component: 'UserMessage' }, (_$, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  on('ui.render', { component: 'PromptHint' }, (_$, e) => ({
    type: 'Text',
    props: {},
    children: [`${e.props.hint}|${e.props.tail ?? ''}`],
  }))

  return {
    clock,
    // in one-second steps, so `now` is what it should be when a timer falls due on the way
    advance: async ms => {
      for (let left = ms; left > 0; left -= STEP_MS) {
        const step = Math.min(STEP_MS, left)
        world.now += step
        await clock.advance(step)
      }
    },
  }
}

/** The next release gate queued for `<kind><path>`, matching the file itself and its `<file>.<id>.tmp` siblings. */
const stallGate = (world: World, kind: string, path: string): Promise<void> | undefined => {
  for (const [key, queue] of world.stalls) {
    if (!key.startsWith(kind)) continue
    const target = key.slice(kind.length)
    if (path !== target && !path.startsWith(`${target}.`)) continue
    const gate = queue.shift()
    if (gate) return gate
  }
  return undefined
}

/** A promise a test settles by hand, to hold a call of the fake machine until it says so. */
export const deferred = () => {
  let release: () => void = () => {}
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}

/** Holds the next call of `key` (see `World.stalls`) until the returned function releases it. */
export const stallNext = (world: World, key: string): (() => void) => {
  const hold = deferred()
  world.stalls.set(key, [...(world.stalls.get(key) ?? []), hold.promise])
  return hold.release
}

/** A room as tall as the pane needs unless a test says otherwise. */
export const TALL = 200

const PANE_PROPS = (bodyColumns: number, bodyRows: number) =>
  ({
    title: 'Status',
    isFocused: false,
    bodyColumns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows },
    view: {},
  }) as const

export const START = { cwd: CWD, surface: 'terminal', isInteractive: true } as const

/** Mounts the pane the way a surface does. */
export const mountPane = ($: Engine, columns = 89, surface: RenderSurface = 'terminal', rows = TALL) =>
  $.ui.mount({
    plugin: 'status-pane',
    surface,
    component: 'Pane',
    requestId: 'status-pane',
    props: PANE_PROPS(columns, rows),
    viewport: { columns: 200, rows: 50, isFullscreen: true },
  })

/** The pane as a terminal would lay it out, line by line, borders and footer included. */
export const paneText = async ($: Engine, columns = 89, surface: RenderSurface = 'terminal', rows = TALL): Promise<string[]> => {
  const ui = await mountPane($, columns, surface, rows)
  const lines = renderTree(await ui.drawn(), columns)
  await ui.unmount()
  return lines
}

/** The CPU readings the plugin last wrote for the chart, oldest first. */
export const cpuHistory = (world: World): number[] => (world.stateValues.get('cpuHist') as number[] | undefined) ?? []

/** The pane taken apart: its cards by title, and the lines under them. */
export const paneView = async ($: Engine, columns = 89, surface: RenderSurface = 'terminal', rows = TALL): Promise<PaneParts> => {
  const ui = await mountPane($, columns, surface, rows)
  const parts = paneParts(await ui.drawn(), columns)
  await ui.unmount()
  return parts
}

/** The PromptHint the engine would draw, as the fake engine bottom shows it: `hint|tail`. */
export const hintText = async ($: Engine, tail?: string): Promise<string | undefined> => {
  const ui = await $.ui.mount({
    plugin: 'status-pane',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts', ...(tail ? { tail } : {}) },
  })
  const text = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return text
}

export const TURN_DONE = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

export const EDIT_CALL = { tool: 'Edit', file_path: '/root/project/a.ts', old_string: 'a', new_string: 'b' } as const

/** An Edit result as the engine records it: `lines` are the hunk's diff lines. */
export const editResult = (lines: string[]) => ({
  result: {
    filePath: '/root/project/a.ts',
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }],
  },
})

/** A world with the plugin started and its first refresh done. */
export const boot = async ($: Engine, on: On, edit: (w: World) => void = () => {}) => {
  const world = makeWorld()
  edit(world)
  const io = installWorld(on, world)
  await $.session.start(START)
  await io.clock.settle()
  return { world, ...io }
}

/** Replaces fields of the usage the fake session reports. */
export const setUsage = (world: World, patch: Partial<SessionUsage>): void => {
  if (world.usage instanceof Error) throw world.usage
  world.usage = { ...world.usage, ...patch }
}
