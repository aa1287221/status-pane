import { describe, expect, test } from 'claude-code/testing'

import { SYNC_REFRESH_MS, SYNC_RUN_TIMEOUT_MS, producerPath, startSyncRefresh } from './syncrefresh'
import type { SyncDeps, SyncRunResult } from './syncrefresh'

const PATH = '/root/.claude/scripts/hooks/sync-status.py'
const MIN5 = 300_000
const OK: SyncRunResult = { exitCode: 0, stdout: '', stderr: '' }

// the engine typings declare no timers; the runner has them
declare const setTimeout: (fn: () => void, ms: number) => unknown
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
    startSyncRefresh(r.deps, { failed: false })
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
    const handle = startSyncRefresh(r.deps, { failed: false })
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
    startSyncRefresh(r.deps, { failed: false })
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
    startSyncRefresh(r.deps, { failed: false })
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
    startSyncRefresh(r.deps, { failed: false })
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(0)
    expect(r.logs.some(l => /state read refused/.test(l))).toBe(true)
  })

  test('a missing producer file is logged with its path, and nothing runs', async () => {
    const r = rig()
    r.knobs.files.clear()
    startSyncRefresh(r.deps, { failed: false })
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(0)
    expect(r.logs.some(l => /missing/.test(l) && l.includes(PATH))).toBe(true)
  })

  test('a refused existence check is logged and nothing runs', async () => {
    const r = rig()
    r.deps.exists = async () => {
      throw new Error('EACCES: permission denied')
    }
    startSyncRefresh(r.deps, { failed: false })
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(0)
    expect(r.logs.some(l => /EACCES/.test(l))).toBe(true)
  })
})

describe('sync refresh: the producer run', () => {
  test('the run is the hook command with --print, a stdin that is not a Stop event, and a 30 s bound', async () => {
    const r = rig()
    startSyncRefresh(r.deps, { failed: false })
    await r.clock.advance(MIN5)
    expect(r.runs[0]?.argv).toEqual(['python3', '-I', '-B', PATH, '--print'])
    expect(r.runs[0]?.init).toEqual({ stdin: '{}', timeoutMs: 30_000 })
  })

  test('a clean run logs nothing', async () => {
    const r = rig()
    startSyncRefresh(r.deps, { failed: false })
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(1)
    expect(r.logs).toEqual([])
  })

  test('an exit code of 1 is logged with the code and the report, and the period goes on', async () => {
    const r = rig()
    r.answers.push(() => Promise.resolve({ exitCode: 1, stdout: 'sync-status: failed\n  error:     git_timeout: slow\n', stderr: '' }))
    startSyncRefresh(r.deps, { failed: false })
    await r.clock.advance(MIN5)
    expect(r.logs.join('\n')).toMatch(/exited 1[\s\S]*git_timeout/)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(2)
  })

  test('an exit code of 2 (cannot write) is logged with what the producer wrote to stderr', async () => {
    const r = rig()
    r.answers.push(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: 'sync-status: cannot write: Permission denied' }))
    startSyncRefresh(r.deps, { failed: false })
    await r.clock.advance(MIN5)
    expect(r.logs.join('\n')).toMatch(/exited 2[\s\S]*Permission denied/)
  })

  test('a run the host ends with an error, a timeout or a spawn error, is logged and the period goes on', async () => {
    const r = rig()
    r.answers.push(() => Promise.reject(new Error('timed out after 30000 ms')))
    startSyncRefresh(r.deps, { failed: false })
    await r.clock.advance(MIN5)
    expect(r.logs.join('\n')).toMatch(/timed out/)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(2)
  })

  test('a host timeout keeps the whole aborted reason; only the first line and the engine prefix are cut', async () => {
    const r = rig()
    r.answers.push(() => Promise.reject(new Error('status-pane: $.process.run(python3) aborted: still running after 30000 ms\nsecond line')))
    startSyncRefresh(r.deps, { failed: false })
    await r.clock.advance(MIN5)
    expect(r.logs).toEqual(['sync-status: producer run failed: aborted: still running after 30000 ms'])
  })

  test('a missing python3 is logged as a failed run, not as a start that never happened', async () => {
    const r = rig()
    r.answers.push(() => Promise.reject(new Error('status-pane: $.process.run(python3) spawn python3 ENOENT')))
    startSyncRefresh(r.deps, { failed: false })
    await r.clock.advance(MIN5)
    expect(r.logs).toEqual(['sync-status: producer run failed: spawn python3 ENOENT'])
    expect(r.logs.join('\n')).not.toMatch(/cannot start/)
  })

  test('a run error longer than 300 characters is cut at 300, with the ellipsis inside the cut', async () => {
    const r = rig()
    r.answers.push(() => Promise.reject(new Error(`status-pane: $.process.run(python3) ${'x'.repeat(400)}`)))
    startSyncRefresh(r.deps, { failed: false })
    await r.clock.advance(MIN5)
    expect(r.logs.length).toBe(1)
    expect(r.logs[0]?.length).toBe('sync-status: producer run failed: '.length + 300)
    expect(r.logs[0]?.endsWith('...')).toBe(true)
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
    startSyncRefresh(r.deps, { failed: false })
    await r.clock.advance(MIN5)
    expect(r.runs[0]?.argv[3]).toBe('/opt/cc/scripts/hooks/sync-status.py')
  })
})

describe('sync refresh: the outcome of the last finished refresh (#123)', () => {
  // the mod run's own record; `failed` is the last finished refresh's outcome, false before the first one
  const failedOf = (state: { failed: boolean }) => state.failed

  test('nothing has finished yet: the outcome reads not failed, and a start alone changes nothing', () => {
    const r = rig()
    const state = { failed: false }
    startSyncRefresh(r.deps, state)
    expect(failedOf(state)).toBe(false)
  })

  test('a non-zero exit sets the outcome to failed, and the next clean run clears it', async () => {
    const r = rig()
    const state = { failed: false }
    r.answers.push(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: 'cannot write' }))
    startSyncRefresh(r.deps, state)
    await r.clock.advance(MIN5)
    expect(failedOf(state)).toBe(true)
    await r.clock.advance(MIN5)
    expect(failedOf(state)).toBe(false)
  })

  test('a missing producer file sets the outcome to failed', async () => {
    const r = rig()
    const state = { failed: false }
    r.knobs.files.clear()
    startSyncRefresh(r.deps, state)
    await r.clock.advance(MIN5)
    expect(failedOf(state)).toBe(true)
  })

  test('neither CLAUDE_CONFIG_DIR nor HOME sets the outcome to failed: there is no path to run', async () => {
    const r = rig()
    const state = { failed: false }
    r.knobs.home = undefined
    startSyncRefresh(r.deps, state)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(0)
    expect(failedOf(state)).toBe(true)
  })

  test('a run the host rejects sets the outcome to failed, and the period goes on', async () => {
    const r = rig()
    const state = { failed: false }
    r.answers.push(() => Promise.reject(new Error('status-pane: $.process.run(python3) aborted: still running after 30000 ms')))
    startSyncRefresh(r.deps, state)
    await r.clock.advance(MIN5)
    expect(failedOf(state)).toBe(true)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(2)
  })

  test('card off is no attempt: a failure before it still stands', async () => {
    const r = rig()
    const state = { failed: false }
    r.answers.push(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: '' }))
    startSyncRefresh(r.deps, state)
    await r.clock.advance(MIN5)
    expect(failedOf(state)).toBe(true)
    r.knobs.wanted = false
    await r.clock.advance(2 * MIN5)
    expect(r.runs.length).toBe(1)
    expect(failedOf(state)).toBe(true)
  })

  test('a tick skipped for a run still going does not change the outcome; the finished run sets it', async () => {
    const r = rig()
    const state = { failed: false }
    const hold = held()
    r.answers.push(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: '' }))
    r.answers.push(() => hold.promise)
    startSyncRefresh(r.deps, state)
    await r.clock.advance(MIN5)
    expect(failedOf(state)).toBe(true)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(2)
    await r.clock.advance(MIN5)
    expect(r.runs.length).toBe(2)
    expect(r.logs.some(l => /still going/.test(l))).toBe(true)
    expect(failedOf(state)).toBe(true)
    hold.release(OK)
    await flush()
    expect(failedOf(state)).toBe(false)
  })

  test('a new start on the same state (a re-arm) keeps the outcome the last refresh left', async () => {
    const r = rig()
    const state = { failed: false }
    r.answers.push(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: '' }))
    const first = startSyncRefresh(r.deps, state)
    await r.clock.advance(MIN5)
    expect(failedOf(state)).toBe(true)
    first.cancel()
    startSyncRefresh(r.deps, state)
    expect(failedOf(state)).toBe(true)
  })
})
