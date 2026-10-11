// Test-only: what the engine (Claude Code 2.1.296) answered for the auto-compact window, one row per probe run.
// Each run gave a throwaway config dir, a loopback stub API and a scratch plugin that read `$.session.usage()` and
// `$.session.usage({ breakdown: 'summary' })`: `window` is the first's `context.window`, `want` / `engine` / `enabled`
// are the second's `rawMaxTokens` / `autocompactSource` / `isAutoCompactEnabled`. `model` is what `$.session.model()` said.
// register.tsx never imports this file, so the engine never loads it.

export type Observed = {
  id: string
  model: string
  window: number
  /** CLAUDE_CODE_AUTO_COMPACT_WINDOW as set for the run. */
  env?: string
  /** The settings file of each source the run had, as written. */
  user?: unknown
  project?: unknown
  local?: unknown
  flag?: unknown
  /** The engine's compaction window (`rawMaxTokens`). */
  want: number
  /** The engine's `autocompactSource`. */
  engine: string
  enabled: boolean
  /** Why the plugin does not mirror this row, and what it answers instead. */
  gap?: string
  mine?: number
}

export const OBSERVED: Observed[] = [
  {"id": "s00-plain", "model": "claude-opus-5-5", "window": 1000000, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s01-user-permodel-400k", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}, "autoCompactEnabled": true}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s02-user-top-300k", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 300000}, "want": 300000, "engine": "settings", "enabled": true},
  {"id": "s03-env-250k", "model": "claude-opus-5-5", "window": 1000000, "env": "250000", "want": 250000, "engine": "env", "enabled": true},
  {"id": "s04-env-250k-over-user-permodel-400k", "model": "claude-opus-5-5", "window": 1000000, "env": "250000", "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 250000, "engine": "env", "enabled": true},
  {"id": "s05-same-file-permodel-400k-top-300k", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}, "autoCompactWindow": 300000}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s06-user-top-300k-project-permodel-400k", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 300000}, "project": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s07-user-permodel-400k-project-top-300k", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "project": {"autoCompactWindow": 300000}, "want": 300000, "engine": "settings", "enabled": true},
  {"id": "s08-permodel-400k-plus-other-key-350k", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "project": {"modelSettings": {"claude-opus-5": {"autoCompactWindow": 350000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s09-prefix-key-only", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5": {"autoCompactWindow": 350000}}}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s10-permodel-auto", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": "auto"}}}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s11-user-400k-project-permodel-auto", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "project": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": "auto"}}}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s12-top-50000", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 50000}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s13-top-2000000", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 2000000}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s14-top-string", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": "400000"}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s15-top-float", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 400000.5}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s16-permodel-50000", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 50000}}}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s17-env-50000", "model": "claude-opus-5-5", "window": 1000000, "env": "50000", "want": 100000, "engine": "env", "enabled": true},
  {"id": "s18-env-2000000", "model": "claude-opus-5-5", "window": 1000000, "env": "2000000", "want": 1000000, "engine": "env", "enabled": true},
  {"id": "s19-env-abc-with-permodel-400k", "model": "claude-opus-5-5", "window": 1000000, "env": "abc", "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s20-env-400k-suffix", "model": "claude-opus-5-5", "window": 1000000, "env": "400k", "want": 100000, "engine": "env", "enabled": true},
  {"id": "s21-env-zero-with-permodel-400k", "model": "claude-opus-5-5", "window": 1000000, "env": "0", "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s22-env-empty-with-permodel-400k", "model": "claude-opus-5-5", "window": 1000000, "env": "", "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s23-model-1m-spelling", "model": "claude-opus-5-5[1m]", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s24-model-alias-opus", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s25-autocompact-disabled-permodel-400k", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}, "autoCompactEnabled": false}, "want": 1000000, "engine": "auto", "enabled": false},
  {"id": "s26-autocompact-disabled-env-250k", "model": "claude-opus-5-5", "window": 1000000, "env": "250000", "user": {"autoCompactEnabled": false}, "want": 250000, "engine": "env", "enabled": false},
  {"id": "s27-key-uppercase", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"Claude-Opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s28-key-alias-opus", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"opus": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true, "gap": "an alias key (opus, sonnet, haiku) is resolved by the engine to its current default model; not resolved here", "mine": 1000000},
  {"id": "s29-key-1m-spelling", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5[1m]": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s30-key-dated", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5-20260101": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s31-flag-top-300k", "model": "claude-opus-5-5", "window": 1000000, "flag": {"autoCompactWindow": 300000}, "want": 300000, "engine": "settings", "enabled": true},
  {"id": "s32-project-permodel-400k-local-top-300k", "model": "claude-opus-5-5", "window": 1000000, "project": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "local": {"autoCompactWindow": 300000}, "want": 300000, "engine": "settings", "enabled": true},
  {"id": "s33-flag-permodel-400k-user-top-300k", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 300000}, "flag": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s34-top-1000000", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 1000000}, "want": 1000000, "engine": "settings", "enabled": true},
  {"id": "s35-haiku-top-400k", "model": "claude-haiku-5-5", "window": 1000000, "user": {"autoCompactWindow": 400000}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s36-haiku-plain", "model": "claude-haiku-5-5", "window": 1000000, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s37-model-fable-5-1-permodel-400k", "model": "claude-fable-5-1", "window": 1000000, "user": {"modelSettings": {"claude-fable-5-1": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "e00-env-400000abc", "model": "claude-opus-5-5", "window": 1000000, "env": "400000abc", "want": 400000, "engine": "env", "enabled": true},
  {"id": "e01-env-300000", "model": "claude-opus-5-5", "window": 1000000, "env": " 300000", "want": 300000, "engine": "env", "enabled": true},
  {"id": "e02-env-4e5", "model": "claude-opus-5-5", "window": 1000000, "env": "4e5", "want": 400000, "engine": "env", "enabled": true},
  {"id": "e03-env-300000.9", "model": "claude-opus-5-5", "window": 1000000, "env": "300000.9", "want": 300000, "engine": "env", "enabled": true},
  {"id": "e04-env-plus300000", "model": "claude-opus-5-5", "window": 1000000, "env": "+300000", "want": 300000, "engine": "env", "enabled": true},
  {"id": "e05-env-0x30d40", "model": "claude-opus-5-5", "window": 1000000, "env": "0x30d40", "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "e06-env-300_000", "model": "claude-opus-5-5", "window": 1000000, "env": "300_000", "want": 300000, "engine": "env", "enabled": true},
  {"id": "e07-env-1e6", "model": "claude-opus-5-5", "window": 1000000, "env": "1e6", "want": 1000000, "engine": "env", "enabled": true},
  {"id": "e08-env-300000", "model": "claude-opus-5-5", "window": 1000000, "env": "300000 ", "want": 300000, "engine": "env", "enabled": true},
  {"id": "e09-env-neg300000", "model": "claude-opus-5-5", "window": 1000000, "env": "-300000", "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "e10-env-999999999999999999", "model": "claude-opus-5-5", "window": 1000000, "env": "999999999999999999", "want": 1000000, "engine": "env", "enabled": true},
  {"id": "s38-sonnet-4-5-plain", "model": "claude-sonnet-4-5", "window": 200000, "want": 200000, "engine": "auto", "enabled": true},
  {"id": "s39-sonnet-4-5-top-400k", "model": "claude-sonnet-4-5", "window": 200000, "user": {"autoCompactWindow": 400000}, "want": 200000, "engine": "settings", "enabled": true},
  {"id": "s40-sonnet-4-5-top-150k", "model": "claude-sonnet-4-5", "window": 200000, "user": {"autoCompactWindow": 150000}, "want": 150000, "engine": "settings", "enabled": true},
  {"id": "s41-opus-4-6-plain", "model": "claude-opus-4-6", "window": 200000, "want": 200000, "engine": "model-default", "enabled": true},
  {"id": "s42-sonnet-4-6-plain", "model": "claude-sonnet-4-6", "window": 200000, "want": 200000, "engine": "model-default", "enabled": true},
  {"id": "s43-sonnet-4-6-top-400k", "model": "claude-sonnet-4-6", "window": 200000, "user": {"autoCompactWindow": 400000}, "want": 200000, "engine": "settings", "enabled": true},
  {"id": "s44-user-permodel-400k-project-top-50000", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "project": {"autoCompactWindow": 50000}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s45-user-permodel-400k-project-top-auto", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "project": {"autoCompactWindow": "auto"}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s46-user-top-300k-project-permodel-auto", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 300000}, "project": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": "auto"}}}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s47-disable-auto-compact-env-permodel-400k", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 1000000, "engine": "auto", "enabled": false, "gap": "DISABLE_AUTO_COMPACT turns auto-compact off in the engine; that variable is not read here", "mine": 400000},
  {"id": "s48-disable-compact-env-permodel-400k", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 1000000, "engine": "auto", "enabled": false, "gap": "DISABLE_COMPACT turns auto-compact off in the engine; that variable is not read here", "mine": 400000},
  {"id": "s49-two-spellings-same-file", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5[1m]": {"autoCompactWindow": 300000}, "claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s50-model-1m-and-top-only", "model": "claude-opus-5-5[1m]", "window": 1000000, "user": {"autoCompactWindow": 300000}, "want": 300000, "engine": "settings", "enabled": true},
  {"id": "s51-permodel-extra-whitespace-key", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {" claude-opus-5-5 ": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "s52-permodel-entry-not-object", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": 400000}}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s53-modelsettings-array", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": [1, 2]}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "s54-permodel-400k-user-and-project-same-key-250k", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "project": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 250000}}}, "want": 250000, "engine": "settings", "enabled": true},
  {"id": "s55-clamp-env-250k-sonnet-4-5", "model": "claude-sonnet-4-5", "window": 200000, "env": "250000", "want": 200000, "engine": "env", "enabled": true},
  {"id": "s56-clamp-env-400k-sonnet-4-5", "model": "claude-sonnet-4-5", "window": 200000, "env": "400000", "want": 200000, "engine": "env", "enabled": true},
  {"id": "b00-top-99999", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 99999}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "b01-top-100000", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 100000}, "want": 100000, "engine": "settings", "enabled": true},
  {"id": "b02-top-1000001", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 1000001}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "b03-permodel-99999", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 99999}}}, "want": 1000000, "engine": "model-default", "enabled": true},
  {"id": "b04-permodel-100000", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 100000}}}, "want": 100000, "engine": "settings", "enabled": true},
  {"id": "b05-permodel-1000000", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 1000000}}}, "want": 1000000, "engine": "settings", "enabled": true},
  {"id": "b06-model-dated-spelling", "model": "claude-opus-5-5-20260101", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "b07-model-vertex-spelling", "model": "claude-opus-5-5@20260101", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "b08-key-vertex-spelling", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5@20260101": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "b09-key-bedrock-spelling", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"us.anthropic.claude-opus-5-5-20260101-v1:0": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "b10-key-1m-uppercase-ws", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {" Claude-Opus-5-5[1M] ": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "b11-model-bedrock-spelling", "model": "us.anthropic.claude-opus-5-5-20260101-v1:0", "window": 1000000, "user": {"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "b12-unknown-model-top-300k", "model": "claude-nonesuch-9", "window": 200000, "user": {"autoCompactWindow": 300000}, "want": 200000, "engine": "settings", "enabled": true},
  {"id": "b13-unknown-model-plain", "model": "claude-nonesuch-9", "window": 200000, "want": 200000, "engine": "unknown-model", "enabled": true},
  {"id": "b14-env-300000-unknown-model", "model": "claude-nonesuch-9", "window": 200000, "env": "300000", "want": 200000, "engine": "env", "enabled": true},
  {"id": "b15-autocompact-enabled-string", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactEnabled": "false", "autoCompactWindow": 300000}, "want": 1000000, "engine": "model-default", "enabled": true, "gap": "a non-boolean autoCompactEnabled voids the whole settings file in the engine; the other fields of the file still count here", "mine": 300000},
  {"id": "b16-enabled-false-in-lower-source-true-in-higher", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactEnabled": false, "autoCompactWindow": 300000}, "project": {"autoCompactEnabled": true}, "want": 300000, "engine": "settings", "enabled": true},
  {"id": "b17-enabled-true-lower-false-higher", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactEnabled": true, "autoCompactWindow": 300000}, "project": {"autoCompactEnabled": false}, "want": 1000000, "engine": "auto", "enabled": false},
  {"id": "c00-invalid-top-plus-valid-permodel", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 50000, "modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "c01-invalid-enabled-string-plus-valid-permodel", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactEnabled": "false", "modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 1000000, "engine": "model-default", "enabled": true, "gap": "same: the engine drops the file, the valid per-model entry still counts here", "mine": 400000},
  {"id": "c02-control-unknown-key-plus-permodel", "model": "claude-opus-5-5", "window": 1000000, "user": {"someUnknownKey": 1, "modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "c03-string-top-plus-valid-permodel", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": "300000", "modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "c04-invalid-permodel-entry-plus-valid-other-entry", "model": "claude-opus-5-5", "window": 1000000, "user": {"modelSettings": {"claude-opus-5": {"autoCompactWindow": "x"}, "claude-opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "c05-invalid-enabled-only-plus-top-300k-other-file", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactEnabled": "false"}, "project": {"autoCompactWindow": 300000}, "want": 300000, "engine": "settings", "enabled": true},
  {"id": "d00-key-uppercase-plus-top-300k-same-file", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 300000, "modelSettings": {"Claude-Opus-5-5": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
  {"id": "d01-key-1m-plus-top-300k-same-file", "model": "claude-opus-5-5", "window": 1000000, "user": {"autoCompactWindow": 300000, "modelSettings": {"claude-opus-5-5[1m]": {"autoCompactWindow": 400000}}}, "want": 400000, "engine": "settings", "enabled": true},
]
