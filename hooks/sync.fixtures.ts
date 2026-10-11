// Test-only: side file bytes for the sync-status kind, one string per line so every byte is visible.
// Hand-written from the plan's data shape (SCHEMA.md §9 `sync-status`, ticket #29); the hub section is the reference
// once it lands. Never regenerate them with a writer.

const text = (lines: string[]): string => lines.join('\n') + '\n'

const envelope = (over: Record<string, string>, data: string[] | null, status = 'ok', observed = '2026-10-10T11:59:30Z'): string[] => {
  const base: Record<string, string> = {
    schema_version: '1',
    kind: '"sync-status"',
    producer: '{ "id": "sync-status", "host": "wky" }',
    station: 'null',
    run_id: 'null',
    observed_at: `"${observed}"`,
    last_success_at: `"${observed}"`,
    collection_status: `"${status}"`,
    error: 'null',
    ...over,
  }
  const lines = ['{']
  const keys = Object.keys(base)
  keys.forEach(k => {
    lines.push(`  "${k}": ${base[k]},`) // data always follows, so every key but the last one is comma'd
  })
  if (data !== null) {
    lines.push('  "data": {')
    data.forEach((l, i) => lines.push(`    ${l}${i < data.length - 1 ? ',' : ''}`))
    lines.push('  }')
  } else {
    lines.push('  "data": null')
  }
  lines.push('}')
  return lines
}

const DATA_BEHIND = [
  '"branch": "sync-data-v2"',
  '"upstream": "origin/sync-data-v2"',
  '"ahead": 0',
  '"behind": 3',
  '"last_push_at": "2026-10-10T11:00:00Z"',
  '"last_fetch_at": "2026-10-10T11:50:00Z"',
]

const withData = (over: Record<string, string>): string[] =>
  DATA_BEHIND.map(line => {
    const key = line.slice(1, line.indexOf('"', 1))
    return key in over ? `"${key}": ${over[key]}` : line
  })

export const FILES: Record<string, string> = {
  // ok, behind 3, the fetch 10 minutes before the observation
  'sync-status.behind3.json': text(envelope({}, DATA_BEHIND)),
  // ok, diverged: 2 ahead, 3 behind
  'sync-status.diverged.json': text(envelope({}, withData({ ahead: '2' }))),
  // ok, in sync, but the last fetch is three days old
  'sync-status.insync-oldfetch.json': text(
    envelope({}, withData({ behind: '0', last_fetch_at: '"2026-10-07T11:00:00Z"' })),
  ),
  // ok, never pushed and never fetched on this machine
  'sync-status.nulls.json': text(envelope({}, withData({ behind: '0', last_push_at: 'null', last_fetch_at: 'null' }))),
  // failed: wrong branch, the last good read is kept
  'sync-status.failed.json': text(
    envelope(
      {
        collection_status: '"failed"',
        last_success_at: '"2026-10-10T11:00:00Z"',
        error: '{ "code": "wrong_branch", "message": "HEAD is on main; expected sync-data-v2" }',
      },
      null,
      'failed',
    ),
  ),
  // stale past 900 s, with a poison value that must never reach the card
  'sync-status.stale.json': text(envelope({ observed_at: '"2026-10-10T11:30:00Z"', last_success_at: '"2026-10-10T11:30:00Z"' }, withData({ behind: '99' }))),
  // a count written as 2.0 is a malformed literal even though JSON.parse reads it as 2
  'sync-status.malformed-float.json': text(envelope({}, withData({ ahead: '2.0' }))),
  // a stamp that does not exist on the calendar
  'sync-status.malformed-stamp.json': text(envelope({}, withData({ last_push_at: '"2026-02-30T00:00:00Z"' }))),
}

export const REF_NOW_MS = Date.parse('2026-10-10T12:00:00Z')
