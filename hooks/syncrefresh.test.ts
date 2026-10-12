import { describe, expect, test } from 'claude-code/testing'

import { SYNC_REFRESH_MS, SYNC_RUN_TIMEOUT_MS, producerPath, startSyncRefresh } from './syncrefresh'
import type { SyncDeps, SyncRunResult } from './syncrefresh'

const PATH = '/root/.claude/scripts/hooks/sync-status.py'
const MIN5 = 300_000
const OK: SyncRunResult = { exitCode: 0, stdout: '', stderr: '' }

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** A clock the test moves by hand: a timer fires as `advance` passes its time, and one set during a firing can fire in the same advance. */
const clockOf = () => {
  let now = 0
  let seq = 0
  const timers: { at: number; seq: number; fn: () => void; live: boolean }[] = []
  return {
    after: (ms: number, fn: () => void) => {
      const t = { at: now + ms, seq: seq++, fn, live: true }
      timers.push(t)
      return {
        cancel: () => {
          t.live = false
        },
      }
    },
    advance: async (ms: number) => {
      const end = now + ms
      for (;;) {
        const due = timers.filter(t => t.live && t.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
        if (!due) break
        now = due.at
        due.live = false
        due.fn()
        await flush()
      }
      now = end
      await flush()
    },
  }
}

/** One started refresh with every dependency faked; `runs` is each start in order, `answers` the queued results. */
const rig = () => {
  const clock = clockOf()
  const knobs = { wanted: true, configDir: undefined as string | undefined, home: '/root' as string | undefined, files: new Set([PATH]) }
  const logs: string[] = []
  const runs: { argv: string[]; init: { stdin: string; timeoutMs: number } }[] = []
  const answers: (() => Promise<SyncRunResult>)[] = []
  const deps: SyncDeps = {
    after: clock.after,
    wanted: async () => knobs.wanted,
    configDir: async () => knobs.configDir,
    home: async () => knobs.home,
    exists: async path => knobs.files.has(path),
    run: (argv, init) => {
      runs.push({ argv, init })
      return (answers.shift() ?? (() => Promise.resolve(OK)))()
    },
    log: text => {
      logs.push(text)
    },
  }
  return { clock, knobs, logs, runs, answers, deps }
}

/** A run that stays unfinished until the test releases it. */
const held = () => {
  let release: (r: SyncRunResult) => void = () => {}
  const promise = new Promise<SyncRunResult>(resolve => {
    release = resolve
  })
  return { promise, release }
}

describe('sync refresh: the period', () => {
  test('the first start comes one interval after the refresh starts, then one per interval', async () => {
    const r = rig()
    startSyncRefresh(r.deps)
    await r.clock.advance(MIN5 - 1)
    expect(r.runs.length).toBe(0)
    await r.clock.advance(1)
    expect(r.runs.length).toBe(1)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(2)
  })

  test('the interval is five minutes and one run is bounded at 30 seconds', () => {
    expect(SYNC_REFRESH_MS).toBe(300_000)
    expect(SYNC_RUN_TIMEOUT_MS).toBe(30_000)
  })

  test('cancel stops the period, and nothing starts after it', async () => {
    const r = rig()
    const handle = startSyncRefresh(r.deps)
    handle.cancel()
    await r.clock.advance(3 * MIN5)
    expect(r.runs.length).toBe(0)
  })
})

describe('sync refresh: one run at a time', () => {
  test('a tick that finds the last run unfinished is skipped and logged; the tick after it runs once the first has finished', async () => {
    const r = rig()
    const hold = held()
    r.answers.push(() => hold.promise)
    startSyncRefresh(r.deps)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(1)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(1)
    expect(r.logs.filter(l => /still going/.test(l)).length).toBe(1)
    hold.release(OK)
    await flush()
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(2)
  })
})

describe('sync refresh: the card and the producer file', () => {
  test('card off: nothing starts and nothing is logged, and it starts again once the card is back on', async () => {
    const r = rig()
    r.knobs.wanted = false
    startSyncRefresh(r.deps)
    await r.clock.advance(2 * MIN5)
    expect(r.runs.length).toBe(0)
    expect(r.logs).toEqual([])
    r.knobs.wanted = true
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(1)
  })

  test('a refused card check is logged and nothing starts', async () => {
    const r = rig()
    r.deps.wanted = async () => {
      throw new Error('state read refused')
    }
    startSyncRefresh(r.deps)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(0)
    expect(r.logs.some(l => /state read refused/.test(l))).toBe(true)
  })

  test('a missing producer file is logged with its path, and nothing runs', async () => {
    const r = rig()
    r.knobs.files.clear()
    startSyncRefresh(r.deps)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(0)
    expect(r.logs.some(l => /missing/.test(l) && l.includes(PATH))).toBe(true)
  })

  test('a refused existence check is logged and nothing runs', async () => {
    const r = rig()
    r.deps.exists = async () => {
      throw new Error('EACCES: permission denied')
    }
    startSyncRefresh(r.deps)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(0)
    expect(r.logs.some(l => /EACCES/.test(l))).toBe(true)
  })
})

describe('sync refresh: the producer run', () => {
  test('the run is the hook command with --print, a stdin that is not a Stop event, and a 30 s bound', async () => {
    const r = rig()
    startSyncRefresh(r.deps)
    await r.clock.advance(MIN5)
    expect(r.runs[0]?.argv).toEqual(['python3', '-I', '-B', PATH, '--print'])
    expect(r.runs[0]?.init).toEqual({ stdin: '{}', timeoutMs: 30_000 })
  })

  test('a clean run logs nothing', async () => {
    const r = rig()
    startSyncRefresh(r.deps)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(1)
    expect(r.logs).toEqual([])
  })

  test('an exit code of 1 is logged with the code and the report, and the period goes on', async () => {
    const r = rig()
    r.answers.push(() => Promise.resolve({ exitCode: 1, stdout: 'sync-status: failed\n  error:     git_timeout: slow\n', stderr: '' }))
    startSyncRefresh(r.deps)
    await r.clock.advance(MIN5)
    expect(r.logs.join('\n')).toMatch(/exited 1[\s\S]*git_timeout/)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(2)
  })

  test('an exit code of 2 (cannot write) is logged with what the producer wrote to stderr', async () => {
    const r = rig()
    r.answers.push(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: 'sync-status: cannot write: Permission denied' }))
    startSyncRefresh(r.deps)
    await r.clock.advance(MIN5)
    expect(r.logs.join('\n')).toMatch(/exited 2[\s\S]*Permission denied/)
  })

  test('a run the host ends with an error, a timeout or a spawn error, is logged and the period goes on', async () => {
    const r = rig()
    r.answers.push(() => Promise.reject(new Error('timed out after 30000 ms')))
    startSyncRefresh(r.deps)
    await r.clock.advance(MIN5)
    expect(r.logs.join('\n')).toMatch(/timed out/)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(2)
  })
})

describe('sync refresh: where the producer is', () => {
  test('CLAUDE_CONFIG_DIR, when set and not empty, is the directory; HOME/.claude is the fallback', () => {
    expect(producerPath('/opt/cc', '/root')).toBe('/opt/cc/scripts/hooks/sync-status.py')
    expect(producerPath(undefined, '/root')).toBe(PATH)
    expect(producerPath('', '/root')).toBe(PATH)
  })

  test('with neither set there is no path to run', () => {
    expect(producerPath(undefined, undefined)).toBeNull()
    expect(producerPath('', '')).toBeNull()
  })

  test('the run uses the path resolved from the environment it was given', async () => {
    const r = rig()
    r.knobs.configDir = '/opt/cc'
    r.knobs.files = new Set(['/opt/cc/scripts/hooks/sync-status.py'])
    startSyncRefresh(r.deps)
    await r.clock.advance(MIN5)
    expect(r.runs[0]?.argv[3]).toBe('/opt/cc/scripts/hooks/sync-status.py')
  })
})
