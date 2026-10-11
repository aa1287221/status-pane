import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { HEADER_89_DETAIL, HEADER_89_MODEL, WORLD_89, boot, cardOf, headerOf, paneText, paneView, pair, right, summarize, trackerCommand, trackerHooks, without } from './fixture'
import type { World } from './fixture'
import type { PaneParts } from './tree'

const ROWS_FILE = '/root/.claude/cc-statusline-rows.json'
const REFRESHER = '/root/.claude/hooks/mcp-status-refresh.js'

const AGENTS_NA = 'agents n/a (subagent-tracker.js hook not configured)'
const EDITED_NA = 'edited n/a (file-tracker.js hook not configured)'
const SUMMARY_NA = 'summary n/a (summary-updater.js and message-tracker.js hooks not configured)'
const COMPACT_NA = 'compact n/a (compact-monitor.js hook not configured)'

/** The edited files as the ACTIVITY card of a healthy world reads them. */
const EDITED_FILES = /edited +register\.tsx/

const errorsText = (n: number) => `${n} error${n === 1 ? '' : 's'}`
const CPU_RAM = [pair('cpu', '—', 83), pair('ram', '45%  7.0/15.6G', 83)]
const MEMORY = pair('memory', 'global · project · 3 rules', 83)
/** The SYSTEM card of a healthy world at 89 columns with the errors count as its last row. */
const systemWith = (n: number) => [...CPU_RAM, pair('mcp', '2/3  figma ✗', 83), MEMORY, right(errorsText(n), 83)]
/** The same when the refresher is missing: its message takes the row of the mcp servers. */
const systemNoMcp = (n: number) => [...CPU_RAM, 'mcp n/a (mcp-status-refresh.js missing)', MEMORY, right(errorsText(n), 83)]

type Hooks = Record<string, { hooks: { command: string }[] }[]>

/** The world's settings less every entry that runs one of the scripts. */
const unwire = (w: World, ...scripts: string[]) => {
  const hooks = w.settings.hooks as Hooks
  w.settings = {
    hooks: Object.fromEntries(
      Object.entries(hooks).map(([event, groups]) => [
        event,
        groups.map(g => ({ ...g, hooks: g.hooks.filter(h => !scripts.some(s => h.command.includes(s))) })),
      ]),
    ),
  }
}

/** The world's settings with `script` wired to one more event. */
const wire = (w: World, event: string, script: string) => {
  const hooks = w.settings.hooks as Hooks
  w.settings = { hooks: { ...hooks, [event]: [...(hooks[event] ?? []), { hooks: [trackerCommand(script)] }] } }
}

/** The cards and the footer of a healthy pane at 89 columns, the header's row among them. */
const expectNormal = (parts: PaneParts) => {
  expect(summarize(parts)).toEqual(WORLD_89)
  expect(headerOf(parts).body).toHaveLength(2)
  expect(headerOf(parts).body[0]).toMatch(HEADER_89_MODEL)
  expect(headerOf(parts).body[1]).toBe(HEADER_89_DETAIL)
}

/** A healthy pane but for one card, and the errors counted at the end of the SYSTEM card. */
const expectOnlyCard = (parts: PaneParts, title: string, body: string[], errors = 1) => {
  const cards = summarize(parts).cards
  expect(without(cards, title, 'SYSTEM')).toEqual(without(WORLD_89.cards, title, 'SYSTEM'))
  expect(cards[title]?.body).toEqual(body)
  expect(cards.SYSTEM?.body).toEqual(systemWith(errors))
  expect(parts.footer).toEqual([])
  expect(headerOf(parts).body[0]).toMatch(HEADER_89_MODEL)
}

describe('dependencies: a data source that is missing reads n/a, never idle', () => {
  test('with every tracker hook wired and the refresher in place the cards are the normal ones', async ($, on) => {
    const { world } = await boot($, on)
    expectNormal(await paneView($))
    expect(world.settingsCalls).toBeGreaterThan(0)
  })

  test('the effort tracker is no dependency: without it nothing changes', async ($, on) => {
    const { world } = await boot($, on, w => unwire(w, 'effort-tracker.js'))
    expectNormal(await paneView($))
    expect(world.settingsCalls).toBeGreaterThan(0)
  })

  test('subagent-tracker.js missing: the agents part of ACTIVITY says so and counts one error, nothing else changes', async ($, on) => {
    await boot($, on, w => unwire(w, 'subagent-tracker.js'))
    expectOnlyCard(await paneView($), 'ACTIVITY', [
      'in-flight',
      'n/a（subagent-tracker.js',
      'hook not configured）',
      'agents n/a',
      '(subagent-tracker.js',
      'hook not configured)',
      pair('edited', 'register.tsx →', 24),
      right('SPEC.md →', 24),
      right('settings.json', 24),
    ])
  })

  test('file-tracker.js missing: the edited part of ACTIVITY says so and counts one error, nothing else changes', async ($, on) => {
    await boot($, on, w => unwire(w, 'file-tracker.js'))
    expectOnlyCard(await paneView($), 'ACTIVITY', [
      pair('in-flight', '0 · 1 stale', 24),
      pair('agents', 'general-purp ○', 24),
      right('Explore ✓×2', 24),
      right('5m ago', 24),
      'edited n/a',
      '(file-tracker.js hook',
      'not configured)',
    ])
  })

  test('summary-updater.js and message-tracker.js together missing: the header says so under the model', async ($, on) => {
    await boot($, on, w => unwire(w, 'summary-updater.js', 'message-tracker.js'))
    const parts = await paneView($)
    expect(headerOf(parts).body).toHaveLength(3)
    expect(headerOf(parts).body[0]).toMatch(/^Opus 5\.5 · max · v2\.1\.294 +mcp ✗(?:  \d+ errors?)? +● \d\d:\d\d$/)
    expect(headerOf(parts).body.slice(1)).toEqual([SUMMARY_NA, '1hr 20min'])
    const cards = summarize(parts).cards
    expect(without(cards, 'SYSTEM')).toEqual(without(WORLD_89.cards, 'SYSTEM'))
    expect(cards.SYSTEM?.body).toEqual(systemWith(1))
  })

  test('compact-monitor.js missing: the context says so under the figures, the gauge and the figures stay', async ($, on) => {
    await boot($, on, w => unwire(w, 'compact-monitor.js'))
    const parts = await paneView($)
    const cards = summarize(parts).cards
    expect(without(cards, 'CONTEXT', 'SYSTEM')).toEqual(without(WORLD_89.cards, 'CONTEXT', 'SYSTEM'))
    expect(cards.CONTEXT).toEqual({
      value: '3%',
      body: [WORLD_89.cards.CONTEXT!.body[0], pair('used', '32.0K / 1.0M', 25), 'compact n/a', '(compact-monitor.js hook', 'not configured)'],
    })
    expect(cards.SYSTEM?.body).toEqual(systemWith(1))
  })

  test('mcp-status-refresh.js missing: the mcp chip says so on a line of its own, the memory chip stays', async ($, on) => {
    await boot($, on, w => w.files.delete(REFRESHER))
    const parts = await paneView($)
    const cards = summarize(parts).cards
    expect(without(cards, 'SYSTEM')).toEqual(without(WORLD_89.cards, 'SYSTEM'))
    expect(cards.SYSTEM?.body).toEqual(systemNoMcp(1))
  })

  test('the refresher that is not there is not run', async ($, on) => {
    const { world } = await boot($, on, w => w.files.delete(REFRESHER))
    expect(world.ran.map(r => r.argv.join(' '))).not.toContain(`node ${REFRESHER}`)
  })

  test('each missing dependency counts toward the footer', async ($, on) => {
    await boot($, on, w => {
      unwire(w, 'subagent-tracker.js', 'file-tracker.js')
      w.files.delete(REFRESHER)
    })
    const parts = await paneView($)
    expect(cardOf(parts, 'SYSTEM').body).toEqual(systemNoMcp(3))
    expect(cardOf(parts, 'ACTIVITY').body).toEqual([
      'in-flight',
      'n/a（subagent-tracker.js',
      'hook not configured）',
      'agents n/a',
      '(subagent-tracker.js',
      'hook not configured)',
      'edited n/a',
      '(file-tracker.js hook',
      'not configured)',
    ])
  })

  test('at 49 columns the same reasons run in full on the footer lines', async ($, on) => {
    await boot($, on, w => unwire(w, 'subagent-tracker.js', 'file-tracker.js'))
    const parts = await paneView($, 49)
    expect(cardOf(parts, 'ACTIVITY').body).toEqual([
      'in-flight n/a（subagent-tracker.js hook not',
      'configured）',
      'agents n/a (subagent-tracker.js hook not',
      'configured)',
      'edited n/a (file-tracker.js hook not',
      'configured)',
    ])
    expect(cardOf(parts, 'SYSTEM').body.at(-1)).toBe(right('2 errors', 43))
  })
})

describe('dependencies: which wiring counts', () => {
  const ok = async ($: Engine) => expectNormal(await paneView($))

  for (const gone of ['SubagentStart', 'SubagentStop']) {
    test(`the agents part needs only one of SubagentStart and SubagentStop (${gone} lost)`, async ($, on) => {
      await boot($, on, w => {
        const hooks = w.settings.hooks as Hooks
        w.settings = { hooks: { ...hooks, [gone]: [] } }
      })
      await ok($)
    })
  }

  test('the summary needs one of summary-updater.js and message-tracker.js: summary-updater.js alone keeps it', async ($, on) => {
    await boot($, on, w => unwire(w, 'message-tracker.js'))
    await ok($)
  })

  test('message-tracker.js alone keeps it too, on UserPromptSubmit', async ($, on) => {
    await boot($, on, w => unwire(w, 'summary-updater.js'))
    await ok($)
  })

  test('and on Stop alone', async ($, on) => {
    await boot($, on, w => {
      unwire(w, 'summary-updater.js', 'message-tracker.js')
      wire(w, 'Stop', 'message-tracker.js')
    })
    await ok($)
  })

  test('a tracker wired to an event it does not read is as good as missing', async ($, on) => {
    const { world } = await boot($, on, w => {
      unwire(w, 'file-tracker.js')
      wire(w, 'PreToolUse', 'file-tracker.js')
    })
    expect(cardOf(await paneView($), 'ACTIVITY').body.join(' ')).toContain(EDITED_NA)
    expect(world.settingsCalls).toBeGreaterThan(0)
  })

  test('the summary updater on Stop does not count (it reads UserPromptSubmit only)', async ($, on) => {
    await boot($, on, w => {
      unwire(w, 'summary-updater.js', 'message-tracker.js')
      wire(w, 'Stop', 'summary-updater.js')
    })
    expect(headerOf(await paneView($)).body[1]).toBe(SUMMARY_NA)
  })
})

describe('dependencies: the merge of the settings can hide a hook', () => {
  // `$.settings.read()` takes a key from the last source that has it: a project's own `hooks` hides the user's
  test('trackers wired in the user settings count though a project hooks key hides them in the merge', async ($, on) => {
    const { world } = await boot($, on, w => {
      w.settingsBySource.user = { hooks: trackerHooks() }
      w.settings = { hooks: { PreToolUse: [{ hooks: [trackerCommand('guard.js')] }] } }
    })
    expectNormal(await paneView($))
    expect(world.settingsCalls).toBeGreaterThan(1)
  })

  for (const source of ['user', 'project', 'local', 'flag', 'policy']) {
    test(`a tracker wired only in the ${source} settings counts`, async ($, on) => {
      await boot($, on, w => {
        unwire(w, 'file-tracker.js')
        w.settingsBySource[source] = { hooks: { PostToolUse: [{ hooks: [trackerCommand('file-tracker.js')] }] } }
      })
      expectNormal(await paneView($))
    })
  }

  test('a tracker that no source wires is still missing', async ($, on) => {
    await boot($, on, w => {
      unwire(w, 'file-tracker.js')
      w.settingsBySource.user = { hooks: { PostToolUse: [{ hooks: [trackerCommand('other.js')] }] } }
    })
    expect(cardOf(await paneView($), 'ACTIVITY').body.join(' ')).toContain(EDITED_NA)
  })

  test('a source that cannot be read counts as a settings read that failed: the verdicts stay', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    unwire(world, 'file-tracker.js')
    world.denySettings = true
    await advance(30_000)
    await clock.settle()
    expect(cardOf(await paneView($), 'ACTIVITY').body.join(' ')).toMatch(EDITED_FILES)
    expect(cardOf(await paneView($), 'ACTIVITY').body.join(' ')).not.toContain('n/a')
  })
})

describe('dependencies: a row switched off is not checked', () => {
  test('with every dependent row off, the model row included, nothing is reported and the settings are not even read', async ($, on) => {
    const { world } = await boot($, on, w => {
      w.files.set(ROWS_FILE, '{"summary":false,"agents":false,"usage":false,"edited":false,"memory_mcp":false,"model":false}')
      w.settings = {}
      w.files.delete(REFRESHER)
    })
    const lines = await paneText($)
    expect(lines.some(l => l.includes('n/a (') && /hook not configured|missing/.test(l))).toBe(false)
    expect(cardOf(await paneView($), 'SYSTEM').body).toEqual(CPU_RAM)
    expect(world.settingsCalls).toBe(0)
  })

  const DEPENDENT = ['summary', 'agents', 'usage', 'edited'] as const
  const SHOWN: Record<(typeof DEPENDENT)[number], (p: PaneParts) => string> = {
    summary: p => headerOf(p).body[1] ?? '',
    agents: p => cardOf(p, 'ACTIVITY').body.join(' '),
    usage: p => cardOf(p, 'CONTEXT').body.slice(2).join(' '),
    edited: p => cardOf(p, 'ACTIVITY').body.join(' '),
  }
  const TEXT: Record<(typeof DEPENDENT)[number], string> = { summary: SUMMARY_NA, agents: AGENTS_NA, usage: COMPACT_NA, edited: EDITED_NA }
  for (const only of DEPENDENT) {
    test(`the ${only} row, the only dependent row on, is still checked`, async ($, on) => {
      const off = Object.fromEntries([...DEPENDENT, 'memory_mcp'].filter(k => k !== only).map(k => [k, false]))
      await boot($, on, w => {
        w.files.set(ROWS_FILE, JSON.stringify(off))
        w.settings = {}
      })
      const parts = await paneView($)
      expect(SHOWN[only](parts)).toContain(TEXT[only])
      expect(cardOf(parts, 'SYSTEM').body.at(-1)).toMatch(/ 1 error$/)
    })
  }

  test('one row off says nothing, the others still report', async ($, on) => {
    await boot($, on, w => {
      w.files.set(ROWS_FILE, '{"agents":false}')
      unwire(w, 'subagent-tracker.js', 'file-tracker.js')
    })
    const parts = await paneView($)
    expect(cardOf(parts, 'ACTIVITY').body).toEqual(['edited n/a', '(file-tracker.js hook', 'not configured)'])
    expect(cardOf(parts, 'SYSTEM').body.at(-1)).toMatch(/ 1 error$/)
  })

  test('the refresher is not looked for when the mcp row is off', async ($, on) => {
    const { world } = await boot($, on, w => {
      w.files.set(ROWS_FILE, '{"memory_mcp":false}')
      w.files.delete(REFRESHER)
    })
    expect(cardOf(await paneView($), 'SYSTEM').body).toEqual(CPU_RAM)
    expect(world.reads).not.toContain(REFRESHER)
  })
})

describe('dependencies: a settings read that fails keeps the previous verdicts', () => {
  // the clock has moved on by now, so the countdowns, the ages and the session length are not the first refresh's: only the files and the errors are
  const quiet = (parts: PaneParts) => {
    expect(cardOf(parts, 'ACTIVITY').body.join(' ')).toMatch(EDITED_FILES)
    expect(cardOf(parts, 'ACTIVITY').body.join(' ')).not.toContain('n/a')
    expect(cardOf(parts, 'SYSTEM').body.join(' ')).not.toContain('error')
  }

  test('a dependency found missing stays missing, and comes back with the next read that works', async ($, on) => {
    const { world, advance, clock } = await boot($, on, w => unwire(w, 'file-tracker.js'))
    expect(cardOf(await paneView($), 'ACTIVITY').body.join(' ')).toContain(EDITED_NA)

    world.settings = { hooks: trackerHooks() }
    world.denySettings = true
    await advance(30_000)
    await clock.settle()
    expect(cardOf(await paneView($), 'ACTIVITY').body.join(' ')).toContain(EDITED_NA)

    world.denySettings = false
    await advance(30_000)
    await clock.settle()
    quiet(await paneView($))
  })

  test('a dependency found wired stays wired, and goes with the next read that works', async ($, on) => {
    const { world, advance, clock } = await boot($, on)
    unwire(world, 'file-tracker.js')
    world.denySettings = true
    await advance(30_000)
    await clock.settle()
    quiet(await paneView($))

    world.denySettings = false
    await advance(30_000)
    await clock.settle()
    expect(cardOf(await paneView($), 'ACTIVITY').body.join(' ')).toContain(EDITED_NA)
  })

  test('a settings read that never answers is given up on after 2 s, and every tracker counts as wired', async ($, on) => {
    const { advance, clock } = await boot($, on, w => {
      w.hang.add('settings.read')
      w.settings = {}
    })
    expect((await paneView($)).cards.map(c => c.body)).toEqual([['waiting for the first refresh']])

    await advance(1900)
    await clock.settle()
    expect((await paneView($)).cards.map(c => c.body)).toEqual([['waiting for the first refresh']])

    await advance(200)
    await clock.settle()
    expectNormal(await paneView($))
  })

  test('with no verdict yet, a read that fails takes every tracker for wired', async ($, on) => {
    await boot($, on, w => {
      w.denySettings = true
      w.settings = {}
    })
    expectNormal(await paneView($))
  })

  test('the verdicts follow the settings from one refresh to the next', async ($, on) => {
    const { world, advance, clock } = await boot($, on, w => unwire(w, 'subagent-tracker.js'))
    expect(cardOf(await paneView($, 49), 'ACTIVITY').body.slice(2, 4)).toEqual(['agents n/a (subagent-tracker.js hook not', 'configured)'])

    wire(world, 'SubagentStart', 'subagent-tracker.js')
    await advance(30_000)
    await clock.settle()
    const parts = await paneView($, 49)
    // half a minute on, the ages in the card have moved: 5m ago reads 6m ago
    expect(cardOf(parts, 'ACTIVITY').body.slice(1, 3)).toEqual([pair('agents', 'general-purp ○', 43), right('Explore ✓×2 6m ago', 43)])
    expect(cardOf(parts, 'SYSTEM').body.join(' ')).not.toContain('error')
  })
})
