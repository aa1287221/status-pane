import { describe, expect, test } from 'claude-code/testing'

import {
  buildKeep,
  callPath,
  decideCompact,
  keepConfig,
  keepLabel,
  keepReport,
  nextKeepState,
  parseTaskFile,
  recordPath,
  sanitize,
  taskDirOf,
  tasksOf,
  withKeep,
} from './keeplist'
import type { KeepConfig, TaskItem } from './keeplist'
import type { KeepLast, KeepState, KeepTrigger, KeptFiles } from './state'

// S1 for the session.compact keep-list: the pure rows first (this file, top), the engine rows below.
const SID_FULL = 'c07353bf-22c4-47df-8296-6f2dd4b68497'
// the contract's own numbers and words, spelled out here: a test that imported them would pass whatever they were changed to
const MARK = 'Keep these through the summary (copied from the session):'
const CAP = 1500
const SUBJECT_CAP = 100
const PATH_CAP = 400
const TASKS_CAP = 15
const FILES_CAP = 20
const HANDOFFS_CAP = 5
const cp = (...codes: number[]): string => String.fromCodePoint(...codes)
const LS = cp(0x2028)
const RLO = cp(0x202e)
const NUL = cp(0)
const NEL = cp(0x85)
const task = (id: string, status: TaskItem['status'] = 'pending', subject = `task ${id}`): TaskItem => ({ id, status, subject })
const taskFile = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: '1', subject: 'S', description: 'd', activeForm: 'a', status: 'pending', blocks: [], blockedBy: [], ...over })
const cfgOf = (mode: KeepConfig['mode'], precompute: KeepConfig['precompute'] = 'skip'): KeepConfig => ({ mode, precompute })

describe('keep-list: configuration', () => {
  // 31-1: only "1" rewrites and only "0" bypasses; the policy is skip unless it says rewrite
  test('"1" is on, "0" is off, everything else observes', () => {
    const mode = (v: string | undefined) => keepConfig(v, undefined).mode
    expect(mode('1')).toBe('on')
    expect(mode('0')).toBe('off')
    expect([undefined, '', 'x', '2', 'true', ' 1 ', '01', 'on', '1.0'].map(mode)).toEqual(Array(9).fill('observe'))
  })

  test('the precompute policy is rewrite only for "rewrite"; anything else skips', () => {
    const policy = (v: string | undefined) => keepConfig(undefined, v).precompute
    expect(policy('rewrite')).toBe('rewrite')
    expect([undefined, '', 'skip', 'Rewrite', ' rewrite', '1', 'yes'].map(policy)).toEqual(Array(7).fill('skip'))
  })

  test('input that is not a string is the default, never a throw', () => {
    for (const v of [null, 5, {}, [], true, Symbol.iterator]) expect(keepConfig(v as never, v as never)).toEqual({ mode: 'observe', precompute: 'skip' })
  })
})

describe('keep-list: task files', () => {
  // 31-2: pending and in_progress are kept, with the id as text and the subject cleaned
  test('a pending and an in_progress task are kept; a numeric id becomes text', () => {
    expect(parseTaskFile(taskFile({ id: '3', subject: 'Write the parser', status: 'in_progress' }))).toEqual({ id: '3', subject: 'Write the parser', status: 'in_progress' })
    expect(parseTaskFile(taskFile({ id: 7, subject: 'Add the tests' }))).toEqual({ id: '7', subject: 'Add the tests', status: 'pending' })
  })

  test('the subject is cleaned on the way in', () => {
    expect(parseTaskFile(taskFile({ subject: `a\nb${LS}c${RLO}d` }))).toMatchObject({ subject: 'a b c d' })
  })

  test('a finished or deleted task is dropped quietly; every other drop says why and is a problem', () => {
    const drop = (text: string) => parseTaskFile(text) as { drop: string; problem: boolean }
    for (const status of ['completed', 'deleted']) expect(drop(taskFile({ status }))).toMatchObject({ problem: false, drop: expect.stringContaining(status) })
    const odd = [
      taskFile({ status: 'blocked' }),
      taskFile({ status: undefined }),
      taskFile({ subject: undefined }),
      taskFile({ subject: 5 }),
      taskFile({ subject: `${NUL}${LS} ` }),
      taskFile({ id: null }),
      taskFile({ id: {} }),
      taskFile({ id: true }),
      taskFile({ id: undefined }),
      taskFile({ id: '../x' }),
      taskFile({ id: -1 }),
      taskFile({ id: 1.5 }),
      '{not json',
      '',
      '[]',
      'null',
      '42',
      '"str"',
    ]
    for (const text of odd) {
      const got = drop(text)
      expect([text, typeof got.drop, got.drop.length > 0, got.problem]).toEqual([text, 'string', true, true])
    }
  })

  test('hostile keys change nothing the reader sees', () => {
    const proto = '{"__proto__":{"status":"pending","subject":"x","id":"9"}}'
    expect(parseTaskFile(proto)).toMatchObject({ problem: true })
    expect(({} as Record<string, unknown>).status).toBeUndefined()
  })
})

describe('keep-list: cleaning and order', () => {
  // 31-3: one line, no hidden characters, cut on a code point
  test('line breaks, controls, C1 and bidi controls become one space', () => {
    for (const bad of ['\n', '\r', '\r\n', '\t', LS, RLO, NUL, NEL, cp(0x7f), cp(0x200b), cp(0xfeff), cp(0x2066)]) {
      expect([bad.length, sanitize(`a${bad}b`, SUBJECT_CAP)]).toEqual([bad.length, 'a b'])
    }
    expect(sanitize(`  a \n\r\n  ${NUL}${RLO} b  `, SUBJECT_CAP)).toBe('a b')
    expect(sanitize(`${NUL}${LS}`, SUBJECT_CAP)).toBe('')
  })

  test('the cap counts code points: an emoji is never cut in two', () => {
    const emoji = cp(0x1f600)
    const long = emoji.repeat(150)
    const out = sanitize(long, SUBJECT_CAP)
    expect([...out]).toHaveLength(SUBJECT_CAP)
    expect(out.length).toBe(2 * SUBJECT_CAP)
    expect([...out].every(c => c === emoji)).toBe(true)
    expect(sanitize(`x${emoji.repeat(10)}`, 3)).toBe(`x${emoji}${emoji}`)
    expect(sanitize('abcdef', 4)).toBe('abcd')
    expect(sanitize('abc def', 4)).toBe('abc')
  })

  test('in_progress before pending, then by number (9 before 10), a non-number last; at most 15, the rest counted', () => {
    const items = [task('10'), task('12', 'in_progress'), task('2'), task('a'), task('9', 'in_progress')]
    expect(tasksOf(items).items.map(t => t.id)).toEqual(['9', '12', '2', '10', 'a'])
    expect(tasksOf(items).more).toBe(0)
    const many = Array.from({ length: 20 }, (_, i) => task(String(i + 1)))
    const capped = tasksOf(many)
    expect(capped.items.map(t => t.id)).toEqual(many.slice(0, TASKS_CAP).map(t => t.id))
    expect(capped.more).toBe(20 - TASKS_CAP)
  })

  test('the input is left as it was', () => {
    const items = Object.freeze([task('3'), task('1', 'in_progress')])
    expect(() => tasksOf(items)).not.toThrow()
    expect(items.map(t => t.id)).toEqual(['3', '1'])
  })
})

describe('keep-list: recorded paths', () => {
  const rec = (prev: KeptFiles | null, tool: string, path: unknown, sid = 'sidA') => recordPath(prev, sid, tool, path)
  const NEW: KeptFiles = { sid: 'sidA', files: [], handoffs: [] }

  // 31-4: Write, Edit and NotebookEdit paths, newest first
  test('Write, Edit and NotebookEdit record an absolute path, newest first, once', () => {
    let s: KeptFiles | null = rec(null, 'Write', '/p/a.ts')
    s = rec(s, 'Edit', '/p/b.ts')
    s = rec(s, 'NotebookEdit', '/p/c.ipynb')
    expect(s).toEqual({ sid: 'sidA', files: ['/p/c.ipynb', '/p/b.ts', '/p/a.ts'], handoffs: [] })
    s = rec(s, 'Edit', '/p/a.ts')
    expect(s?.files).toEqual(['/p/a.ts', '/p/c.ipynb', '/p/b.ts'])
  })

  test('a path that is not absolute, not text, too long, hidden or in node_modules or .git records nothing', () => {
    const ignored = [
      'a.ts',
      './a.ts',
      '',
      '/p/a\nb.ts',
      `/p/a${RLO}b.ts`,
      `/p/a${NUL}b.ts`,
      `/${'x'.repeat(PATH_CAP)}`,
      '/p/node_modules/x/index.js',
      '/p/.git/config',
      undefined,
      null,
      5,
      {},
      ['/p/a.ts'],
    ]
    for (const path of ignored) expect([path, rec(NEW, 'Write', path)]).toEqual([path, null])
    expect(rec(NEW, 'Write', `/${'x'.repeat(PATH_CAP - 1)}`)?.files).toHaveLength(1)
    for (const near of ['/p/.gitignore', '/p/node_modules_old/a.js', '/p/my.git/config', '/p/.github/ci.yml']) expect(rec(NEW, 'Edit', near)?.files).toEqual([near])
  })

  test('only Write, Edit and NotebookEdit record an output; no other tool does', () => {
    for (const tool of ['Bash', 'Read', 'Grep', 'Glob', 'MultiEdit', 'write', '', 'Agent']) expect([tool, rec(NEW, tool, '/p/a.ts')]).toEqual([tool, null])
  })

  test('at most 20 files are kept, the newest', () => {
    let s: KeptFiles | null = null
    for (let i = 1; i <= 25; i++) s = rec(s, 'Write', `/p/f${i}.ts`)
    expect(s?.files).toHaveLength(FILES_CAP)
    expect(s?.files[0]).toBe('/p/f25.ts')
    expect(s?.files.at(-1)).toBe('/p/f6.ts')
  })

  test('another session id starts over, and the old record is not touched', () => {
    const before = rec(null, 'Write', '/p/a.ts', 'sidA')!
    const snapshot = JSON.stringify(before)
    const next = rec(before, 'Write', '/p/b.ts', 'sidB')
    expect(next).toEqual({ sid: 'sidB', files: ['/p/b.ts'], handoffs: [] })
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  // 31-5: a handoff is a file named handoff-<something>.md this session wrote or read
  test('a handoff file that is written is a handoff and a file; one that is read is a handoff only', () => {
    expect(rec(null, 'Write', '/m/handoff-foo.md')).toEqual({ sid: 'sidA', files: ['/m/handoff-foo.md'], handoffs: ['/m/handoff-foo.md'] })
    expect(rec(null, 'Read', '/m/handoff-foo.md')).toEqual({ sid: 'sidA', files: [], handoffs: ['/m/handoff-foo.md'] })
    expect(rec(null, 'Read', '/m/notes.md')).toBeNull()
    expect(rec(null, 'Read', '/p/a.ts')).toBeNull()
  })

  test('only handoff-<name>.md is a handoff', () => {
    for (const name of ['handoff-notes.txt', 'my-handoff-x.md', 'handoff-.md', 'handoff.md', 'handoff-x.md.bak', 'handoff-x.mdx']) {
      expect([name, rec(null, 'Read', `/m/${name}`)]).toEqual([name, null])
    }
    expect(rec(null, 'Read', '/m/handoff/foo.md')).toBeNull()
    expect(rec(null, 'Read', '/m/handoff-x.md/y')).toBeNull()
    expect(rec(null, 'Read', '/m/handoff-2026-10-12 a.md')?.handoffs).toEqual(['/m/handoff-2026-10-12 a.md'])
  })

  test('at most 5 handoffs, the newest, once each', () => {
    let s: KeptFiles | null = null
    for (let i = 1; i <= 7; i++) s = rec(s, 'Read', `/m/handoff-${i}.md`)
    expect(s?.handoffs).toEqual([7, 6, 5, 4, 3].map(i => `/m/handoff-${i}.md`))
    expect(s?.handoffs).toHaveLength(HANDOFFS_CAP)
    s = rec(s, 'Read', '/m/handoff-5.md')
    expect(s?.handoffs[0]).toBe('/m/handoff-5.md')
    expect(new Set(s?.handoffs).size).toBe(HANDOFFS_CAP)
  })

  test('the path of a call is the one key its tool names', () => {
    expect(callPath('Write', { file_path: '/a' })).toBe('/a')
    expect(callPath('Edit', { file_path: '/b', notebook_path: '/x' })).toBe('/b')
    expect(callPath('Read', { file_path: '/c' })).toBe('/c')
    expect(callPath('NotebookEdit', { notebook_path: '/n.ipynb', file_path: '/x' })).toBe('/n.ipynb')
    expect(callPath('NotebookEdit', { file_path: '/x' })).toBeUndefined()
    expect(callPath('Bash', { file_path: '/a', command: 'x' })).toBeUndefined()
    expect(callPath('Write', {})).toBeUndefined()
  })
})

describe('keep-list: the block', () => {
  const BLOCK = `${MARK}\nOpen tasks:\n- #1 [pending] a task`

  // 31-6: the user's own text stays first and untouched
  test('the user text is first and byte for byte, a blank line, then the block', () => {
    expect(withKeep('CMD-TEXT', BLOCK)).toBe(`CMD-TEXT\n\n${BLOCK}`)
    const odd = '  keep  this \t as is '
    expect(withKeep(odd, BLOCK).startsWith(`${odd}\n\n`)).toBe(true)
    expect(withKeep(odd, BLOCK).endsWith(BLOCK)).toBe(true)
  })

  test('no user text, or only blanks, or not text: the block alone, with no leading newline and no "undefined"', () => {
    for (const none of [undefined, null, '', ' ', '\n\t  \n', 5, {}]) expect([none, withKeep(none as never, BLOCK)]).toEqual([none, BLOCK])
  })

  test('instructions that already carry the block come back as they are', () => {
    const once = withKeep('CMD', BLOCK)
    expect(withKeep(once, BLOCK)).toBe(once)
    expect(withKeep(`x ${MARK} y`, BLOCK)).toBe(`x ${MARK} y`)
  })

  test('the result is at most the user text, the block and a blank line', () => {
    const user = 'u'.repeat(3000)
    const block = `${MARK}\n${'k'.repeat(CAP - MARK.length - 1)}`
    expect(block.length).toBe(CAP)
    expect(withKeep(user, block).length).toBe(user.length + CAP + 2)
  })

  // 31-7: three sections, whole items, a character budget
  test('tasks, handoffs and files, in that order, each under its title', () => {
    const got = buildKeep({
      tasks: [task('3', 'in_progress', 'Write the parser'), task('4', 'pending', 'Add the tests')],
      files: ['/p/a.ts', '/p/b.ts'],
      handoffs: ['/m/handoff-a.md'],
    })
    expect(got?.text).toBe(
      [
        MARK,
        'Open tasks:',
        '- #3 [in_progress] Write the parser',
        '- #4 [pending] Add the tests',
        'Handoff files to re-read:',
        '- /m/handoff-a.md',
        'Files written or edited (newest first):',
        '- /p/a.ts',
        '- /p/b.ts',
      ].join('\n'),
    )
    expect(got).toMatchObject({ counts: { tasks: 2, files: 2, handoffs: 1 }, dropped: 0 })
  })

  test('nothing to keep is null, not a header with no items', () => {
    expect(buildKeep({ tasks: [], files: [], handoffs: [] })).toBeNull()
  })

  test('a section with no items has no title', () => {
    expect(buildKeep({ tasks: [], files: [], handoffs: ['/m/handoff-a.md'] })?.text).toBe(`${MARK}\nHandoff files to re-read:\n- /m/handoff-a.md`)
    expect(buildKeep({ tasks: [task('1')], files: ['/p/a.ts'], handoffs: [] })?.text).not.toContain('Handoff')
  })

  test('a handoff that was also written is listed once, as a handoff', () => {
    const got = buildKeep({ tasks: [], files: ['/m/handoff-a.md', '/p/a.ts'], handoffs: ['/m/handoff-a.md'] })
    expect(got?.text.split('\n').filter(l => l === '- /m/handoff-a.md')).toHaveLength(1)
    expect(got?.counts).toEqual({ tasks: 0, files: 1, handoffs: 1 })
  })

  test('tasks the caller could not fit are counted in the last line', () => {
    const got = buildKeep({ tasks: [task('1')], moreTasks: 5, files: [], handoffs: [] })
    expect(got?.text.split('\n').at(-1)).toBe('(+5 more)')
    expect(got?.dropped).toBe(5)
  })

  test('over the budget, whole items go from the end (files first), the last line counts them, no line is cut', () => {
    const tasks = Array.from({ length: 6 }, (_, i) => task(String(i + 1), 'pending', `subject number ${i + 1} ${'t'.repeat(80)}`))
    const handoffs = ['/m/handoff-a.md', '/m/handoff-b.md']
    const files = Array.from({ length: 10 }, (_, i) => `/p/dir${i}/${'f'.repeat(120)}${i}.ts`)
    const built = buildKeep({ tasks, files, handoffs })
    expect(built).not.toBeNull()
    const got = built!
    const lines = got.text.split('\n')
    expect(got.text.length).toBeLessThanOrEqual(CAP)
    expect(lines.at(-1)).toMatch(/^\(\+\d+ more\)$/)
    const wholeLines = new Set([MARK, 'Open tasks:', 'Handoff files to re-read:', 'Files written or edited (newest first):'])
    for (const t of tasks) wholeLines.add(`- #${t.id} [${t.status}] ${t.subject}`)
    for (const p of [...handoffs, ...files]) wholeLines.add(`- ${p}`)
    for (const line of lines.slice(0, -1)) expect([line, wholeLines.has(line)]).toEqual([line, true])
    // the tasks and the handoffs outrank the files
    expect(got.counts.tasks).toBe(6)
    expect(got.counts.handoffs).toBe(2)
    expect(got.counts.files).toBeLessThan(10)
    expect(got.dropped).toBe(10 - got.counts.files)
    expect(lines.at(-1)).toBe(`(+${got.dropped} more)`)
  })

  test('the cut is exact: the most items that fit are kept, one more is not', () => {
    const subject = (i: number) => `item ${i} ${'x'.repeat(40)}`
    const more = (cut: number) => (cut > 0 ? `\n(+${cut} more)`.length : 0)
    // the text of the first k of n tasks, counted from the literal pieces
    const full = (k: number) => MARK.length + 1 + 'Open tasks:'.length + Array.from({ length: k }, (_, i) => 1 + `- #${i + 1} [pending] ${subject(i)}`.length).reduce((a, b) => a + b, 0)
    let cut = 0
    for (let n = 1; n <= 40; n++) {
      const built = buildKeep({ tasks: Array.from({ length: n }, (_, i) => task(String(i + 1), 'pending', subject(i))), files: [], handoffs: [] })
      expect(built).not.toBeNull()
      const got = built!
      const k = got.counts.tasks
      expect(got.text.length).toBeLessThanOrEqual(CAP)
      if (full(n) <= CAP) {
        expect([n, k, got.dropped, got.text.includes('more)')]).toEqual([n, n, 0, false])
      } else {
        cut += 1
        expect(got.dropped).toBe(n - k)
        expect(got.text.endsWith(`(+${n - k} more)`)).toBe(true)
        expect(full(k) + more(n - k)).toBeLessThanOrEqual(CAP)
        expect(full(k + 1) + more(n - k - 1)).toBeGreaterThan(CAP)
      }
    }
    // the sweep crossed the budget, so both branches were taken
    expect(cut).toBeGreaterThan(0)
    expect(cut).toBeLessThan(40)
  })
})

describe('keep-list: what the hook does', () => {
  const TRIGGERS: KeepTrigger[] = ['manual', 'auto', 'plugin', 'precompute']
  const decide = (over: Partial<{ trigger: string; agentId: string | undefined; cfg: KeepConfig; hasMark: boolean; hasKeep: boolean }> = {}) =>
    decideCompact({ trigger: 'manual', agentId: undefined, cfg: cfgOf('on'), hasMark: false, hasKeep: true, ...over })

  // 31-8: the table
  test('off passes everything; a subagent or fork passes; instructions that carry the block pass', () => {
    for (const trigger of TRIGGERS) {
      expect(decide({ trigger, cfg: cfgOf('off') })).toEqual({ action: 'pass', why: 'off', would: null })
      expect(decide({ trigger, agentId: 'agent-x' })).toEqual({ action: 'pass', why: 'subagent', would: null })
      expect(decide({ trigger, hasMark: true })).toEqual({ action: 'pass', why: 'marked', would: null })
    }
  })

  test('on: manual, auto and plugin rewrite when there is something to keep, and pass as empty when there is not', () => {
    for (const trigger of ['manual', 'auto', 'plugin']) {
      expect(decide({ trigger })).toMatchObject({ action: 'rewrite', would: null })
      expect(decide({ trigger, hasKeep: false })).toEqual({ action: 'pass', why: 'empty', would: null })
    }
  })

  test('on: precompute is skipped by default, whatever is to keep, and rewrites under the rewrite policy', () => {
    for (const hasKeep of [true, false]) {
      const got = decide({ trigger: 'precompute', hasKeep })
      expect(got.action).toBe('skip')
      expect(got.why.length).toBeGreaterThan(0)
      expect(got.why).not.toMatch(/[\r\n]/)
      expect(got.why.length).toBeLessThanOrEqual(120)
    }
    expect(decide({ trigger: 'precompute', cfg: cfgOf('on', 'rewrite') })).toMatchObject({ action: 'rewrite' })
    expect(decide({ trigger: 'precompute', cfg: cfgOf('on', 'rewrite'), hasKeep: false })).toEqual({ action: 'pass', why: 'empty', would: null })
  })

  test('observe never changes a thing and says what mode on would have done, precompute included', () => {
    for (const trigger of ['manual', 'auto', 'plugin']) expect(decide({ trigger, cfg: cfgOf('observe') })).toEqual({ action: 'pass', why: 'observe', would: 'rewrite' })
    expect(decide({ trigger: 'precompute', cfg: cfgOf('observe') })).toEqual({ action: 'pass', why: 'observe', would: 'skip' })
    expect(decide({ trigger: 'precompute', cfg: cfgOf('observe', 'rewrite') })).toEqual({ action: 'pass', why: 'observe', would: 'rewrite' })
    expect(decide({ trigger: 'manual', cfg: cfgOf('observe'), hasKeep: false })).toEqual({ action: 'pass', why: 'empty', would: null })
  })

  test('a trigger the engine may add later passes untouched', () => {
    for (const trigger of ['reactive', '', 'Manual', 'constructor']) expect([trigger, decide({ trigger }).action]).toEqual([trigger, 'pass'])
  })

  test('every combination: a rewrite needs mode on, the main loop, no block yet and something to keep; a skip is only a precompute under mode on and policy skip', () => {
    for (const mode of ['off', 'observe', 'on'] as const) {
      for (const precompute of ['skip', 'rewrite'] as const) {
        for (const trigger of [...TRIGGERS, 'other']) {
          for (const agentId of [undefined, 'a1']) {
            for (const hasMark of [false, true]) {
              for (const hasKeep of [false, true]) {
                const got = decide({ trigger, agentId, cfg: cfgOf(mode, precompute), hasMark, hasKeep })
                const live = mode === 'on' && agentId === undefined && !hasMark && TRIGGERS.includes(trigger as KeepTrigger)
                const skips = live && trigger === 'precompute' && precompute === 'skip'
                const key = JSON.stringify({ mode, precompute, trigger, agentId, hasMark, hasKeep })
                expect([key, got.action === 'skip']).toEqual([key, skips])
                expect([key, got.action === 'rewrite']).toEqual([key, live && hasKeep && !skips])
                expect([key, got.would !== null && mode !== 'observe']).toEqual([key, false])
              }
            }
          }
        }
      }
    }
  })
})

describe('keep-list: where the tasks are', () => {
  // the engine's own rule: CLAUDE_CODE_TASK_LIST_ID, else the session id; every other character becomes "-" (read from the 2.1.296 bundle)
  const dir = (env: Parameters<typeof taskDirOf>[0], sid = SID_FULL) => taskDirOf(env, sid)

  test('CLAUDE_CONFIG_DIR wins over HOME; the session id keeps its dashes and is not the short id', () => {
    expect(dir({ CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/u' })).toEqual({ dir: `/cfg/tasks/${SID_FULL}` })
    expect(dir({ HOME: '/home/u' })).toEqual({ dir: `/home/u/.claude/tasks/${SID_FULL}` })
    expect(dir({ CLAUDE_CONFIG_DIR: '', HOME: '/home/u' })).toEqual({ dir: `/home/u/.claude/tasks/${SID_FULL}` })
    expect(JSON.stringify(dir({ HOME: '/h' }))).not.toContain('c07353bf22c447df82966f2d')
  })

  test('trailing slashes of the base are dropped', () => {
    expect(dir({ CLAUDE_CONFIG_DIR: '/cfg//' })).toEqual({ dir: `/cfg/tasks/${SID_FULL}` })
    expect(dir({ HOME: '/home/u/' })).toEqual({ dir: `/home/u/.claude/tasks/${SID_FULL}` })
  })

  test('CLAUDE_CODE_TASK_LIST_ID wins over the session id; a character outside [A-Za-z0-9_-] becomes "-"', () => {
    expect(dir({ CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_TASK_LIST_ID: 'my-list_1' })).toEqual({ dir: '/cfg/tasks/my-list_1' })
    expect(dir({ CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_TASK_LIST_ID: 'a b/c.d' })).toEqual({ dir: '/cfg/tasks/a-b-c-d' })
    expect(dir({ CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_TASK_LIST_ID: '../../etc' })).toEqual({ dir: '/cfg/tasks/------etc' })
    expect(dir({ CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_TASK_LIST_ID: `x${cp(0x1f600)}y` })).toEqual({ dir: '/cfg/tasks/x--y' })
    expect(dir({ CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_TASK_LIST_ID: '' })).toEqual({ dir: `/cfg/tasks/${SID_FULL}` })
  })

  test('no base, or no id to name the list by, is a reason', () => {
    for (const bad of [dir({}), dir({ HOME: '' }), dir({ CLAUDE_CONFIG_DIR: '/cfg' }, '')]) {
      expect(bad).toHaveProperty('why')
      expect((bad as { why: string }).why.length).toBeGreaterThan(0)
    }
  })
})

describe('keep-list: the state and what it says', () => {
  const LAST: KeepLast = {
    at: 1_000,
    trigger: 'manual',
    action: 'pass',
    why: 'observe',
    would: 'rewrite',
    counts: { tasks: 3, files: 4, handoffs: 1 },
    dropped: 0,
    gone: 0,
    chars: 412,
    text: `${MARK}\nOpen tasks:\n- #1 [pending] a`,
    sources: { tasks: '3 open of 5 read in /cfg/tasks/x', files: '4 recorded, 4 on disk', handoffs: '1 recorded' },
    problems: [],
  }
  const state = (over: Partial<KeepState> = {}, last: Partial<KeepLast> = {}): KeepState => ({
    sid: 'sidA',
    mode: 'observe',
    precompute: 'skip',
    seen: { manual: 1, auto: 0, plugin: 0, precompute: 0 },
    last: { ...LAST, ...last },
    ...over,
  })

  test('each compaction is counted under its trigger; another session starts the count over', () => {
    const a = nextKeepState(null, { sid: 'sidA', cfg: cfgOf('observe'), trigger: 'manual', last: LAST })
    expect(a).toMatchObject({ sid: 'sidA', mode: 'observe', precompute: 'skip', seen: { manual: 1, auto: 0, plugin: 0, precompute: 0 }, last: LAST })
    const b = nextKeepState(a, { sid: 'sidA', cfg: cfgOf('on', 'rewrite'), trigger: 'precompute', last: { ...LAST, trigger: 'precompute' } })
    expect(b).toMatchObject({ mode: 'on', precompute: 'rewrite', seen: { manual: 1, auto: 0, plugin: 0, precompute: 1 } })
    expect(b.last?.trigger).toBe('precompute')
    const c = nextKeepState(b, { sid: 'sidB', cfg: cfgOf('observe'), trigger: 'auto', last: LAST })
    expect(c.seen).toEqual({ manual: 0, auto: 1, plugin: 0, precompute: 0 })
    expect(a.seen.manual).toBe(1)
  })

  test('the card line: the mode, the trigger and what was found or done', () => {
    expect(keepLabel(state())).toBe('observe · manual · 3 tasks 4 files 1 handoff')
    expect(keepLabel(state({ mode: 'on' }, { action: 'rewrite', why: 'keep', would: null, trigger: 'auto' }))).toBe('on · auto · injected 412 chars')
    expect(keepLabel(state({ mode: 'on' }, { action: 'skip', why: 'precompute skipped', would: null, trigger: 'precompute' }))).toBe('on · precompute skipped')
    expect(keepLabel(state({}, { trigger: 'precompute', would: 'skip' }))).toBe('observe · precompute · would skip')
    expect(keepLabel(state({}, { why: 'empty', would: null, counts: { tasks: 0, files: 0, handoffs: 0 } }))).toBe('observe · manual · nothing to keep')
    expect(keepLabel(state({ mode: 'on' }, { why: 'empty', would: null, counts: { tasks: 0, files: 0, handoffs: 0 } }))).toBe('on · manual · nothing to keep')
  })

  test('singular and plural, and a count of problems', () => {
    expect(keepLabel(state({}, { counts: { tasks: 1, files: 1, handoffs: 2 } }))).toBe('observe · manual · 1 task 1 file 2 handoffs')
    expect(keepLabel(state({}, { problems: ['tasks: bad json in 2.json'] }))).toBe('observe · manual · 3 tasks 4 files 1 handoff · 1 problem')
    expect(keepLabel(state({}, { problems: ['a', 'b'] }))).toContain('2 problems')
  })

  test('a state with no decision yet is the mode alone', () => {
    expect(keepLabel(state({ last: null }))).toBe('observe')
    expect(keepLabel(state({ mode: 'on', last: null }))).toBe('on')
  })

  test('the report of /keeplist: switches, counts, the last decision, each source in words and the text', () => {
    const text = keepReport(state({ seen: { manual: 2, auto: 1, plugin: 0, precompute: 3 } }), cfgOf('observe'))
    for (const part of ['observe', 'precompute skip', 'manual 2', 'auto 1', 'plugin 0', 'precompute 3', '3 tasks', '4 files', '1 handoff', '412 chars', LAST.sources.tasks, LAST.sources.files, LAST.sources.handoffs, 'would rewrite', MARK]) {
      expect([part, text.includes(part)]).toEqual([part, true])
    }
    expect(text).toContain('problems  none')
  })

  test('the report names every problem; with no state it says no compaction has been seen', () => {
    const text = keepReport(state({}, { problems: ['tasks: 2.json is not JSON', 'files: exists refused'] }), cfgOf('on', 'rewrite'))
    expect(text).toContain('tasks: 2.json is not JSON')
    expect(text).toContain('files: exists refused')
    expect(text).toContain('precompute rewrite')
    const none = keepReport(null, cfgOf('observe'))
    expect(none).toContain('no compaction seen')
    expect(none).toContain('observe')
    expect(none).not.toContain('undefined')
  })
})
