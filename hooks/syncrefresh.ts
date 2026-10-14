// The mod's own start of the sync-status producer (#91): the hooks write the file only on SessionStart and Stop, so an
// idle session lets it pass the 900 s TTL. The producer runs as the hook runs it, with --print so its exit code is told.

/** Between two starts. The first one comes this long after the mod starts, since SessionStart has just written the file. */
export const SYNC_REFRESH_MS = 300_000
/** The host ends a run after this long and the call rejects; the producer's own git calls share an 8 s budget. */
export const SYNC_RUN_TIMEOUT_MS = 30_000

const SKIPPED = 'sync-status: previous run still going, tick skipped'
const REPORT_MAX = 300

export type SyncRunInit = { stdin: string; timeoutMs: number }
export type SyncRunResult = { exitCode: number; stdout: string; stderr: string }

/** What a refresh needs from the engine. register.tsx builds it from `$`; the tests build it from a fake clock. */
export type SyncDeps = {
  after: (ms: number, fn: () => void) => { cancel: () => void }
  /** The SYNC card is on and the master switch too; the producer stays off otherwise. */
  wanted: () => Promise<boolean>
  configDir: () => Promise<string | undefined>
  home: () => Promise<string | undefined>
  exists: (path: string) => Promise<boolean>
  run: (argv: string[], init: SyncRunInit) => Promise<SyncRunResult>
  log: (text: string) => void
}

/** Where the hook looks: CLAUDE_CONFIG_DIR when set and not empty, else HOME/.claude. */
export const producerPath = (configDir: string | undefined, home: string | undefined): string | null => {
  const dir = configDir || (home ? `${home}/.claude` : '')
  return dir ? `${dir}/scripts/hooks/sync-status.py` : null
}

/** The hook's command with --print, so the exit code is 0 ok, 1 collection failed, 2 cannot write. */
export const producerArgv = (path: string): string[] => ['python3', '-I', '-B', path, '--print']

/** The producer's stdout and stderr on one line, clipped; a run that printed nothing says so. */
const report = (res: SyncRunResult): string => {
  const text = `${res.stdout}\n${res.stderr}`
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .join(' | ')
  if (text === '') return '(no output)'
  return text.length > REPORT_MAX ? `${text.slice(0, REPORT_MAX - 3)}...` : text
}

/** A run that rejected: the first line of its message, minus the engine's `<plugin>: $.process.run(<argv0>) ` prefix. */
const runError = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err)
  const line = (raw.split('\n')[0] ?? '').replace(/^[\w-]+: \$\.process\.run\([^)]*\) /, '')
  const text = line || '(no message)'
  return text.length > REPORT_MAX ? `${text.slice(0, REPORT_MAX - 3)}...` : text
}

/** Starts the period. A tick that finds the last run unfinished is skipped and logged; the tick after it runs. */
export const startSyncRefresh = (deps: SyncDeps): { cancel: () => void } => {
  let stopped = false
  let period: { cancel: () => void } | null = null
  let busy = false

  const schedule = (): void => {
    if (stopped) return
    try {
      period = deps.after(SYNC_REFRESH_MS, onTick)
    } catch {
      // no timer: the next start sets it again
      period = null
    }
  }

  /** One start, or the reason it did not happen; a clean run answers null and logs nothing. */
  const attempt = async (): Promise<string | null> => {
    if (!(await deps.wanted())) return null
    const path = producerPath(await deps.configDir(), await deps.home())
    if (path === null) return 'sync-status: neither CLAUDE_CONFIG_DIR nor HOME is set, producer not started'
    if (!(await deps.exists(path))) return `sync-status: producer missing at ${path}`
    const res = await deps.run(producerArgv(path), { stdin: '{}', timeoutMs: SYNC_RUN_TIMEOUT_MS })
    return res.exitCode === 0 ? null : `sync-status: producer exited ${res.exitCode}: ${report(res)}`
  }

  const onTick = (): void => {
    // the next period is set first, so the cadence is the interval and not the interval plus the run
    schedule()
    if (busy) {
      deps.log(SKIPPED)
      return
    }
    busy = true
    attempt().then(
      text => {
        busy = false
        if (text !== null) deps.log(text)
      },
      err => {
        busy = false
        deps.log(`sync-status: producer run failed: ${runError(err)}`)
      },
    )
  }

  schedule()
  return {
    cancel: () => {
      stopped = true
      period?.cancel()
    },
  }
}
