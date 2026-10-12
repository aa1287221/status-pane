// Collectors read and write only through `Io`: `$` cannot cross an import, so register.tsx builds it.
// Each runs under guard(), so a throw or a stall costs only its own row.

import type { ProcessRunInit, ProcessRunResult, SessionUsage, Settings, SettingsSource } from 'claude-code'

import {
  ALL_CONFIGURED,
  HOOK_SCRIPTS,
  aggMaxOrNull,
  allTotals,
  configuredEffort,
  countdownSec,
  countGitStatus,
  cpuPercent,
  cumJson,
  emptyCum,
  groupAgents,
  hooksConfigured,
  mcpInfo,
  mergeSnap,
  modelLabel,
  parseCpuStat,
  parseCumStrict,
  parseMeminfo,
  parseToggles,
  parseTogglesStrict,
  repoName,
  resolveEffort,
  resolveSummary,
  rlWindow,
  shortDir,
  sidOf,
  step,
  why,
} from './model'
import { effectiveWindow } from './compact'
import type { EffectiveWindow } from './compact'
import { dispatchOf, parseInflightWarn } from './dispatch'
import { fixtureOf, naReason, readSideKind } from './sidefile'
import { syncOf } from './sync'
import type { Cum, RlField, RlSnap, RlSnaps, RlWindow } from './model'
import type { CpuSample, GitCounts, GitInfo, HookVerdicts, QuotaWindow, Res, Snap, Toggles } from './state'

export type Io = {
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => { cancel: () => void }
  sessionId: () => Promise<string>
  cwd: () => Promise<string>
  model: () => Promise<string>
  version: () => Promise<string>
  usage: () => Promise<SessionUsage>
  home: () => Promise<string | undefined>
  tmpdir: () => Promise<string | undefined>
  effortEnv: () => Promise<string | undefined>
  /** The variable the engine reads before the settings for the window it compacts at. */
  compactWindowEnv: () => Promise<string | undefined>
  inflightWarn: () => Promise<string | undefined>
  settings: (source?: SettingsSource) => Promise<Settings>
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  readBytes: (path: string) => Promise<Uint8Array>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<{ name: string }[]>
  run: (argv: string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  /** Takes a session's pending lines off the count and hands them over: the caller persists them or gives them back. */
  takeLines: (sid: string) => Promise<{ add: number; rm: number }>
  /** Puts lines taken by a write that then failed back on the count. */
  returnLines: (sid: string, add: number, rm: number) => Promise<void>
}

/** The reason a row switched off in the rows file carries: it is not collected and never drawn. */
const OFF = 'off'
const COLLECTOR_MS = 5000
const GIT_MS = 2000
const GIT_STATUS_MS = 4000
/** The guard around a process call waits a little past the call's own timeout, so the host's rejection wins. */
const GUARD_SLACK_MS = 500
/** The git row's own guard: two calls in a row at their full budget, and a little over. */
const GIT_ROW_MS = 2 * (GIT_MS + GUARD_SLACK_MS) + GUARD_SLACK_MS
const MV_MS = 5000
const CAS_TRIES = 10

export const MCP_EVERY_MS = 5 * 60_000

export type RefreshIn = {
  now: number
  outTokens: { sid: string; n: number }
  hookEffort: { sid: string; level: string } | null
  prevCpu: CpuSample | null
  /** The toggles the pane has now, kept when the rows file cannot be read. */
  prevToggles: Toggles | null
  /** What the pane last knew of the tracker hooks, kept when the settings cannot be read. */
  prevHooks: HookVerdicts | null
  /** True when the MCP status refresher may be started again. */
  mcpDue: boolean
  /** False once a newer refresh has replaced this one: it must not write over it. */
  isCurrent: () => boolean
}

export type RefreshOut = {
  snap: Snap
  cpu: CpuSample | null
  kickedMcp: boolean
}

/** The first non-empty line of a process's stderr, the reason a row gives when the command failed. */
const firstLine = (text: string): string =>
  text
    .split('\n')
    .map(l => l.trim())
    .find(l => l !== '')
    ?.slice(0, 60) ?? ''

/** Runs one collector; a throw or a stall becomes a short reason instead of an exception. */
export const guard = <T>(io: Io, fn: () => Promise<T>, ms = COLLECTOR_MS): Promise<Res<T>> =>
  new Promise(resolve => {
    let timer: { cancel: () => void } | null = null
    try {
      timer = io.after(ms, () => resolve({ ok: false, why: 'timeout' }))
    } catch {
      // no timer: the collector runs unbounded rather than not at all
    }
    Promise.resolve()
      .then(fn)
      .then(
        v => resolve({ ok: true, v }),
        err => resolve({ ok: false, why: why(err) }),
      )
      .then(() => timer?.cancel())
      .catch(() => undefined)
  })

const parseJson = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Reads a file known to exist; a read that fails then counts as missing. */
const tryRead = async (io: Io, path: string): Promise<string | null> => {
  try {
    return await io.read(path)
  } catch {
    return null
  }
}

/** Optional file: checked first, since the host logs every failed read as an error. */
const readOpt = async (io: Io, path: string): Promise<string | null> =>
  (await io.exists(path)) ? tryRead(io, path) : null

/** The reason both tracker rows give when the file exists and the read fails. */
const UNREADABLE_AGENTS = 'agents file unreadable'

const readMany = async (io: Io, paths: string[]): Promise<(string | null)[]> => {
  const out: (string | null)[] = []
  for (let i = 0; i < paths.length; i += 20) {
    out.push(...(await Promise.all(paths.slice(i, i + 20).map(p => tryRead(io, p)))))
  }
  return out
}

type Base = { sid: string; cwd: string; home: string; tmp: string }

const baseOf = async (io: Io): Promise<Base> => {
  const [id, cwd, home, tmp] = await Promise.all([io.sessionId(), io.cwd(), io.home(), io.tmpdir()])
  return { sid: sidOf(id), cwd, home: home ?? '', tmp: (tmp || '/tmp').replace(/\/+$/, '') }
}

const needHome = (b: Base): string => {
  if (!b.home) throw new Error('HOME is not set')
  return b.home
}

/** `~/.gemini/<name>` when it exists, else `~/.claude/<name>`, as statusline.js picks these files (L24-25, L200-201). */
const geminiFirst = async (io: Io, home: string, name: string): Promise<string> =>
  (await io.exists(`${home}/.gemini/${name}`)) ? `${home}/.gemini/${name}` : `${home}/.claude/${name}`

/**
 * Writes through a temp file and `mv`, so a reader never sees half a file. A failed mv falls back to a plain
 * write and returns true, which the footer counts as an error.
 */
const atomicWrite = async (io: Io, path: string, text: string): Promise<boolean> => {
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`
  try {
    await io.write(tmp, text)
    const moved = await io.run(['mv', '-f', tmp, path], { timeoutMs: MV_MS })
    if (moved.exitCode === 0) return false
  } catch {
    // the temp file or the mv failed: the data goes in place below
  }
  await io.write(path, text)
  void io.run(['rm', '-f', tmp], { timeoutMs: MV_MS }).catch(() => undefined)
  return true
}

const NOT_A_REPO = /not a git repository/i
/** What `rev-parse --abbrev-ref HEAD` says in a repository with no commits, where HEAD names no commit yet. */
const UNBORN_HEAD = /ambiguous argument 'HEAD'/
const NO_COUNTS: GitCounts = { added: 0, modified: 0, untracked: 0 }

const collectGit = async (io: Io, b: Base): Promise<GitInfo> => {
  const run = (argv: string[], ms: number) =>
    io.run(argv, { cwd: b.cwd, timeoutMs: ms, env: { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } })
  const quick = (argv: string[]) => guard(io, () => run(argv, GIT_MS), GIT_MS + GUARD_SLACK_MS)
  // every call has its own budget and waits only for the call it depends on: a slow status must not hold up
  // the branch, and a lookup that follows a missing origin or an unborn HEAD starts as soon as that is known
  const statusP = guard(io, () => run(['git', 'status', '--porcelain'], GIT_STATUS_MS), GIT_STATUS_MS + GUARD_SLACK_MS)
  const branchP = (async (): Promise<string | null> => {
    const head = await quick(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    if (!head.ok) throw new Error(head.why)
    if (head.v.exitCode === 0) return head.v.stdout.trim()
    if (NOT_A_REPO.test(head.v.stderr)) return null
    if (!UNBORN_HEAD.test(head.v.stderr)) throw new Error(firstLine(head.v.stderr) || `git exited ${head.v.exitCode}`)
    // no commits yet is no failure: the branch is where HEAD points, or none if git cannot say
    // (rev-parse printed "HEAD" on stdout, which is no branch)
    const named = await quick(['git', 'symbolic-ref', '--short', '-q', 'HEAD'])
    return named.ok && named.v.exitCode === 0 ? named.v.stdout.trim() : ''
  })()
  const repoP = (async (): Promise<string> => {
    // a missing origin is normal; the repository is then named from its top-level directory
    const remote = await quick(['git', 'remote', 'get-url', 'origin'])
    const named = remote.ok && remote.v.exitCode === 0 ? repoName(remote.v.stdout.trim(), '') : ''
    if (named) return named
    const top = await quick(['git', 'rev-parse', '--show-toplevel'])
    return top.ok && top.v.exitCode === 0 ? repoName('', top.v.stdout.trim()) : ''
  })()
  const [branch, repo, status] = await Promise.all([branchP, repoP, statusP])
  if (branch === null) return { branch: '', repo: '', status: { ok: true, v: NO_COUNTS }, notRepo: true }
  const counts: Res<GitCounts> = !status.ok
    ? status
    : status.v.exitCode !== 0
      ? { ok: false, why: firstLine(status.v.stderr) || `git exited ${status.v.exitCode}` }
      : { ok: true, v: countGitStatus(status.v.stdout) }
  return { branch, repo, status: counts }
}

/** `settings` are the merge and then each source, highest precedence first; null when they could not be read. */
const collectModel = async (io: Io, b: Base, input: RefreshIn, settings: readonly unknown[] | null) => {
  // a refused CLAUDE_EFFORT read leaves the level unknown; it must not take the model name with it
  const [raw, version, env] = await Promise.all([io.model(), io.version(), io.effortEnv().catch(() => undefined)])
  const hook = input.hookEffort?.sid === b.sid ? input.hookEffort.level : null
  // a level a hook reported is live; before the first one the settings' own is shown, as configured
  const live = resolveEffort({ hook, env })
  const effort = live ?? (settings === null ? null : configuredEffort(settings, raw))
  return { name: modelLabel(raw), version, effort, configured: live === null && effort !== null }
}

const collectSummary = async (io: Io, b: Base): Promise<string> => {
  const file = await readOpt(io, `${b.tmp}/claude-summary-${b.sid}.txt`)
  // the message log can be large; it only matters when the summary file says nothing
  const msgs = (file ?? '').trim() ? null : parseJson(await readOpt(io, `${b.tmp}/claude-msgs-${b.sid}.json`))
  return resolveSummary(file, msgs, b.sid)
}

type StoredCum = { kind: 'missing' } | { kind: 'ok'; cum: Cum } | { kind: 'bad'; why: string }

/** A missing cum file is zero; one that is there but unreadable or corrupt is not, and must never be overwritten. */
const readCum = async (io: Io, path: string): Promise<StoredCum> => {
  if (!(await io.exists(path))) return { kind: 'missing' }
  let text: string
  try {
    text = await io.read(path)
  } catch (err) {
    return { kind: 'bad', why: `cum file unreadable: ${why(err)}` }
  }
  const cum = parseCumStrict(text)
  return cum ? { kind: 'ok', cum } : { kind: 'bad', why: 'cum file is corrupt' }
}

type CumOut = { cum: Cum; all: { cost: number; tok: number }; fellBack: boolean }

/**
 * Steps this session's counters, writes the cum file and totals every session's (L143-171, L487-500).
 * Every read that can fail comes first: the write is the commit point. The pending lines are taken off
 * the count just before it, so no other refresh can persist them too, and given back if it fails.
 */
const collectCum = async (io: Io, b: Base, u: SessionUsage | null, input: RefreshIn): Promise<CumOut> => {
  const path = `${b.tmp}/claude-cum-${b.sid}.json`
  const stored = await readCum(io, path)
  if (stored.kind === 'bad') throw new Error(stored.why)
  const names = (await io.list(b.tmp))
    .map(e => e.name)
    .filter(n => /^claude-cum-.*\.json$/.test(n) && `${b.tmp}/${n}` !== path)
  const others = allTotals(await readMany(io, names.map(n => `${b.tmp}/${n}`)))

  const cum = stored.kind === 'ok' ? stored.cum : emptyCum()
  if (u) {
    if (u.cost) cum.cost = step(cum.cost, u.cost.usd)
    cum.dur = step(cum.dur, input.now - u.startedAt)
    const out = input.outTokens.sid === b.sid ? input.outTokens.n : 0
    cum.tok = step(cum.tok, (u.context.tokens ?? 0) + out)
  }

  if (!input.isCurrent()) throw new Error('superseded by a newer refresh')
  const mine = await io.takeLines(b.sid)
  let fellBack: boolean
  try {
    // taking the lines took a moment: a refresh that was replaced meanwhile must not write
    if (!input.isCurrent()) throw new Error('superseded by a newer refresh')
    // the mod counts lines itself, so it owns these two totals outright (base = total)
    const add = cum.add.total + mine.add
    const rm = cum.rm.total + mine.rm
    cum.add = { total: add, base: add }
    cum.rm = { total: rm, base: rm }
    fellBack = await atomicWrite(io, path, cumJson(cum))
  } catch (err) {
    if (mine.add > 0 || mine.rm > 0) await io.returnLines(b.sid, mine.add, mine.rm).catch(() => undefined)
    throw err
  }
  return { cum, all: { cost: others.cost + cum.cost.total, tok: others.tok + cum.tok.total }, fellBack }
}

const asSnaps = (v: unknown): RlSnaps =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as RlSnaps) : {}

type QuotaOut = { five: QuotaWindow; seven: QuotaWindow; fellBack: boolean }

/** Publishes this session's windows to the shared file and reads the cross-session maximum back (L196-292). */
const collectQuota = async (io: Io, b: Base, u: SessionUsage, input: RefreshIn): Promise<QuotaOut> => {
  const file = await geminiFirst(io, needHome(b), 'rate-limit-snapshots.json')
  const nowSec = Math.floor(input.now / 1000)
  const five = rlWindow(u.rateLimits.find(r => r.kind === 'five_hour'))
  const seven = rlWindow(u.rateLimits.find(r => r.kind === 'seven_day'))
  const mine: RlSnap = { t: nowSec, five_hour: five, seven_day: seven }
  let snaps: RlSnaps = {}
  let fellBack = false
  // the write is atomic now, but another session can still write between our read and our write:
  // re-reading until our entry shows is what keeps theirs from erasing it
  for (let attempt = 0; attempt < CAS_TRIES; attempt++) {
    const merged = mergeSnap(asSnaps(parseJson(await readOpt(io, file))), b.sid, mine, nowSec)
    if (!input.isCurrent()) throw new Error('superseded by a newer refresh')
    fellBack = (await atomicWrite(io, file, JSON.stringify(merged))) || fellBack
    snaps = asSnaps(parseJson(await readOpt(io, file)))
    if (snaps[b.sid]?.t === mine.t) break
  }
  // no live reading anywhere is unknown (null) with no countdown; statusline.js drew it as 0% (L246-248)
  const windowOf = (field: RlField, own: RlWindow | null, periodSec: number): QuotaWindow => {
    const agg = aggMaxOrNull(snaps, field, own, nowSec)
    return { pct: agg === null ? null : Math.round(agg), resetSec: countdownSec(own?.resets_at, periodSec, nowSec) }
  }
  return { five: windowOf('five_hour', five, 5 * 3600), seven: windowOf('seven_day', seven, 7 * 86_400), fellBack }
}

const collectMemory = async (io: Io, b: Base): Promise<string[]> => {
  const home = needHome(b)
  const anyExists = async (paths: string[]) => (await Promise.all(paths.map(p => io.exists(p)))).some(Boolean)
  const parts: string[] = []
  if (await anyExists([`${home}/.gemini/AGY.md`, `${home}/.gemini/GEMINI.md`, `${home}/.claude/CLAUDE.md`])) {
    parts.push('global')
  }
  const project = ['AGY.md', 'GEMINI.md', 'CLAUDE.md', '.gemini/AGY.md', '.claude/CLAUDE.md'].map(f => `${b.cwd}/${f}`)
  if (await anyExists(project)) parts.push('project')
  let rules = 0
  for (const dir of [`${b.cwd}/.gemini/rules`, `${b.cwd}/.claude/rules`]) {
    if (await io.exists(dir)) rules += (await io.list(dir)).filter(e => e.name.endsWith('.md')).length
  }
  if (rules > 0) parts.push(`${rules} rules`)
  return parts
}

const collectEdited = async (io: Io, b: Base): Promise<string[]> => {
  const list = parseJson(await readOpt(io, `${b.tmp}/claude-files-${b.sid}.json`))
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string') : []
}

const collectCompacts = async (io: Io, b: Base): Promise<number> => {
  const count = (parseJson(await readOpt(io, `${b.tmp}/claude-compacts-${b.sid}.json`)) as { count?: unknown } | null)
    ?.count
  return typeof count === 'number' ? count : 0
}

const nonNull = <T>(v: T | null, what: string): T => {
  if (v === null) throw new Error(what)
  return v
}

/** No rows file is every row on; one that cannot be read or parsed keeps the toggles the pane has. */
const readToggles = async (io: Io, b: Base, prev: Toggles | null): Promise<Toggles> => {
  const file = await geminiFirst(io, needHome(b), 'cc-statusline-rows.json')
  if (!(await io.exists(file))) return parseToggles(null)
  return parseTogglesStrict(await io.read(file)) ?? prev ?? parseToggles(null)
}

/** The merge takes `hooks` whole from the last source that has it, so each source is read as well. */
const SETTINGS_SOURCES: SettingsSource[] = ['user', 'project', 'local', 'flag', 'policy']

/** Each source's settings, lowest precedence first; null when one cannot be read, since then nothing of them is known. */
export const readSources = async (io: Io): Promise<unknown[] | null> => {
  try {
    return await Promise.all(SETTINGS_SOURCES.map(source => io.settings(source)))
  } catch {
    return null
  }
}

/** The window the /compact line is taken of; the model's own when nothing says otherwise. Never throws. */
export const compactWindowOf = async (io: Io, window: number | undefined, ascending: readonly unknown[] | null): Promise<EffectiveWindow | null> => {
  const [model, env] = await Promise.all([io.model().catch(() => undefined), io.compactWindowEnv().catch(() => undefined)])
  return effectiveWindow({ window, model, env, sources: ascending === null ? [] : [...ascending].reverse() })
}

const REFRESHER = 'mcp-status-refresh.js'
const refresherPath = (home: string): string => `${home}/.claude/hooks/${REFRESHER}`

/** Starts the MCP status refresher; nothing awaits it, it self-skips while its cache is fresh. */
const kickMcpRefresh = async (io: Io, home: string): Promise<void> => {
  const refresher = refresherPath(home)
  if (await io.exists(refresher)) await io.run(['node', refresher], { timeoutMs: 60_000 })
}

/** The snapshot while the master switch is off: nothing collected, every row marked off, so the pane can say so. */
const disabledSnap = (at: number, toggles: Toggles, hooks: HookVerdicts): Snap => {
  const off = { ok: false as const, why: OFF }
  return {
    at,
    errors: 0,
    toggles,
    summary: off,
    dir: off,
    git: off,
    lines: off,
    model: off,
    cost: off,
    agents: off,
    context: off,
    tokens: off,
    quota: off,
    cpu: off,
    ram: off,
    memory: off,
    mcp: off,
    edited: off,
    hooks,
  }
}

/** One refresh: every row's data in a snapshot, each row failing alone. */
export const refresh = async (io: Io, input: RefreshIn): Promise<RefreshOut> => {
  const base = await guard(io, () => baseOf(io))
  const b = base.ok ? base.v : null

  const togglesRes = await guard(io, () => readToggles(io, nonNull(b, 'no session'), input.prevToggles), 2000)
  const toggles = togglesRes.ok ? togglesRes.v : (input.prevToggles ?? parseToggles(null))
  // the master switch is off: nothing is collected or written, as statusline.js returns at L31
  if (!toggles.enabled) {
    return { snap: disabledSnap(input.now, toggles, input.prevHooks ?? ALL_CONFIGURED), cpu: input.prevCpu, kickedMcp: false }
  }
  const on = toggles.rows

  // The files below come from tracker hooks in the settings and from the MCP refresher: when the settings do not
  // wire a hook or the script is gone, its row says so instead of reading idle. A row that is off is not checked,
  // and a settings read that fails keeps the verdicts the pane had (none yet: every hook counts as wired).
  const settingsRes =
    on.summary || on.agents || on.usage || on.edited || on.model
      ? await guard(io, () => Promise.all([io.settings(), ...SETTINGS_SOURCES.map(source => io.settings(source))]), 2000)
      : null
  const hooks: HookVerdicts = settingsRes?.ok ? hooksConfigured(...settingsRes.v) : (input.prevHooks ?? ALL_CONFIGURED)
  // the merge first, then the sources from the highest precedence down: a key the merge hid is still found
  const settingsByRank = settingsRes?.ok ? [settingsRes.v[0], ...settingsRes.v.slice(1).reverse()] : null
  const OK: Res<null> = { ok: true, v: null }
  const wired = (dep: keyof HookVerdicts): Res<null> =>
    hooks[dep] ? OK : { ok: false, why: `${HOOK_SCRIPTS[dep].script} hook not configured` }
  // the summary has a fallback: it is missing only when neither tracker that feeds it is wired
  const summaryWired: Res<null> =
    hooks.summary || hooks.messages
      ? OK
      : { ok: false, why: `${HOOK_SCRIPTS.summary.script} and ${HOOK_SCRIPTS.messages.script} hooks not configured` }
  const refresher: Res<null> =
    on.memory_mcp && b?.home
      ? await guard(io, async () => {
          if (!(await io.exists(refresherPath(b.home)))) throw new Error(`${REFRESHER} missing`)
          return null
        })
      : OK

  const usage = await guard(io, () => io.usage())
  const u = usage.ok ? usage.v : null

  /** Runs `fn` for a row that is on, once what it needs (`deps`) is in hand. */
  const row = <T>(show: boolean, deps: Res<unknown>[], fn: () => Promise<T>, ms?: number): Promise<Res<T>> => {
    if (!show) return Promise.resolve({ ok: false, why: OFF })
    const dead = deps.find(d => !d.ok)
    if (dead && !dead.ok) return Promise.resolve({ ok: false, why: dead.why })
    return guard(io, fn, ms)
  }

  // read only with the agents row on; a refused read is no threshold, so the count is shown plain
  const warn = on.agents ? parseInflightWarn(await io.inflightWarn().catch(() => undefined)) : null
  const [summary, dir, git, model, agentsRes, compacts, cumRes, quota, cpuRes, ramRes, memory, mcp, edited, side, autoCompactRes, syncSide] =
    await Promise.all([
      row(on.summary, [base, summaryWired], () => collectSummary(io, b!)),
      row(on.dir || on.repo, [base], async () => shortDir(b!.cwd, b!.home)),
      row(on.dir || on.repo, [base], () => collectGit(io, b!), GIT_ROW_MS),
      row(on.model, [base], () => collectModel(io, b!, input, settingsByRank)),
      row(on.agents, [base, wired('agents')], async () => {
        const file = `${b!.tmp}/claude-agents-${b!.sid}.json`
        // absent is a fresh session; a file that is there but cannot be read is another cause, and says so
        const text = (await io.exists(file)) ? await io.read(file).catch(() => Promise.reject(new Error(UNREADABLE_AGENTS))) : null
        return { text, groups: groupAgents(parseJson(text)) }
      }),
      row(on.usage, [base, wired('compact')], () => collectCompacts(io, b!)),
      row(true, [base], () => collectCum(io, b!, u, input)),
      row(true, [base, usage], () => collectQuota(io, b!, u!, input)),
      row(on.sys, [], async () => {
        const sample = nonNull(parseCpuStat(await io.read('/proc/stat')), 'unreadable /proc/stat')
        return { sample, pct: cpuPercent(input.prevCpu, sample) }
      }),
      row(on.sys, [], async () => nonNull(parseMeminfo(await io.read('/proc/meminfo')), 'unreadable /proc/meminfo')),
      row(on.memory_mcp, [base], () => collectMemory(io, b!)),
      row(on.memory_mcp, [base, refresher], async () =>
        mcpInfo(parseJson(await readOpt(io, `${needHome(b!)}/.claude/mcp-status-cache.json`))),
      ),
      row(on.edited, [base, wired('edited')], () => collectEdited(io, b!)),
      row(on.fixture, [base], () => readSideKind(io, 'fixture', { tmpdir: b!.tmp }, {}, input.now)),
      // the settings were read above: every source after the merge, lowest first
      row(on.usage, [base, usage], () => compactWindowOf(io, u!.context.window, settingsRes?.ok ? settingsRes.v.slice(1) : null)),
      row(on.sync, [base], () => readSideKind(io, 'sync-status', { tmpdir: b!.tmp }, {}, input.now)),
    ])

  const fromCum = <T>(f: (c: CumOut) => T): Res<T> =>
    cumRes.ok ? { ok: true, v: f(cumRes.v) } : { ok: false, why: cumRes.why }
  /** Cost and tokens also need this refresh's usage; lines do not. */
  const fromCumAndUsage = <T>(f: (c: CumOut) => T): Res<T> => (usage.ok ? fromCum(f) : { ok: false, why: usage.why })
  // the compact count is a segment of its own: without it the context still draws
  const context: Snap['context'] = !usage.ok
    ? { ok: false, why: usage.why }
    : {
        ok: true,
        v: {
          pct: usage.v.context.percent ?? null,
          used: usage.v.context.tokens ?? 0,
          max: usage.v.context.window,
          compacts,
          ...(autoCompactRes.ok && autoCompactRes.v !== null ? { autoCompact: autoCompactRes.v } : {}),
        },
      }
  const snap: Snap = {
    at: await io.now(),
    errors: 0,
    toggles,
    summary,
    dir,
    git,
    lines: fromCum(c => ({ add: c.cum.add.total, rm: c.cum.rm.total })),
    model,
    cost: fromCumAndUsage(c => ({ all: c.all.cost, session: c.cum.cost.total, durMin: Math.round(c.cum.dur.total / 60_000) })),
    agents: agentsRes.ok ? { ok: true, v: agentsRes.v.groups } : agentsRes,
    context,
    tokens: fromCumAndUsage(c => ({ all: c.all.tok, session: c.cum.tok.total })),
    quota: quota.ok ? { ok: true, v: { five: quota.v.five, seven: quota.v.seven } } : { ok: false, why: quota.why },
    cpu: cpuRes.ok ? { ok: true, v: cpuRes.v.pct } : { ok: false, why: cpuRes.why },
    ram: ramRes,
    memory,
    mcp,
    edited,
    hooks,
  }
  // the reader's own text is the reason (never cut to a short one); absent when the row is off
  if (on.fixture) snap.fixture = side.ok ? fixtureOf(side.v) : { ok: false, why: naReason(side.why) }
  // one read of the tracker feeds both rows; a failure reads the same reason in both
  if (on.agents) snap.dispatch = agentsRes.ok ? dispatchOf(agentsRes.v.text, input.now, warn) : agentsRes
  if (on.sync) snap.sync = syncSide.ok ? syncOf(syncSide.v, input.now / 1000) : { ok: false, why: naReason(syncSide.why) }
  // a SYNC n/a by design is shown but not counted: no file (no producer here yet), or an aged one (between hook runs);
  // a row that failed to collect is a fault
  const syncByDesign = syncSide.ok && (syncSide.v.verdict === 'missing' || syncSide.v.verdict === 'stale')
  // no tracker file is by design too (the first dispatch writes it): the in-flight row shows n/a but is not counted;
  // an unreadable or corrupt file is a fault
  const dispatchByDesign = agentsRes.ok && agentsRes.v.text === null
  // a failure behind a row that is switched off is nothing to report; git counts when its status failed
  const shown: [Res<unknown>, boolean][] = [
    [snap.summary, on.summary],
    [snap.dir, on.dir || on.repo],
    [snap.git.ok ? snap.git.v.status : snap.git, on.dir || on.repo],
    [snap.lines, on.dir || on.repo],
    [snap.model, on.model],
    [snap.cost, on.cost],
    [snap.agents, on.agents],
    // a failed tracker read is one cause: the agents row already counts it
    [snap.agents.ok && snap.dispatch ? snap.dispatch : OK, on.agents && !dispatchByDesign],
    [snap.context, on.usage],
    [snap.context.ok ? snap.context.v.compacts : OK, on.usage],
    [snap.tokens, on.usage],
    [snap.quota, on.quota],
    [snap.cpu, on.sys],
    [snap.ram, on.sys],
    [snap.memory, on.memory_mcp],
    [snap.mcp, on.memory_mcp],
    [snap.edited, on.edited],
    [snap.fixture ?? OK, on.fixture],
    [snap.sync ?? OK, on.sync && !syncByDesign],
  ]
  // a write that had to fall back to a plain one is an error too, whichever row it fed
  const fallbacks = [cumRes, quota].filter(r => r.ok && r.v.fellBack).length
  snap.errors = shown.filter(([res, isOn]) => isOn && !res.ok).length + fallbacks

  const kickedMcp = input.mcpDue && !!b?.home && on.memory_mcp
  if (kickedMcp) void kickMcpRefresh(io, b.home).catch(() => undefined)

  return { snap, cpu: cpuRes.ok ? cpuRes.v.sample : input.prevCpu, kickedMcp }
}
