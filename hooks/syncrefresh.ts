// Red-phase stub for #91: the signatures are final, the behaviour is not written yet.

export const SYNC_REFRESH_MS = 0
export const SYNC_RUN_TIMEOUT_MS = 0

export type SyncRunInit = { stdin: string; timeoutMs: number }
export type SyncRunResult = { exitCode: number; stdout: string; stderr: string }

export type SyncDeps = {
  after: (ms: number, fn: () => void) => { cancel: () => void }
  wanted: () => Promise<boolean>
  configDir: () => Promise<string | undefined>
  home: () => Promise<string | undefined>
  exists: (path: string) => Promise<boolean>
  run: (argv: string[], init: SyncRunInit) => Promise<SyncRunResult>
  log: (text: string) => void
}

export const producerPath = (_configDir: string | undefined, _home: string | undefined): string | null => null

export const producerArgv = (_path: string): string[] => []

export const startSyncRefresh = (_deps: SyncDeps): { cancel: () => void } => ({ cancel: () => {} })
