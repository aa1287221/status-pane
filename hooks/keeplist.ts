// Pure decisions and builders for the session.compact keep-list. No `$`, no clock, no env.
import { fmtClock } from './model'
import type { KeepLast, KeepState, KeepTrigger, KeptFiles } from './state'

/** First line of the block, and how a hook that meets it again knows the instructions already carry the list. */
export const KEEP_MARK = 'Keep these through the summary (copied from the session):'
/** The block is at most this many UTF-16 units: the person's own /compact text keeps the rest of the room. */
export const KEEP_CAP = 1500
/** The hook gives up on its own work after this long; the engine's 10 s hook budget does not count the time a `$` call takes. */
export const KEEP_DEADLINE_MS = 4000
export const TASKS_MAX = 15
/** Output paths recorded per session, and how many of the newest are checked and listed at a compaction. */
export const FILES_KEPT = 20
export const FILES_LISTED = 10
export const HANDOFFS_MAX = 5
export const SUBJECT_MAX = 100
export const PATH_MAX = 400
/** Task files read per compaction, and the largest one read; a task file is a few hundred bytes. */
export const TASK_FILES_MAX = 200
export const TASK_BYTES_MAX = 65_536

export type KeepMode = 'observe' | 'on' | 'off'
export type KeepConfig = { mode: KeepMode; precompute: 'skip' | 'rewrite' }
export type TaskItem = { id: string; subject: string; status: 'pending' | 'in_progress' }
/** A task file that is not kept; `problem` says whether that is worth telling (a finished task is not). */
export type TaskDrop = { drop: string; problem: boolean }
export type KeepSrc = { tasks: readonly TaskItem[]; moreTasks?: number; files: readonly string[]; handoffs: readonly string[] }
export type Built = { text: string; counts: { tasks: number; files: number; handoffs: number }; dropped: number }
export type Decision = { action: 'pass' | 'rewrite' | 'skip'; why: string; would: 'rewrite' | 'skip' | null }
export type DecideIn = { trigger: string; agentId: string | undefined; cfg: KeepConfig; hasMark: boolean; hasKeep: boolean }
export type TaskEnv = { CLAUDE_CONFIG_DIR?: string | undefined; HOME?: string | undefined; CLAUDE_CODE_TASK_LIST_ID?: string | undefined }

/** Only `1` rewrites and only `0` bypasses; the policy for a precompute is skip unless it says `rewrite`. Not trimmed, not case-folded. */
export const keepConfig = (modeRaw: string | undefined, precomputeRaw: string | undefined): KeepConfig => ({
  mode: modeRaw === '1' ? 'on' : modeRaw === '0' ? 'off' : 'observe',
  precompute: precomputeRaw === 'rewrite' ? 'rewrite' : 'skip',
})

// Code points that draw nothing or move the line: controls (C0, DEL, C1), the soft hyphen, bidi marks, embeddings and
// isolates, line and paragraph separators, zero-width and invisible operators, the BOM, annotation anchors, and the
// tag and variation-selector planes that can carry text no one sees. The joiners (U+200C, U+200D) stay: emoji and
// several scripts need them.
const HIDDEN: readonly (readonly [number, number])[] = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200b], [0x200e, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
]
const isHidden = (cp: number): boolean => HIDDEN.some(([lo, hi]) => cp >= lo && cp <= hi)
const SPACE = /\s/

/** One line of visible text: hidden characters and runs of blanks become one space, trimmed, at most `maxPoints` code points. */
export const sanitize = (text: string, maxPoints: number): string => {
  if (typeof text !== 'string') return ''
  const out: string[] = []
  let gap = false
  for (const ch of text) {
    if (isHidden(ch.codePointAt(0) ?? 0) || SPACE.test(ch)) {
      gap = out.length > 0
      continue
    }
    if (gap) out.push(' ')
    gap = false
    out.push(ch)
    if (out.length > maxPoints) break
  }
  return out.slice(0, maxPoints).join('').trimEnd()
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const quiet = (drop: string): TaskDrop => ({ drop, problem: false })
const loud = (drop: string): TaskDrop => ({ drop, problem: true })

/** A task file's text as a kept task; the id is text, the subject one clean line. Anything else says why it is not kept. */
export const parseTaskFile = (text: string): TaskItem | TaskDrop => {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return loud('not JSON')
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return loud('not a JSON object')
  const r = v as Record<string, unknown>
  const status = r.status
  if (status === 'completed' || status === 'deleted') return quiet(`status ${status}`)
  if (status !== 'pending' && status !== 'in_progress') return loud(`status ${typeof status === 'string' ? sanitize(status, 20) : typeof status}`)
  const raw = r.id
  const id = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? String(raw) : typeof raw === 'string' ? raw : ''
  if (!ID_RE.test(id)) return loud('no usable id')
  if (typeof r.subject !== 'string') return loud('no subject')
  const subject = sanitize(r.subject, SUBJECT_MAX)
  if (subject === '') return loud('empty subject')
  return { id, subject, status }
}

const NUMERIC = /^\d+$/
const rankOf = (t: TaskItem): number => (t.status === 'in_progress' ? 0 : 1)

/** Numbers by value (9 before 10), a name that is not a number after them. */
const byId = (a: string, b: string): number => {
  const an = NUMERIC.test(a)
  const bn = NUMERIC.test(b)
  if (an !== bn) return an ? -1 : 1
  const d = an ? Number(a) - Number(b) : 0
  return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0
}

/** In-progress tasks first, then pending; by id within each; at most TASKS_MAX, with the number left out. */
export const tasksOf = (items: readonly TaskItem[]): { items: TaskItem[]; more: number } => {
  const open = items.filter(t => t.status === 'pending' || t.status === 'in_progress').sort((x, y) => rankOf(x) - rankOf(y) || byId(x.id, y.id))
  return { items: open.slice(0, TASKS_MAX), more: Math.max(0, open.length - TASKS_MAX) }
}

/** The path a tool call names: `file_path` for Write, Edit and Read, `notebook_path` for NotebookEdit; nothing for another tool. */
export const callPath = (tool: string, input: Record<string, unknown>): unknown => {
  if (typeof input !== 'object' || input === null) return undefined
  if (tool === 'Write' || tool === 'Edit' || tool === 'Read') return input.file_path
  if (tool === 'NotebookEdit') return input.notebook_path
  return undefined
}

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/
const SKIPPED_DIR = /[\\/](?:node_modules|\.git)[\\/]/
const HANDOFF = /^handoff-.+\.md$/

const pathOk = (path: unknown): path is string => {
  if (typeof path !== 'string' || path.length === 0 || path.length > PATH_MAX) return false
  if (!ABSOLUTE.test(path) || SKIPPED_DIR.test(path)) return false
  for (const ch of path) if (isHidden(ch.codePointAt(0) ?? 0)) return false
  return true
}
const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/**
 * What a tool call that went through adds to the session's record: Write, Edit and NotebookEdit add their path
 * to the files, a handoff-<name>.md also to the handoffs, and a Read of one only to the handoffs. null when the
 * call adds nothing. Newest first, once each; another session id starts over.
 */
export const recordPath = (prev: KeptFiles | null, sid: string, tool: string, path: unknown): KeptFiles | null => {
  const writes = tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit'
  if (!writes && tool !== 'Read') return null
  if (!pathOk(path)) return null
  const handoff = HANDOFF.test(baseName(path))
  if (!writes && !handoff) return null
  const base: KeptFiles = prev && prev.sid === sid ? prev : { sid, files: [], handoffs: [] }
  const front = (list: readonly string[], max: number): string[] => [path, ...list.filter(p => p !== path)].slice(0, max)
  return { sid, files: writes ? front(base.files, FILES_KEPT) : [...base.files], handoffs: handoff ? front(base.handoffs, HANDOFFS_MAX) : [...base.handoffs] }
}

const TITLES = { tasks: 'Open tasks:', handoffs: 'Handoff files to re-read:', files: 'Files written or edited (newest first):' } as const

/**
 * The block: tasks, handoffs, files, each under its title, as whole lines within KEEP_CAP. What does not fit goes from the
 * end, so files go first and tasks last, and a last line counts it. null when there is nothing to keep.
 */
export const buildKeep = (src: KeepSrc): Built | null => {
  const handoffs = [...src.handoffs]
  // a handoff that was also written is named once, as a handoff
  const files = src.files.filter(p => !handoffs.includes(p))
  const sections = [
    { title: TITLES.tasks, lines: src.tasks.map(t => `- #${t.id} [${t.status}] ${t.subject}`) },
    { title: TITLES.handoffs, lines: handoffs.map(p => `- ${p}`) },
    { title: TITLES.files, lines: files.map(p => `- ${p}`) },
  ]
  const kept = sections.map(s => s.lines.length)
  let cut = Math.max(0, src.moreTasks ?? 0)
  const render = (): string => {
    const lines = [KEEP_MARK]
    sections.forEach((s, i) => {
      if ((kept[i] ?? 0) > 0) lines.push(s.title, ...s.lines.slice(0, kept[i]))
    })
    if (cut > 0) lines.push(`(+${cut} more)`)
    return lines.join('\n')
  }
  let text = render()
  while (text.length > KEEP_CAP) {
    let i = sections.length - 1
    while (i >= 0 && kept[i] === 0) i--
    if (i < 0) break
    kept[i] = (kept[i] ?? 0) - 1
    cut++
    text = render()
  }
  if (kept.every(k => k === 0)) return null
  return { text, counts: { tasks: kept[0] ?? 0, handoffs: kept[1] ?? 0, files: kept[2] ?? 0 }, dropped: cut }
}

/** The person's own text first and untouched, a blank line, the block; instructions that already carry the block come back as they are. */
export const withKeep = (userInstr: string | null | undefined, keepText: string): string => {
  const user = typeof userInstr === 'string' ? userInstr : ''
  if (user.includes(KEEP_MARK)) return user
  return user.trim() === '' ? keepText : `${user}\n\n${keepText}`
}

const TRIGGERS: readonly string[] = ['manual', 'auto', 'plugin', 'precompute']
const SKIP_WHY = 'status-pane keep-list: a precomputed summary would freeze the list'

/**
 * What the hook does with one compaction. `hasKeep` says whether the sources hold anything; a skip needs no sources,
 * so a caller may ask once with `true` to learn whether it must read them at all (`action` rewrite, or `would` rewrite).
 */
export const decideCompact = (i: DecideIn): Decision => {
  const pass = (why: string, would: Decision['would'] = null): Decision => ({ action: 'pass', why, would })
  if (i.cfg.mode === 'off') return pass('off')
  if (!TRIGGERS.includes(i.trigger)) return pass('trigger')
  if (i.agentId !== undefined) return pass('subagent')
  if (i.hasMark) return pass('marked')
  if (i.trigger === 'precompute' && i.cfg.precompute === 'skip') return i.cfg.mode === 'on' ? { action: 'skip', why: SKIP_WHY, would: null } : pass('observe', 'skip')
  if (!i.hasKeep) return pass('empty')
  return i.cfg.mode === 'on' ? { action: 'rewrite', why: 'keep', would: null } : pass('observe', 'rewrite')
}

const trimSlashes = (p: string): string => p.replace(/\/+$/, '')
const OUTSIDE_NAME = /[^A-Za-z0-9_-]/g

/**
 * Where the engine keeps the session's task files (read from the 2.1.296 bundle): `<config dir>/tasks/<list id>`, the list id
 * being CLAUDE_CODE_TASK_LIST_ID, else the session id with its dashes, every character outside [A-Za-z0-9_-] a dash.
 * A team's or a resumed list's id is not visible to a plugin.
 */
export const taskDirOf = (env: TaskEnv, sessionId: string): { dir: string } | { why: string } => {
  const base = env.CLAUDE_CONFIG_DIR ? trimSlashes(env.CLAUDE_CONFIG_DIR) : env.HOME ? `${trimSlashes(env.HOME)}/.claude` : ''
  if (base === '') return { why: 'neither CLAUDE_CONFIG_DIR nor HOME is set' }
  const named = env.CLAUDE_CODE_TASK_LIST_ID ? env.CLAUDE_CODE_TASK_LIST_ID : sessionId
  if (!named) return { why: 'no session id to name the task list by' }
  return { dir: `${base}/tasks/${named.replace(OUTSIDE_NAME, '-')}` }
}

/** The state after one more compaction: counted under its trigger, the count starting over for another session. */
export const nextKeepState = (prev: KeepState | null, i: { sid: string; cfg: KeepConfig; trigger: KeepTrigger; last: KeepLast }): KeepState => {
  const seen = prev && prev.sid === i.sid ? prev.seen : { manual: 0, auto: 0, plugin: 0, precompute: 0 }
  return { sid: i.sid, mode: i.cfg.mode, precompute: i.cfg.precompute, seen: { ...seen, [i.trigger]: seen[i.trigger] + 1 }, last: i.last }
}

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`

/** The value of the card's `keep` row. */
export const keepLabel = (s: KeepState): string => {
  const l = s.last
  if (l === null) return s.mode
  if (l.action === 'skip') return `${s.mode} · ${l.trigger} skipped`
  const what =
    l.action === 'rewrite'
      ? `injected ${l.chars} chars`
      : l.why === 'empty'
        ? 'nothing to keep'
        : l.would === 'skip'
          ? 'would skip'
          : `${plural(l.counts.tasks, 'task')} ${plural(l.counts.files, 'file')} ${plural(l.counts.handoffs, 'handoff')}`
  return [s.mode, l.trigger, what, ...(l.problems.length > 0 ? [plural(l.problems.length, 'problem')] : [])].join(' · ')
}

/** The answer of `/keeplist`: the switches in force, what was seen, the last decision, each source in words, and the block itself. */
export const keepReport = (s: KeepState | null, cfg: KeepConfig): string => {
  const row = (label: string, value: string): string => `${label.padEnd(10)}${value}`
  const head = row('keep-list', `${cfg.mode}  precompute ${cfg.precompute}`)
  const l = s?.last ?? null
  if (s === null || l === null) return [head, row('seen', 'no compaction seen')].join('\n')
  const seen = (['manual', 'auto', 'plugin', 'precompute'] as const).map(t => `${t} ${s.seen[t]}`).join(' · ')
  const detail = l.action === 'pass' && l.would !== null ? `${l.why}, would ${l.would}` : l.why
  const counts = [plural(l.counts.tasks, 'task'), plural(l.counts.files, 'file'), plural(l.counts.handoffs, 'handoff'), `${l.dropped} cut`, `${l.gone} gone`, `${l.chars} chars`].join(' · ')
  const problems = l.problems.length === 0 ? [row('problems', 'none')] : l.problems.map((p, i) => row(i === 0 ? 'problems' : '', p))
  return [
    head,
    row('seen', seen),
    row('last', `${fmtClock(l.at, undefined, true)} ${l.trigger} → ${l.action} (${detail})`),
    row('counts', counts),
    row('tasks', l.sources.tasks),
    row('handoffs', l.sources.handoffs),
    row('files', l.sources.files),
    ...problems,
    '',
    l.text === '' ? '(no block was built)' : l.text,
  ].join('\n')
}
