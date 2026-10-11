import { describe, expect, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code/testing'

import { COMPACT_TEXT } from './compact'
import { SESSION_ID, SID, boot, cardOf, makeSnap, paneView, stallNext } from './fixture'
import type { World } from './fixture'
import {
  buildKeep,
  callPath,
  decideCompact,
  keepConfig,
  keepLabel,
  keepReport,
  nextKeepState,
  parseTaskFile,
  pickTaskFiles,
  recordPath,
  sanitize,
  taskDirOf,
  tasksOf,
  withKeep,
} from './keeplist'
import type { KeepConfig, TaskItem } from './keeplist'
import { layoutTree, paneLayout } from './pane'
import type { PaneView } from './pane'
import { FAKE_ELS, findOverflow, isNode, kidsOf, paneParts, textOf } from './tree'
import type { Node } from './tree'
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
// the hidden code points: controls, bidi, separators, zero-width, the BOM, the tag and variation planes; the joiners U+200C and U+200D are not among them
const HIDDEN_RANGES: readonly (readonly [number, number, string])[] = [
  [0x00, 0x1f, 'C0 controls'],
  [0x7f, 0x9f, 'DEL and C1 controls'],
  [0xad, 0xad, 'soft hyphen'],
  [0x61c, 0x61c, 'Arabic letter mark'],
  [0x180e, 0x180e, 'Mongolian vowel separator'],
  [0x200b, 0x200b, 'zero width space'],
  [0x200e, 0x200f, 'left-to-right and right-to-left marks'],
  [0x2028, 0x202e, 'line and paragraph separators, bidi embeddings and overrides'],
  [0x2060, 0x2064, 'word joiner and invisible operators'],
  [0x2066, 0x206f, 'bidi isolates and deprecated format controls'],
  [0xfeff, 0xfeff, 'byte order mark'],
  [0xfff9, 0xfffb, 'interlinear annotation'],
  [0xe0000, 0xe007f, 'tag characters'],
  [0xe0100, 0xe01ef, 'variation selectors supplement'],
]
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

  test('the subject is cut to 100 code points on the way in, an emoji whole', () => {
    expect((parseTaskFile(taskFile({ subject: 'a'.repeat(150) })) as TaskItem).subject).toBe('a'.repeat(SUBJECT_CAP))
    expect((parseTaskFile(taskFile({ subject: 'a'.repeat(SUBJECT_CAP) })) as TaskItem).subject).toBe('a'.repeat(SUBJECT_CAP))
    expect([...(parseTaskFile(taskFile({ subject: cp(0x1f600).repeat(150) })) as TaskItem).subject]).toHaveLength(SUBJECT_CAP)
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

  // 31-3: where each hidden range begins and ends, by the table above and not by the code's own
  test('every hidden range ends where it should: both edges go, and the code point just outside each stays', () => {
    const hiddenAt = (c: number): boolean => HIDDEN_RANGES.some(([lo, hi]) => c >= lo && c <= hi)
    const probes = HIDDEN_RANGES.flatMap(([lo, hi, name]): [number, string][] => [
      [lo, `first of ${name}`],
      [hi, `last of ${name}`],
      [lo - 1, `before ${name}`],
      [hi + 1, `after ${name}`],
    ]).filter(([c]) => c >= 0)
    // four per range, but nothing lies before U+0000
    expect(probes).toHaveLength(4 * HIDDEN_RANGES.length - 1)
    for (const [c, where] of probes) {
      const ch = cp(c)
      const id = [`U+${c.toString(16).toUpperCase().padStart(4, '0')}`, where]
      // a hidden code point and a blank both fold into the one space between their neighbours; anything else stays as it is
      const folds = hiddenAt(c) || /\s/.test(ch)
      expect([...id, sanitize(`a${ch}b`, SUBJECT_CAP)]).toEqual([...id, folds ? 'a b' : `a${ch}b`])
      // a recorded path takes a blank and refuses a hidden code point, which tells the two apart where `sanitize` cannot
      expect([...id, recordPath(null, 'sid', 'Write', `/p/a${ch}b.ts`) === null]).toEqual([...id, hiddenAt(c)])
    }
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

describe('keep-list: which task files are read', () => {
  // the engine writes <id>.json beside .lock and .highwatermark (observed, 2.1.296)
  test('only <id>.json is a task file: the lock, the high-water mark, hidden files, backups and other names are not', () => {
    const names = ['.lock', '.highwatermark', '.hidden.json', 'notes.txt', 'x.json.bak', '1.JSON', 'a b.json', 'a.b.json', '1.json', 'abc.json', 'my-list_2.json', '']
    expect(pickTaskFiles(names).chosen.sort()).toEqual(['1.json', 'abc.json', 'my-list_2.json'])
  })

  test('the newest ids first (10 before 9), a name that is not a number after the numbers', () => {
    expect(pickTaskFiles(['2.json', '10.json', '9.json', 'abc.json', '1.json']).chosen).toEqual(['10.json', '9.json', '2.json', '1.json', 'abc.json'])
  })

  test('at most 200 are read, the newest, and the rest is counted', () => {
    const names = Array.from({ length: 250 }, (_, i) => `${i + 1}.json`)
    const got = pickTaskFiles(names)
    expect(got.chosen).toHaveLength(200)
    expect(got.chosen[0]).toBe('250.json')
    expect(got.chosen.at(-1)).toBe('51.json')
    expect(got.cut).toBe(50)
    expect(pickTaskFiles(names.slice(0, 200))).toMatchObject({ cut: 0 })
    expect(pickTaskFiles([])).toEqual({ chosen: [], cut: 0 })
  })

  test('the listing is left as it was', () => {
    const names = Object.freeze(['2.json', '1.json'])
    expect(() => pickTaskFiles(names)).not.toThrow()
    expect([...names]).toEqual(['2.json', '1.json'])
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

  test('exactly the budget fits; one character more does not, and one item that cannot fit leaves nothing', () => {
    const lead = `${MARK}\nOpen tasks:\n- #1 [pending] `
    const one = (n: number) => buildKeep({ tasks: [task('1', 'pending', 'x'.repeat(n))], files: [], handoffs: [] })
    expect(one(CAP - lead.length)?.text.length).toBe(CAP)
    expect(one(CAP - lead.length)?.dropped).toBe(0)
    expect(one(CAP - lead.length + 1)).toBeNull()
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

// ---- the engine: the hook, the state and the capture through the fake machine ----

const OTHER_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OTHER_SID = 'aaaaaaaabbbb4ccc8dddeeee'
const CFG_DIR = '/root/.claude'
const MSG = { role: 'user', text: 'hello', toolUses: [] }
const SUMMARY = { role: 'user', text: 'the summary', toolUses: [] }
const COMPACTED = { messages: [SUMMARY], tokensBefore: 99, tokensAfter: 42 }
const ON = { STATUS_PANE_KEEP: '1' }
const FILES_TITLE = 'Files written or edited (newest first):'
const blockOf = (...lines: string[]): string => [MARK, ...lines].join('\n')
const OPEN1 = blockOf('Open tasks:', '- #1 [pending] task 1')

type Seen = { trigger: unknown; instructions: unknown; agentId: unknown; messages: unknown }
const SEEN: Seen[] = []
type CompactInput = { trigger?: string; instructions?: string | null; agentId?: string; messages?: unknown[] }

/** Registers the bottom of the chain, what the engine's own compaction answers, before boot; `raw` is a call that is not waited on. */
const setup = async ($: Engine, on: On, opts: { env?: Record<string, string>; edit?: (w: World) => void; bottom?: () => unknown } = {}) => {
  SEEN.length = 0
  on('session.compact', (_c, e) => {
    SEEN.push({ trigger: e.trigger, instructions: e.instructions, agentId: e.agentId, messages: e.messages })
    return (opts.bottom ? opts.bottom() : COMPACTED) as never
  })
  const io = await boot($, on, w => {
    Object.assign(w.env, opts.env ?? {})
    opts.edit?.(w)
  })
  const raw = (input: CompactInput = {}) => ($.session as unknown as { compact: (i: unknown) => Promise<unknown> }).compact({ trigger: 'manual', messages: [MSG], ...input })
  const compact = async (input: CompactInput = {}) => {
    const r = await raw(input)
    await io.clock.settle()
    return r
  }
  return { ...io, raw, compact }
}

const taskDir = (listId = SESSION_ID, cfg = CFG_DIR): string => `${cfg}/tasks/${listId}`
const putTask = (w: World, n: number | string, over: Record<string, unknown> = {}, dir = taskDir()): void => {
  w.files.set(`${dir}/${n}.json`, JSON.stringify({ id: String(n), subject: `task ${n}`, description: 'long text that is never read', activeForm: 'doing it', status: 'pending', blocks: [], blockedBy: [], ...over }))
}
const withTasks =
  (...tasks: (number | [number, Record<string, unknown>])[]) =>
  (w: World): void => {
    for (const t of tasks) {
      if (Array.isArray(t)) putTask(w, t[0], t[1])
      else putTask(w, t)
    }
  }
const keepOf = (w: World) => w.stateValues.get('keep') as KeepState | null | undefined
const keptOf = (w: World) => w.stateValues.get('kept') as KeptFiles | undefined
/** Whether `key` was written, counting only the writes after the first `from` ones. */
const wrote = (w: World, key: string, from = 0): boolean => w.stateSets.slice(from).includes(key)
const READ = (path: string) => ({ tool: 'Read', file_path: path }) as const
const EDIT = (path: string) => ({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' }) as const

describe('engine: the instructions the summarizer is told', () => {
  // 31-9: the person's /compact text and the block coexist, in that order
  test('manual: the person\'s text first, a blank line, then the block; the messages and the trigger as they came', async ($, on) => {
    const { compact } = await setup($, on, { env: ON, edit: withTasks([1, { subject: 'Write the parser' }]) })
    const result = await compact({ instructions: 'CMD-TEXT' })
    expect(SEEN).toHaveLength(1)
    expect(SEEN[0]!.instructions).toBe(`CMD-TEXT\n\n${blockOf('Open tasks:', '- #1 [pending] Write the parser')}`)
    expect(SEEN[0]!.trigger).toBe('manual')
    expect(SEEN[0]!.messages).toEqual([MSG])
    expect(result).toEqual(COMPACTED)
  })

  // 31-10: an auto compaction has no text of its own; the block must not be preceded by a word for nothing
  for (const none of ['absent', 'undefined', 'null'] as const) {
    test(`auto with instructions ${none}: the block alone, no "undefined", no "null", no leading newline`, async ($, on) => {
      const { compact } = await setup($, on, { env: ON, edit: withTasks(1) })
      await compact({ trigger: 'auto', ...(none === 'absent' ? {} : { instructions: none === 'null' ? null : undefined }) } as CompactInput)
      expect(SEEN).toHaveLength(1)
      expect(SEEN[0]!.instructions).toBe(OPEN1)
      expect(SEEN[0]!.trigger).toBe('auto')
    })
  }

  // 31-11: what #30 puts in the box and what this adds are told together
  test('the text #30 pre-fills survives in front of the block', async ($, on) => {
    const { compact } = await setup($, on, { env: ON, edit: withTasks(1) })
    const typed = COMPACT_TEXT.replace(/^\/compact /, '')
    expect(typed).not.toBe(COMPACT_TEXT)
    await compact({ instructions: typed })
    expect(SEEN[0]!.instructions).toBe(`${typed}\n\n${OPEN1}`)
  })

  test('a plugin\'s own compaction is told like a manual one', async ($, on) => {
    const { compact } = await setup($, on, { env: ON, edit: withTasks(1) })
    await compact({ trigger: 'plugin', instructions: 'the plan' })
    expect(SEEN[0]!.instructions).toBe(`the plan\n\n${OPEN1}`)
    expect(SEEN[0]!.trigger).toBe('plugin')
  })

  // 31-16: observe, the default, changes nothing and records what it would do
  test('observe (the default): the summarizer is told what it would have been; the state holds the block that would be sent', async ($, on) => {
    const { world, compact } = await setup($, on, { edit: withTasks(1) })
    const result = await compact({ instructions: 'CMD' })
    expect(SEEN).toHaveLength(1)
    expect(SEEN[0]!.instructions).toBe('CMD')
    expect(SEEN[0]!.messages).toEqual([MSG])
    expect(result).toEqual(COMPACTED)
    expect(keepOf(world)).toMatchObject({
      sid: SID,
      mode: 'observe',
      precompute: 'skip',
      seen: { manual: 1, auto: 0, plugin: 0, precompute: 0 },
      last: { trigger: 'manual', action: 'pass', why: 'observe', would: 'rewrite', counts: { tasks: 1, files: 0, handoffs: 0 }, text: OPEN1, chars: OPEN1.length, at: world.now },
    })
  })

  // 31-17: the bypass reads and writes nothing
  test('STATUS_PANE_KEEP=0: no file is read, nothing is written, the instructions are as they came', async ($, on) => {
    const { world, compact } = await setup($, on, { env: { STATUS_PANE_KEEP: '0' }, edit: withTasks(1) })
    const reads = world.reads.length
    await compact({ instructions: 'CMD' })
    expect(SEEN[0]!.instructions).toBe('CMD')
    expect(world.reads.length).toBe(reads)
    expect(wrote(world, 'keep')).toBe(false)
  })

  // 31-18: the master switch of the rows file
  test('the rows file switched off: nothing is read or written and the instructions are as they came', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: w => { putTask(w, 1); w.files.set(`${CFG_DIR}/cc-statusline-rows.json`, '{"enabled":false}') } })
    const reads = world.reads.length
    await compact({ instructions: 'CMD' })
    expect(SEEN[0]!.instructions).toBe('CMD')
    expect(world.reads.length).toBe(reads)
    expect(wrote(world, 'keep')).toBe(false)
  })

  test('no snapshot yet is not the switch off: the keep-list goes in', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: withTasks(1) })
    world.readOnce.set('snap', null)
    await compact({ instructions: 'CMD' })
    expect(SEEN[0]!.instructions).toBe(`CMD\n\n${OPEN1}`)
  })

  // 31-19: only the main conversation; a subagent's or a fork's own compaction is none of this
  test('a compaction with an agentId (a subagent or a fork) is left alone: nothing read, nothing written', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: withTasks(1) })
    const reads = world.reads.length
    await compact({ instructions: 'CMD', agentId: 'agent-x' })
    expect(SEEN[0]!.instructions).toBe('CMD')
    expect(SEEN[0]!.agentId).toBe('agent-x')
    expect(world.reads.length).toBe(reads)
    expect(wrote(world, 'keep')).toBe(false)
  })

  // 31-20: no header with nothing under it
  test('mode on with nothing to keep: the instructions are as they came and the state says empty', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON })
    await compact({ instructions: 'CMD' })
    expect(SEEN[0]!.instructions).toBe('CMD')
    expect(keepOf(world)?.last).toMatchObject({ action: 'pass', why: 'empty', would: null, counts: { tasks: 0, files: 0, handoffs: 0 }, text: '', chars: 0 })
    await compact({ trigger: 'auto' })
    expect(SEEN[1]!.instructions).toBeUndefined()
  })

  // 31-21: told once, whoever passes it on and however often; a call that finds the block is silent
  test('instructions that already carry the block are not given it twice, and cost no read and no write', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: withTasks(1) })
    await compact({ instructions: 'CMD' })
    const told = SEEN[0]!.instructions as string
    expect(told.split(MARK).length - 1).toBe(1)
    // the first call read the task and wrote `keep`; the calls below must add to neither
    const reads = world.reads.length
    const writes = world.stateSets.length
    await compact({ instructions: told })
    expect(SEEN[1]!.instructions).toBe(told)
    await compact({ instructions: `before ${MARK} after` })
    expect(SEEN[2]!.instructions).toBe(`before ${MARK} after`)
    expect(world.reads.length).toBe(reads)
    expect(wrote(world, 'keep', writes)).toBe(false)
  })

  test('a trigger the engine may add later is passed on untouched', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: withTasks(1) })
    await compact({ trigger: 'reactive', instructions: 'CMD' })
    expect(SEEN[0]!.instructions).toBe('CMD')
    expect(wrote(world, 'keep')).toBe(false)
  })
})

describe('engine: a compaction ahead of time (precompute)', () => {
  // 31-12: the default policy is to not compute one: a summary made now would freeze the list
  test('mode on, default policy: answered {skip} with a reason, no source read, the engine below never reached, the sighting counted', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: w => { putTask(w, 1); w.denyList.add(taskDir()) } })
    const reads = world.reads.length
    const result = (await compact({ trigger: 'precompute' })) as { skip?: unknown }
    expect(typeof result.skip).toBe('string')
    expect(String(result.skip).length).toBeGreaterThan(0)
    expect(SEEN).toHaveLength(0)
    expect(world.reads.length).toBe(reads)
    // a listing that was tried would have been refused and told as a problem
    expect(keepOf(world)).toMatchObject({ seen: { precompute: 1, manual: 0 }, last: { trigger: 'precompute', action: 'skip', problems: [] } })
  })

  // 31-13: the other policy writes the block in like any other trigger
  test('mode on, policy rewrite: the block goes in', async ($, on) => {
    const { compact } = await setup($, on, { env: { ...ON, STATUS_PANE_KEEP_PRECOMPUTE: 'rewrite' }, edit: withTasks(1) })
    await compact({ trigger: 'precompute' })
    expect(SEEN).toHaveLength(1)
    expect(SEEN[0]!.instructions).toBe(OPEN1)
    expect(SEEN[0]!.trigger).toBe('precompute')
  })

  // 31-14: observing never decides for the engine, and says what it would have decided
  test('observe: the engine below is reached with the instructions as they came; the state says it would skip', async ($, on) => {
    const { world, compact } = await setup($, on, { edit: withTasks(1) })
    await compact({ trigger: 'precompute' })
    expect(SEEN).toHaveLength(1)
    expect(SEEN[0]!.instructions).toBeUndefined()
    expect(keepOf(world)).toMatchObject({ seen: { precompute: 1 }, last: { trigger: 'precompute', action: 'pass', would: 'skip' } })
  })

  // 31-15: the bypass is silent for this trigger too
  test('STATUS_PANE_KEEP=0: reached untouched, nothing read, nothing written', async ($, on) => {
    const { world, compact } = await setup($, on, { env: { STATUS_PANE_KEEP: '0' }, edit: withTasks(1) })
    const reads = world.reads.length
    await compact({ trigger: 'precompute' })
    expect(SEEN).toHaveLength(1)
    expect(SEEN[0]!.instructions).toBeUndefined()
    expect(world.reads.length).toBe(reads)
    expect(wrote(world, 'keep')).toBe(false)
  })

  test('the sightings are counted by trigger and start over with another session', async ($, on) => {
    const { world, compact } = await setup($, on)
    for (const trigger of ['manual', 'auto', 'precompute', 'manual']) await compact({ trigger })
    expect(keepOf(world)?.seen).toEqual({ manual: 2, auto: 1, plugin: 0, precompute: 1 })
    world.session.id = OTHER_SESSION
    await compact({ trigger: 'plugin' })
    expect(keepOf(world)).toMatchObject({ sid: OTHER_SID, seen: { manual: 0, auto: 0, plugin: 1, precompute: 0 } })
  })
})

describe('engine: where the tasks are read from', () => {
  // 31-22: the engine's rule for the directory, one decoy per rule
  test('CLAUDE_CONFIG_DIR wins over HOME', async ($, on) => {
    const { compact } = await setup($, on, { env: { ...ON, CLAUDE_CONFIG_DIR: '/cfg2' }, edit: w => { putTask(w, 1, { subject: 'in the config dir' }, taskDir(SESSION_ID, '/cfg2')); putTask(w, 9, { subject: 'under HOME' }) } })
    await compact()
    expect(SEEN[0]!.instructions).toBe(blockOf('Open tasks:', '- #1 [pending] in the config dir'))
  })

  test('CLAUDE_CODE_TASK_LIST_ID wins over the session id, and a character outside [A-Za-z0-9_-] is a dash', async ($, on) => {
    const { compact } = await setup($, on, { env: { ...ON, CLAUDE_CODE_TASK_LIST_ID: 'my list/1' }, edit: w => { putTask(w, 1, { subject: 'in the named list' }, taskDir('my-list-1')); putTask(w, 9, { subject: 'in the session list' }) } })
    await compact()
    expect(SEEN[0]!.instructions).toBe(blockOf('Open tasks:', '- #1 [pending] in the named list'))
  })

  test('the session\'s full id with its dashes names the list, not the 24 character one', async ($, on) => {
    const { compact } = await setup($, on, { env: ON, edit: w => { putTask(w, 1, { subject: 'in the full id' }); putTask(w, 9, { subject: 'in the short id' }, taskDir(SID)) } })
    await compact()
    expect(SEEN[0]!.instructions).toBe(blockOf('Open tasks:', '- #1 [pending] in the full id'))
  })

  // 31-23: the directory holds more than tasks
  test('the lock, the high-water mark, hidden files and other names are ignored; finished tasks are left out', async ($, on) => {
    const { world, compact } = await setup($, on, {
      env: ON,
      edit: w => {
        putTask(w, 1, { subject: 'open one' })
        putTask(w, 2, { subject: 'done', status: 'completed' })
        putTask(w, 3, { subject: 'busy', status: 'in_progress' })
        for (const name of ['.lock', '.highwatermark', '.hidden.json', 'notes.txt', 'x.json.bak']) w.files.set(`${taskDir()}/${name}`, '{"id":"7","subject":"not a task","status":"pending"}')
      },
    })
    await compact()
    expect(SEEN[0]!.instructions).toBe(blockOf('Open tasks:', '- #3 [in_progress] busy', '- #1 [pending] open one'))
    expect(world.reads.filter(p => p.startsWith(taskDir()))).toHaveLength(3)
  })

  test('250 files are 200 reads, the newest, and the cut is told', async ($, on) => {
    const { world, compact } = await setup($, on, { edit: w => { for (let n = 1; n <= 250; n++) putTask(w, n) } })
    await compact()
    expect(world.reads.filter(p => p.startsWith(taskDir()))).toHaveLength(200)
    expect(world.reads).toContain(`${taskDir()}/250.json`)
    expect(world.reads).not.toContain(`${taskDir()}/50.json`)
    expect(keepOf(world)?.last?.problems.join('\n')).toMatch(/200/)
  })

  // a task file is a few hundred bytes; a bigger one is not read into the hook's memory
  for (const [bytes, read] of [[65_536, true], [65_537, false]] as const) {
    test(`a task file of ${bytes} bytes is ${read ? 'read' : 'not read, and told'}`, async ($, on) => {
      const bare = { id: '2', subject: 'sized', description: '', activeForm: 'a', status: 'pending', blocks: [], blockedBy: [] }
      const text = JSON.stringify({ ...bare, description: 'x'.repeat(bytes - JSON.stringify(bare).length) })
      expect(text.length).toBe(bytes)
      const { world, compact } = await setup($, on, { env: ON, edit: w => { putTask(w, 1); w.files.set(`${taskDir()}/2.json`, text) } })
      await compact()
      expect(world.reads.includes(`${taskDir()}/2.json`)).toBe(read)
      expect(String(SEEN[0]!.instructions).includes('sized')).toBe(read)
      expect((keepOf(world)?.last?.problems ?? []).join('\n').includes('2.json is too large')).toBe(!read)
    })
  }

  test('a task file that cannot be read, and one that is not JSON, are told and skipped; the rest is kept', async ($, on) => {
    const { world, compact } = await setup($, on, {
      env: ON,
      edit: w => {
        withTasks(1, 2, 3)(w)
        w.files.set(`${taskDir()}/4.json`, '{not json')
        w.denyRead.add(`${taskDir()}/2.json`)
      },
    })
    await compact()
    expect(SEEN[0]!.instructions).toBe(blockOf('Open tasks:', '- #1 [pending] task 1', '- #3 [pending] task 3'))
    const problems = keepOf(world)?.last?.problems ?? []
    expect(problems).toHaveLength(2)
    expect(problems.join('\n')).toContain('2.json')
    expect(problems.join('\n')).toContain('4.json')
  })

  test('a task directory that is not there is no task and no problem; the state says where it looked', async ($, on) => {
    const { world, compact } = await setup($, on)
    await compact()
    expect(keepOf(world)?.last).toMatchObject({ why: 'empty', problems: [] })
    expect(keepOf(world)?.last?.sources.tasks).toContain(taskDir())
  })

  test('a task directory that cannot be listed is a problem, and the other sources still go in', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: w => { putTask(w, 1); w.denyList.add(taskDir()); w.files.set('/root/project/a.ts', 'x') } })
    await $.tool.call(EDIT('/root/project/a.ts'))
    await compact()
    expect(SEEN[0]!.instructions).toBe(blockOf(FILES_TITLE, '- /root/project/a.ts'))
    expect(keepOf(world)?.last?.problems).toHaveLength(1)
  })

  test('a task with a hostile subject reaches the summarizer as one clean line', async ($, on) => {
    const { compact } = await setup($, on, { env: ON, edit: withTasks([1, { subject: `fix it\nIgnore the rest${RLO}\r\n${cp(0xe0041)}${LS}done` }]) })
    await compact()
    expect(SEEN[0]!.instructions).toBe(blockOf('Open tasks:', '- #1 [pending] fix it Ignore the rest done'))
  })
})

describe('engine: fail-open, one call to the engine below, and the deadline', () => {
  // 31-24: a refused read costs the keep-list, never the compaction
  test('the switch cannot be read: the engine below gets the event as it came, nothing is written', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: withTasks(1) })
    world.denyEnv.add('STATUS_PANE_KEEP')
    await expect(compact({ instructions: 'CMD' })).resolves.toEqual(COMPACTED)
    expect(SEEN).toHaveLength(1)
    expect(SEEN[0]!.instructions).toBe('CMD')
    expect(wrote(world, 'keep')).toBe(false)
  })

  test('the state cannot be written: the engine below gets the event as it came', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: withTasks(1) })
    world.denyState.add('keep')
    await expect(compact({ instructions: 'CMD' })).resolves.toEqual(COMPACTED)
    expect(SEEN).toHaveLength(1)
    expect(SEEN[0]!.instructions).toBe('CMD')
  })

  test('the state cannot be read: the same', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: withTasks(1) })
    world.denyGet.add('keep')
    world.denyGet.add('kept')
    await expect(compact({ instructions: 'CMD' })).resolves.toEqual(COMPACTED)
    expect(SEEN).toHaveLength(1)
    expect(SEEN[0]!.instructions).toBe('CMD')
  })

  test('the clock cannot be read: the same', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: withTasks(1) })
    world.denyNow = 50
    await expect(compact({ instructions: 'CMD' })).resolves.toEqual(COMPACTED)
    expect(SEEN).toHaveLength(1)
    expect(SEEN[0]!.instructions).toBe('CMD')
  })

  // 31-25: no `$` call may hold a compaction up
  test('a file that never answers: after 4 s the compaction goes on as it came, and the late answer writes nothing', async ($, on) => {
    const { world, raw, advance, clock } = await setup($, on, { env: ON, edit: withTasks(1) })
    const release = stallNext(world, `fs.read:${taskDir()}/1.json`)
    const pending = raw({ instructions: 'CMD' })
    await clock.settle()
    expect(SEEN).toHaveLength(0)
    await advance(3000)
    expect(SEEN).toHaveLength(0)
    await advance(1000)
    await expect(pending).resolves.toEqual(COMPACTED)
    expect(SEEN).toHaveLength(1)
    expect(SEEN[0]!.instructions).toBe('CMD')
    release()
    await clock.settle()
    await advance(1000)
    expect(SEEN).toHaveLength(1)
    expect(wrote(world, 'keep')).toBe(false)
  })

  test('a switch that never answers is held to the same 4 s', async ($, on) => {
    const { world, raw, advance, clock } = await setup($, on, { env: ON, edit: withTasks(1) })
    const release = stallNext(world, 'state.get:snap')
    const pending = raw({ instructions: 'CMD' })
    await clock.settle()
    expect(SEEN).toHaveLength(0)
    await advance(4000)
    await expect(pending).resolves.toEqual(COMPACTED)
    expect(SEEN[0]!.instructions).toBe('CMD')
    release()
    await clock.settle()
  })

  // 31-26: guard
  const PATHS: [string, Record<string, string>, CompactInput, boolean][] = [
    ['off', { STATUS_PANE_KEEP: '0' }, {}, true],
    ['observe', {}, {}, true],
    ['on', ON, {}, true],
    ['on with nothing to keep', ON, {}, false],
    ['a subagent', ON, { agentId: 'a1' }, true],
    ['instructions that carry the block', ON, { instructions: MARK }, true],
    ['precompute observed', {}, { trigger: 'precompute' }, true],
    ['precompute rewritten', { ...ON, STATUS_PANE_KEEP_PRECOMPUTE: 'rewrite' }, { trigger: 'precompute' }, true],
    ['precompute skipped', ON, { trigger: 'precompute' }, true],
  ]
  for (const [name, env, input, tasks] of PATHS) {
    test(`${name}: the engine below is reached ${name === 'precompute skipped' ? 'never' : 'exactly once'}`, async ($, on) => {
      const { compact } = await setup($, on, { env, edit: tasks ? withTasks(1) : undefined })
      await compact(input)
      expect(SEEN).toHaveLength(name === 'precompute skipped' ? 0 : 1)
    })
  }

  test('what the engine below answers comes back as it is', async ($, on) => {
    const answer = { messages: [SUMMARY, MSG], tokensBefore: 1234, tokensAfter: 56 }
    const { compact } = await setup($, on, { env: ON, edit: withTasks(1), bottom: () => answer })
    await expect(compact({ instructions: 'CMD' })).resolves.toEqual(answer)
  })

  test('a failure of the engine below is passed on, and the call is not tried again', async ($, on) => {
    const { compact } = await setup($, on, {
      env: ON,
      edit: withTasks(1),
      bottom: () => {
        throw new Error('summarizer exploded')
      },
    })
    await expect(compact({ instructions: 'CMD' })).rejects.toThrow()
    expect(SEEN).toHaveLength(1)
  })
})

describe('engine: the record of what the session wrote', () => {
  // 31-27: only a call that went through, only these tools
  test('Write, Edit and NotebookEdit that went through are recorded under the session, a subagent\'s too', async ($, on) => {
    const { world } = await setup($, on)
    await $.tool.call({ tool: 'Write', file_path: '/root/project/new.ts', content: 'x' })
    await $.tool.call(EDIT('/root/project/a.ts'))
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/root/project/n.ipynb', new_source: 'x' })
    await $.tool.call({ ...EDIT('/root/project/sub.ts'), agentId: 'a1' } as never)
    expect(keptOf(world)).toEqual({ sid: SID, files: ['/root/project/sub.ts', '/root/project/n.ipynb', '/root/project/a.ts', '/root/project/new.ts'], handoffs: [] })
  })

  test('a call that was denied, that failed or that threw is not recorded', async ($, on) => {
    const { world } = await setup($, on)
    world.toolResult = () => ({ deny: 'no' })
    await $.tool.call(EDIT('/root/project/denied.ts'))
    world.toolResult = () => ({ result: {}, isError: true })
    await $.tool.call(EDIT('/root/project/failed.ts'))
    world.toolResult = () => { throw new Error('boom') }
    await $.tool.call(EDIT('/root/project/threw.ts')).catch(() => undefined)
    expect(wrote(world, 'kept')).toBe(false)
  })

  test('a Read of a handoff file is a handoff; a Read of anything else writes nothing', async ($, on) => {
    const { world } = await setup($, on)
    await $.tool.call(READ('/root/project/a.ts'))
    await $.tool.call(READ('/root/memory/notes.md'))
    expect(wrote(world, 'kept')).toBe(false)
    await $.tool.call(READ('/root/memory/handoff-x.md'))
    expect(keptOf(world)).toEqual({ sid: SID, files: [], handoffs: ['/root/memory/handoff-x.md'] })
  })

  test('a path that is not absolute, or is in node_modules, writes nothing', async ($, on) => {
    const { world } = await setup($, on)
    await $.tool.call(EDIT('relative/a.ts'))
    await $.tool.call(EDIT('/root/project/node_modules/x/index.js'))
    await $.tool.call({ tool: 'Bash', command: 'echo hi > /root/project/out.txt' })
    expect(wrote(world, 'kept')).toBe(false)
  })

  // 31-28: a compaction takes the calls out of the transcript, so the record is kept beside it
  test('the record outlives a compaction and grows; another session starts over', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: w => { for (const f of ['a', 'b', 'c', 'd']) w.files.set(`/root/project/${f}.ts`, 'x') } })
    await $.tool.call(EDIT('/root/project/a.ts'))
    await $.tool.call(EDIT('/root/project/b.ts'))
    await compact()
    expect(SEEN[0]!.instructions).toBe(blockOf(FILES_TITLE, '- /root/project/b.ts', '- /root/project/a.ts'))
    await $.tool.call(EDIT('/root/project/c.ts'))
    await compact()
    expect(SEEN[1]!.instructions).toBe(blockOf(FILES_TITLE, '- /root/project/c.ts', '- /root/project/b.ts', '- /root/project/a.ts'))
    world.session.id = OTHER_SESSION
    await $.tool.call(EDIT('/root/project/d.ts'))
    expect(keptOf(world)).toEqual({ sid: OTHER_SID, files: ['/root/project/d.ts'], handoffs: [] })
    await compact()
    expect(SEEN[2]!.instructions).toBe(blockOf(FILES_TITLE, '- /root/project/d.ts'))
  })

  test('a recorded file that is no longer there is left out and counted; one whose check is refused stays', async ($, on) => {
    const { world, compact } = await setup($, on, { env: ON, edit: w => { w.files.set('/root/project/a.ts', 'x'); w.files.set('/root/project/c.ts', 'x'); w.denyExists.add('/root/project/c.ts') } })
    for (const f of ['a', 'b', 'c']) await $.tool.call(EDIT(`/root/project/${f}.ts`))
    await compact()
    expect(SEEN[0]!.instructions).toBe(blockOf(FILES_TITLE, '- /root/project/c.ts', '- /root/project/a.ts'))
    expect(keepOf(world)?.last).toMatchObject({ gone: 1, counts: { tasks: 0, files: 2, handoffs: 0 } })
  })

  test('only the newest 10 recorded files are checked and listed', async ($, on) => {
    const { compact } = await setup($, on, { env: ON, edit: w => { for (let i = 1; i <= 12; i++) w.files.set(`/root/project/f${i}.ts`, 'x') } })
    for (let i = 1; i <= 12; i++) await $.tool.call(EDIT(`/root/project/f${i}.ts`))
    await compact()
    const lines = String(SEEN[0]?.instructions ?? '').split('\n').filter(l => l.startsWith('- /root'))
    expect(lines).toEqual(Array.from({ length: 10 }, (_, i) => `- /root/project/f${12 - i}.ts`))
  })

  test('handoffs are named before the files, once, and checked for existence like them', async ($, on) => {
    const { compact } = await setup($, on, { env: ON, edit: w => { w.files.set('/root/memory/handoff-x.md', 'x'); w.files.set('/root/project/a.ts', 'x') } })
    await $.tool.call({ tool: 'Write', file_path: '/root/memory/handoff-x.md', content: 'x' })
    await $.tool.call(EDIT('/root/project/a.ts'))
    await $.tool.call(READ('/root/memory/handoff-gone.md'))
    await compact()
    expect(SEEN[0]!.instructions).toBe(blockOf('Handoff files to re-read:', '- /root/memory/handoff-x.md', FILES_TITLE, '- /root/project/a.ts'))
  })
})

describe('engine: /keeplist', () => {
  const KEEPLIST = { command: 'keeplist', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const
  const run = ($: Engine) => $.command.run(KEEPLIST).catch((err: unknown) => ({ text: `threw: ${String(err)}` }))

  // 31-30
  test('it is registered after the others, as an immediate command', async ($, on) => {
    const { world } = await setup($, on)
    expect(world.registered).toEqual(['status-pane', 'progress', 'keeplist'])
    expect(world.commandSpecs.find(s => s.name === 'keeplist')).toMatchObject({ name: 'keeplist', immediate: true })
  })

  test('before any compaction it says so and names the switches in force', async ($, on) => {
    await setup($, on)
    const text = (await run($)).text ?? ''
    expect(text).toContain('no compaction seen')
    expect(text).toContain('observe')
    expect(text).toContain('precompute skip')
  })

  test('after one it prints the switches, the sightings, the decision, the sources and the block', async ($, on) => {
    const { compact } = await setup($, on, { edit: withTasks(1) })
    await compact()
    const text = (await run($)).text ?? ''
    for (const part of ['observe', 'manual 1', 'would rewrite', '1 task', `${taskDir()}`, OPEN1, 'problems  none']) expect([part, text.includes(part)]).toEqual([part, true])
  })

  test('the state of another session is not this one\'s', async ($, on) => {
    const { world } = await setup($, on)
    world.readOnce.set('keep', { sid: OTHER_SID, mode: 'observe', precompute: 'skip', seen: { manual: 4, auto: 0, plugin: 0, precompute: 0 }, last: null })
    expect((await run($)).text).toContain('no compaction seen')
  })

  test('a state that cannot be read is n/a with the reason, and the command still answers', async ($, on) => {
    const { world } = await setup($, on)
    world.denyGet.add('keep')
    const text = (await run($)).text ?? ''
    expect(text).toMatch(/^keeplist n\/a \(/)
    expect(text).not.toContain('threw')
  })

  test('it reads state only: no file, no listing, no model', async ($, on) => {
    const { world, compact } = await setup($, on, { edit: w => { putTask(w, 1); w.denyList.add(taskDir()) } })
    await compact()
    const reads = world.reads.length
    const usage = world.usageCalls
    await run($)
    expect(world.reads.length).toBe(reads)
    expect(world.usageCalls).toBe(usage)
  })
})

// ---- the card: the keep row under the CONTEXT hint ----

const CARD_LAST: KeepLast = {
  at: 1,
  trigger: 'manual',
  action: 'pass',
  why: 'observe',
  would: 'rewrite',
  counts: { tasks: 3, files: 4, handoffs: 1 },
  dropped: 0,
  gone: 0,
  chars: 412,
  text: '',
  sources: { tasks: '', files: '', handoffs: '' },
  problems: [],
}
const cardState = (over: Partial<KeepState> = {}, last: Partial<KeepLast> = {}): KeepState => ({
  sid: 'x',
  mode: 'observe',
  precompute: 'skip',
  seen: { manual: 1, auto: 0, plugin: 0, precompute: 0 },
  last: { ...CARD_LAST, ...last },
  ...over,
})
const contextCard = (columns: number, keep: KeepState | null, snap = makeSnap()) => {
  const view: PaneView = { columns, nowMs: 0, tzMin: 0, raster: true, cpuHist: [], keep }
  const tree = layoutTree(paneLayout(snap, view), FAKE_ELS) as unknown as Node
  return { card: cardOf(paneParts(tree, columns), 'CONTEXT'), tree }
}
/** The Text nodes of a drawn card whose own words hold `needle`. */
const textsHolding = (n: Node, needle: string): Node[] => [
  ...(n.type === 'Text' && textOf(n).includes(needle) ? [n] : []),
  ...kidsOf(n)
    .filter(isNode)
    .flatMap(k => textsHolding(k, needle)),
]
/** The words of the card's body, one space between them wherever a row was wrapped or padded. */
const words = (columns: number, keep: KeepState | null): string => contextCard(columns, keep).card.body.join(' ').replace(/\s+/g, ' ')

describe('the CONTEXT card: the keep row', () => {
  // 31-29: after the hint, in full at every breakpoint, only while there is a state and the mode is not off
  for (const columns of [36, 49, 89]) {
    test(`bodyColumns ${columns}: the row reads the mode, the trigger and what was found, whole, after the hint`, () => {
      const text = words(columns, cardState())
      expect(text).toContain('keep observe · manual · 3 tasks 4 files 1 handoff')
      expect(text.indexOf('keep observe')).toBeGreaterThan(text.indexOf('/compact'))
      expect(words(columns, cardState({ mode: 'on' }, { action: 'rewrite', why: 'keep', would: null, trigger: 'auto' }))).toContain('keep on · auto · injected 412 chars')
      expect(words(columns, cardState({ mode: 'on' }, { action: 'skip', why: 'precompute skipped', would: null, trigger: 'precompute' }))).toContain('keep on · precompute skipped')
    })

    test(`bodyColumns ${columns}: no state, or the mode off, is no row`, () => {
      expect(words(columns, null)).not.toContain('keep')
      expect(words(columns, cardState({ mode: 'off' }))).not.toContain('keep')
    })
  }

  test('a card that says why it has no usage carries no keep row either', () => {
    for (const columns of [36, 49, 89]) {
      const { card } = contextCard(columns, cardState(), makeSnap({ context: { ok: false, why: 'usage refused' } }))
      expect(card.body).toEqual(['n/a (usage refused)'])
    }
  })

  test('the word keep is dim and the value is not; the hint above is as it was', () => {
    for (const columns of [36, 49, 89]) {
      const { card } = contextCard(columns, cardState())
      const label = textsHolding(card.node, 'keep').filter(n => textOf(n) === 'keep')
      expect(label).toHaveLength(1)
      expect(label[0]!.props).toMatchObject({ dimColor: true })
      const value = textsHolding(card.node, 'handoff')
      expect(value.length).toBeGreaterThan(0)
      for (const n of value) expect(n.props?.dimColor).toBeUndefined()
      expect(card.body.join(' ')).toContain('達 60% 建議 /compact')
    }
  })

  test('no overflow from 22 to 120 columns, with a long label, many problems and a 3-digit count', () => {
    for (let columns = 22; columns <= 120; columns++) {
      const keep = cardState({}, { counts: { tasks: 15, files: 10, handoffs: 5 }, problems: ['a', 'b', 'c'], trigger: 'precompute' })
      expect(findOverflow(contextCard(columns, keep).tree, columns)).toEqual([])
    }
  })

  // through the engine: the state the hook wrote is what the card draws
  test('after a compaction the pane shows the row; before one it does not', async ($, on) => {
    const { compact } = await setup($, on, { edit: withTasks(1) })
    for (const columns of [36, 49, 89]) expect((await paneView($, columns)).cards.find(c => c.title === 'CONTEXT')?.body.join(' ')).not.toContain('keep')
    await compact()
    for (const columns of [36, 49, 89]) {
      const body = (await paneView($, columns)).cards.find(c => c.title === 'CONTEXT')?.body.join(' ').replace(/\s+/g, ' ')
      expect(body).toContain('keep observe · manual · 1 task 0 files 0 handoffs')
    }
  })

  test('a state left by another session is not drawn', async ($, on) => {
    const { world, compact } = await setup($, on, { edit: withTasks(1) })
    await compact()
    expect((await paneView($, 89)).cards.find(c => c.title === 'CONTEXT')?.body.join(' ')).toContain('keep observe')
    world.session.id = OTHER_SESSION
    expect((await paneView($, 89)).cards.find(c => c.title === 'CONTEXT')?.body.join(' ')).not.toContain('keep')
  })

  test('with the mode off nothing is written, so the pane has no row', async ($, on) => {
    const { compact } = await setup($, on, { env: { STATUS_PANE_KEEP: '0' }, edit: withTasks(1) })
    await compact()
    expect((await paneView($, 89)).cards.find(c => c.title === 'CONTEXT')?.body.join(' ')).not.toContain('keep')
  })
})
