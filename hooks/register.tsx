import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { MCP_EVERY_MS, refresh } from './collect'
import type { Io } from './collect'
import { cannotDraw, DEAD_MS, effortFrom, mergeTail, patchLineCount, sidOf, STALE_MS, tailText } from './model'
import { HIST_MAX, layoutTree, paneLayout } from './pane'
import { readBytesCapped } from './sidefile'

const PANE = 'status-pane'
const TICK_MS = 30_000
/** Event-driven refreshes (a turn ended, a file was edited) are spaced at least this far apart. */
const KICK_GAP_MS = 5000
/** The usage ledger lags turn.complete, so one more refresh follows this long after it. */
const FOLLOW_UP_MS = 3000
/** A refresh older than this is given up on, so one hung call cannot freeze the pane for good. */
const STUCK_MS = 60_000
/** The repaint at a stale boundary waits this much past it, so the age has crossed the line when it draws. */
const REPAINT_MARGIN_MS = 1000

const snapA = atom({ plugin: 'status-pane', key: 'snap' } as const, null)
const effortA = atom({ plugin: 'status-pane', key: 'effort' } as const, null)
const pendingA = atom({ plugin: 'status-pane', key: 'pending' } as const, { sid: '', add: 0, rm: 0 })
const outA = atom({ plugin: 'status-pane', key: 'outTokens' } as const, { sid: '', n: 0 })
const cpuA = atom({ plugin: 'status-pane', key: 'cpu' } as const, null)
const histA = atom({ plugin: 'status-pane', key: 'cpuHist' } as const, [] as number[])
const checkedA = atom({ plugin: 'status-pane', key: 'checkedAt' } as const, 0)

/** What one load of the module keeps in memory; everything drawn lives in $.state. */
type Run = {
  timer: Timer | null
  followUp: Timer | null
  repaint: Timer[]
  running: Promise<void> | null
  /** Counts refreshes: only the one that holds the latest number may write or free `running`. */
  epoch: number
  lastTickAt: number
  lastMcpKick: number
}

/** The seam collect.ts reads and writes through; `$` cannot be passed across an import. */
const ioOf = ($: EngineInterface): Io => ({
  now: () => $.clock.now(),
  after: (ms, fn) => $.clock.after(ms, fn),
  sessionId: () => $.session.id(),
  cwd: () => $.session.cwd(),
  model: () => $.session.model(),
  version: async () => (await $.session.version()).version,
  usage: () => $.session.usage(),
  home: () => $.env.get('HOME'),
  tmpdir: () => $.env.get('TMPDIR'),
  effortEnv: () => $.env.get('CLAUDE_EFFORT'),
  settings: source => $.settings.read(source ? { source } : undefined),
  exists: path => $.fs.exists(path),
  read: path => $.fs.read(path),
  readBytes: path => readBytesCapped({ stat: p => $.fs.stat(p), read: p => $.fs.read(p, { as: 'bytes' }) }, path),
  write: (path, text) => $.fs.write(path, text),
  list: path => $.fs.list(path),
  run: (argv, init) => $.process.run(argv, init),
  takeLines: async sid => {
    let taken = { add: 0, rm: 0 }
    // a count under another session id belongs to a session that is gone or yet to come: not ours to take;
    // one found below zero (an older version could leave it so) is cleared and counts as nothing
    await update($, pendingA, p => {
      taken = p.sid === sid ? { add: Math.max(0, p.add), rm: Math.max(0, p.rm) } : { add: 0, rm: 0 }
      return p.sid === sid ? { sid, add: 0, rm: 0 } : p
    })
    return taken
  },
  returnLines: async (sid, add, rm) => {
    // lines of a session that is gone are dropped, not added to the count of the one that came after
    await update($, pendingA, p => (p.sid === sid ? { sid, add: p.add + add, rm: p.rm + rm } : p))
  },
})

/** After a snapshot is written: repaint the pane when its age crosses the stale and the red line, refresh or not. */
const watch = ($: EngineInterface, run: Run): void => {
  for (const t of run.repaint) t.cancel()
  run.repaint = []
  for (const ms of [STALE_MS, DEAD_MS]) {
    try {
      run.repaint.push(
        $.clock.after(ms + REPAINT_MARGIN_MS, () => {
          try {
            $.ui.invalidate('ui.render')
          } catch {
            // nothing is drawn
          }
        }),
      )
    } catch {
      // the next refresh sets them again
    }
  }
}

/** One refresh at a time: a call during a running refresh joins it, unless it has been stuck for STUCK_MS. */
const tick = ($: EngineInterface, run: Run): Promise<void> => {
  if (run.running) return run.running
  const mine = ++run.epoch
  const isCurrent = () => run.epoch === mine
  const watchdog: { timer: Timer | null } = { timer: null }
  const job = (async () => {
    let now = 0
    try {
      now = await $.clock.now()
      run.lastTickAt = now
      const [snap, outTokens, prevCpu, hookEffort] = await Promise.all([
        read($, snapA),
        read($, outA),
        read($, cpuA),
        read($, effortA),
      ])
      if (!isCurrent()) return
      const out = await refresh(ioOf($), {
        now,
        outTokens,
        hookEffort,
        prevCpu,
        prevToggles: snap?.toggles ?? null,
        prevHooks: snap?.hooks ?? null,
        mcpDue: now - run.lastMcpKick >= MCP_EVERY_MS,
        isCurrent,
      })
      if (!isCurrent()) return
      if (out.kickedMcp) run.lastMcpKick = now
      // a reading that was n/a adds no sample; the chart is drawn from the ring, so it goes in before the snapshot
      const cpu = out.snap.cpu
      if (cpu.ok && cpu.v !== null) {
        const pct = cpu.v
        await update($, histA, h => [...h, pct].slice(-HIST_MAX)).catch(() => undefined)
      }
      await update($, snapA, () => out.snap)
      await update($, cpuA, () => out.cpu)
      watch($, run)
    } catch {
      // the last snapshot stays; writing checkedAt makes the pane read the clock again, so its footer shows the age
      try {
        await update($, checkedA, c => Math.max(c + 1, now))
      } catch {
        // the repaint timers of the last snapshot still fire
      }
    } finally {
      watchdog.timer?.cancel()
      if (isCurrent()) run.running = null
    }
  })()
  run.running = job
  try {
    watchdog.timer = $.clock.after(STUCK_MS, () => {
      run.running = null
    })
  } catch {
    // without a watchdog a stuck refresh would block the rest
  }
  return job
}

/** At most one event-driven refresh per KICK_GAP_MS. */
const kick = ($: EngineInterface, run: Run): void => {
  void $.clock
    .now()
    .then(now => {
      if (now - run.lastTickAt >= KICK_GAP_MS) void tick($, run)
    })
    .catch(() => undefined)
}

/** One refresh FOLLOW_UP_MS after a turn, gap or no gap; a refresh that is running when it falls due is waited for. */
const followUp = ($: EngineInterface, run: Run): void => {
  run.followUp?.cancel()
  run.followUp = $.clock.after(FOLLOW_UP_MS, () => {
    const running = run.running
    void (running ? running.then(() => tick($, run)) : tick($, run))
  })
}

const arm = ($: EngineInterface, run: Run): void => {
  run.timer?.cancel()
  run.timer = $.clock.every(TICK_MS, () => {
    void tick($, run)
  })
}

const noteEffort = async ($: EngineInterface, input: unknown): Promise<void> => {
  try {
    const level = effortFrom(input)
    if (!level) return
    const sid = sidOf(await $.session.id())
    await update($, effortA, () => ({ sid, level }))
  } catch {
    // the effort stays what it was
  }
}

export const register: Register = on => {
  const run: Run = {
    timer: null,
    followUp: null,
    repaint: [],
    running: null,
    epoch: 0,
    lastTickAt: Number.NEGATIVE_INFINITY,
    lastMcpKick: Number.NEGATIVE_INFINITY,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'status-pane', description: 'Open the status pane' }).catch(() => undefined)
    void $.ui.open({ id: PANE, title: 'Status' }).catch(() => undefined)
    try {
      arm($, run)
    } catch {
      // the next turn.complete arms it again
    }
    void tick($, run)
    return next(e)
  })

  on('command.run', { command: 'status-pane' }, async $ => {
    const opened = await $.ui
      .open({ id: PANE, title: 'Status' })
      .catch((err: unknown) => ({ isPlaced: false as const, reason: String(err) }))
    return {
      text: opened.isPlaced ? 'Status pane placed.' : `Status pane not placed: ${opened.reason}`,
    }
  })

  on('classic.PostToolUse', async ($, e, next) => {
    await noteEffort($, e)
    return next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    await noteEffort($, e)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      const n = patchLineCount(ran)
      if (n.add > 0 || n.rm > 0) {
        // every loop's edits count as lines, a subagent's included; the count belongs to this session id
        const sid = sidOf(await $.session.id())
        await update($, pendingA, p =>
          p.sid === sid
            ? { sid, add: Math.max(0, p.add) + n.add, rm: Math.max(0, p.rm) + n.rm }
            : { sid, add: n.add, rm: n.rm },
        )
      }
      if (e.tool === 'Edit' || e.tool === 'Write' || n.add > 0 || n.rm > 0) kick($, run)
    } catch {
      // the counters stay what they were
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    try {
      // the tokens figure follows the main loop, so a subagent's turn adds nothing to it
      const out = e.agentId === undefined ? (e.usage?.output_tokens ?? 0) : 0
      if (out > 0) {
        const sid = sidOf(await $.session.id())
        await update($, outA, o => (o.sid === sid ? { sid, n: o.n + out } : { sid, n: out }))
      }
      const snap = await read($, snapA)
      const now = await $.clock.now()
      // timers die when the hooks worker is replaced; a stale snapshot is the sign
      if (!snap || now - snap.at > STALE_MS) arm($, run)
      kick($, run)
      followUp($, run)
    } catch {
      // the 30 s timer carries on
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
      const table = $.ui.resolve(e)
      const snap = await read($, snapA)
      void (await read($, checkedA))
      // the chart is optional: a history that cannot be read costs the chart, not the pane
      const cpuHist = await read($, histA).catch(() => [] as number[])
      const nowMs = await $.clock.now()
      // a Raster is drawn on the terminal only; every other surface gets the text gauge and sparkline
      const raster = e.surface === 'terminal'
      const layout = paneLayout(snap, { columns: e.props.bodyColumns, nowMs, raster, cpuHist })
      return layoutTree(layout, {
        Box: table.Box,
        Text: table.Text,
        Raster: raster && 'Raster' in table ? table.Raster : null,
      })
    } catch (err) {
      // a throw leaves the engine's own empty pane until the next invalidate: one line saying what failed instead
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>{`status-pane n/a (${cannotDraw(err)})`}</Text>
    }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    let ours: string | null = null
    try {
      const snap = await read($, snapA)
      void (await read($, checkedA))
      ours = tailText(snap, await $.clock.now())
    } catch {
      // a tail we cannot work out is left out; whatever an upstream hook put there stays
    }
    if (ours === null) return next(e)
    return next({ ...e, props: { ...e.props, tail: mergeTail(e.props.tail, ours) } })
  })
}
