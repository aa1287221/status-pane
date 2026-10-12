import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { MCP_EVERY_MS, compactWindowOf, readSources, refresh } from './collect'
import type { Io } from './collect'
import { addRun, addStart, bgStartOf, endTask, mayStartBg, noteStop, cannotDraw, DEAD_MS, dropRun, effortFrom, mergeTail, patchLineCount, progressText, runOf, sidOf, STALE_MS, tailText, why } from './model'
import { HIST_MAX, layoutTree, paneLayout } from './pane'
import { readBytesCapped } from './sidefile'
import type { BgStart, InflightState, NowState, Res } from './state'
import { COMPACT_TEXT, compactConfig, fillOf, shouldSuggest } from './compact'
import type { CompactState } from './state'

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
/** While a tool runs the pane repaints this often so its elapsed time moves; not measured, chosen to be cheap. */
const NOW_TICK_MS = 2000

const snapA = atom({ plugin: 'status-pane', key: 'snap' } as const, null)
const effortA = atom({ plugin: 'status-pane', key: 'effort' } as const, null)
const pendingA = atom({ plugin: 'status-pane', key: 'pending' } as const, { sid: '', add: 0, rm: 0 })
const outA = atom({ plugin: 'status-pane', key: 'outTokens' } as const, { sid: '', n: 0 })
const cpuA = atom({ plugin: 'status-pane', key: 'cpu' } as const, null)
const histA = atom({ plugin: 'status-pane', key: 'cpuHist' } as const, [] as number[])
const checkedA = atom({ plugin: 'status-pane', key: 'checkedAt' } as const, 0)
const nowA = atom({ plugin: 'status-pane', key: 'now' } as const, null)
const inflightA = atom({ plugin: 'status-pane', key: 'inflight' } as const, null)
const compactA = atom({ plugin: 'status-pane', key: 'compact' } as const, null as CompactState | null)

/** What one load of the module keeps in memory; everything drawn lives in $.state. */
type Run = {
  timer: Timer | null
  followUp: Timer | null
  repaint: Timer[]
  /** The repaint that moves the elapsed time; set only while a call is in flight. */
  nowTick: Timer | null
  /** Background task ids whose notification row was drawn since the last Stop; a render hook may not write $.state, so BG hides these from memory. */
  ended: Set<string>
  /** The session that drew those notifications; ids of another session hide nothing. */
  endedSid: string | null
  running: Promise<void> | null
  /** Counts refreshes: only the one that holds the latest number may write or free `running`. */
  epoch: number
  lastTickAt: number
  lastMcpKick: number
  /** A /compact suggestion is in flight; a measure that arrives meanwhile sends nothing. */
  suggesting: boolean
  /** Releases `suggesting` if the box never settles. */
  suggestGuard: Timer | null
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
  compactWindowEnv: () => $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW'),
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

/** Starts or stops the repaint that moves NOW's elapsed time. */
const keepTicking = ($: EngineInterface, run: Run, active: boolean): void => {
  if (!active) {
    run.nowTick?.cancel()
    run.nowTick = null
    return
  }
  if (run.nowTick) return
  try {
    run.nowTick = $.clock.every(NOW_TICK_MS, () => {
      try {
        $.ui.invalidate('ui.render')
      } catch {
        // nothing is drawn
      }
    })
  } catch {
    // the elapsed time then moves with the next repaint
  }
}

/** Records the start of a main-loop call; returns its id, or null when nothing was recorded. Never throws. */
const noteStart = async ($: EngineInterface, run: Run, e: { tool: string; tool_use_id?: string; agentId?: string }): Promise<string | null> => {
  try {
    const call = runOf(e, await $.clock.now())
    if (!call) return null
    const sid = sidOf(await $.session.id())
    await update($, nowA, s => addRun(s, sid, call))
    keepTicking($, run, true)
    return call.id
  } catch {
    return null
  }
}

const noteEnd = async ($: EngineInterface, run: Run, id: string | null): Promise<void> => {
  if (id === null) return
  try {
    const sid = sidOf(await $.session.id())
    await update($, nowA, s => dropRun(s, sid, id))
    keepTicking($, run, ((await read($, nowA))?.calls.length ?? 0) > 0)
  } catch {
    // the turn ending clears what is left
  }
}

/** The session has nothing in flight: a start, or the main loop's turn ending. */
const noteIdle = async ($: EngineInterface, run: Run): Promise<void> => {
  try {
    const sid = sidOf(await $.session.id())
    await update($, nowA, () => ({ sid, calls: [] }))
    keepTicking($, run, false)
  } catch {
    // NOW then reads n/a until the next call is recorded
  }
}

/** What the NOW card, BG and /progress are drawn from; each source that cannot be read is its own n/a. */
const progressSources = async (
  $: EngineInterface,
  run: Run,
): Promise<{ tools: Res<NowState | null>; sid: Res<string>; inflight: Res<InflightState | null> }> => {
  const tools: Res<NowState | null> = await read($, nowA).then(
    v => ({ ok: true as const, v }),
    (err: unknown) => ({ ok: false as const, why: `工具紀錄讀不到：${why(err)}` }),
  )
  const inflight: Res<InflightState | null> = await read($, inflightA).then(
    v => ({ ok: true as const, v: [...run.ended].reduce((cur, id) => (cur && run.endedSid !== null ? endTask(cur, run.endedSid, id) : cur), v) }),
    (err: unknown) => ({ ok: false as const, why: `背景工作紀錄讀不到：${why(err)}` }),
  )
  const sid: Res<string> = await $.session.id().then(
    id => ({ ok: true as const, v: sidOf(id) }),
    (err: unknown) => ({ ok: false as const, why: `session id 讀不到：${why(err)}` }),
  )
  return { tools, sid, inflight }
}

/** Records what a background call that went through left, so the Stop snapshot that lists it can say how long it waited. Never throws. */
const noteBgStart = async ($: EngineInterface, start: BgStart | null): Promise<void> => {
  if (!start) return
  try {
    const sid = sidOf(await $.session.id())
    await update($, inflightA, s => addStart(s, sid, start))
  } catch {
    // the wait is then counted from the Stop that lists it
  }
}

/** Keeps the Stop snapshot of the session's own loop; a subagent's Stop is not the session's list. Never throws. */
const noteBgStop = async ($: EngineInterface, run: Run, e: { agent_id?: string; background_tasks?: unknown; session_crons?: unknown }): Promise<void> => {
  if (e.agent_id !== undefined) return
  try {
    // the hidden ids end with the Stop that lists the truth; the next notification starts the set afresh
    run.endedSid = null
    const now = await $.clock.now()
    const sid = sidOf(await $.session.id())
    await update($, inflightA, s => noteStop(s, sid, e, now))
  } catch {
    // BG keeps the snapshot it had
  }
}

/** Records what the box answered; a refusal or no answer re-arms the crossing so the next measure tries again. Never throws. */
const noteSuggest = async ($: EngineInterface, sid: string, at: number, out: { isShown: boolean } | { why: string }): Promise<void> => {
  try {
    const shown = 'isShown' in out && out.isShown
    await update($, compactA, s =>
      s && s.sid === sid ? { ...s, armed: shown ? s.armed : true, last: 'isShown' in out ? { at, isShown: out.isShown } : { at, isShown: null, why: out.why } } : s,
    )
  } catch {
    // the last answer stays; the card then shows the answer before this one
  }
}

/** Decides the CONTEXT hint for one measure that moved context; in suggest mode pre-fills the box once per crossing. Never throws. */
const noteMeasure = async ($: EngineInterface, run: Run, e: { changed: readonly string[]; context: { tokens?: number; window?: number } }): Promise<void> => {
  try {
    if (!e.changed.includes('context')) return
    const snap = await read($, snapA)
    if (!snap || !snap.toggles.enabled || !snap.toggles.rows.usage) return
    const cfg = compactConfig(await $.env.get('STATUS_PANE_CTX_AT'), await $.env.get('STATUS_PANE_CTX_SUGGEST'))
    const sid = sidOf(await $.session.id())
    const now = await $.clock.now()
    // the window is worked out afresh: a /model or a settings edit since the last refresh moves it
    const io = ioOf($)
    const win = await compactWindowOf(io, e.context.window, await readSources(io))
    const d = shouldSuggest(await read($, compactA), sid, fillOf({ tokens: e.context.tokens, window: win?.window ?? e.context.window }), cfg)
    const send = d.fire && cfg.mode === 'suggest' && !run.suggesting
    // the claim is taken before the first await of the send, so a burst folds into one call
    if (send) run.suggesting = true
    let next = d.next
    if (d.fire && cfg.mode === 'observe') next = { ...next, last: { at: now, isShown: null, would: COMPACT_TEXT } }
    if (send) next = { ...next, last: { at: now, isShown: null } }
    try {
      await update($, compactA, () => next)
    } catch {
      run.suggesting = false
      return
    }
    if (!send) return
    try {
      run.suggestGuard?.cancel()
      run.suggestGuard = $.clock.after(3000, () => {
        run.suggesting = false
      })
      void $.prompt
        .suggest({ text: COMPACT_TEXT })
        .then(
          r => noteSuggest($, sid, now, { isShown: r.isShown === true }),
          (err: unknown) => noteSuggest($, sid, now, { why: why(err) }),
        )
        .finally(() => {
          run.suggestGuard?.cancel()
          run.suggesting = false
        })
    } catch {
      run.suggestGuard?.cancel()
      run.suggesting = false
    }
  } catch {
    // the hint keeps what it was; a measure never fails the turn
  }
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
    nowTick: null,
    ended: new Set(),
    endedSid: null,
    running: null,
    epoch: 0,
    lastTickAt: Number.NEGATIVE_INFINITY,
    lastMcpKick: Number.NEGATIVE_INFINITY,
    suggesting: false,
    suggestGuard: null,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'status-pane', description: 'Open the status pane' }).catch(() => undefined)
    // immediate: answers at once while a turn streams; it reads state only, never the turn's
    await $.command
      .register({ name: 'progress', description: 'Show the current tool and how long it has run', immediate: true })
      .catch(() => undefined)
    void noteIdle($, run)
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

  on('command.run', { command: 'progress' }, async $ => {
    try {
      const snap = await read($, snapA)
      const nowMs = await $.clock.now()
      const { tools, sid, inflight } = await progressSources($, run)
      return { text: progressText(snap, tools, sid, nowMs, inflight) }
    } catch (err) {
      return { text: `progress n/a（${cannotDraw(err)}）` }
    }
  })

  on('classic.PostToolUse', async ($, e, next) => {
    await noteEffort($, e)
    return next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    await noteEffort($, e)
    await noteBgStop($, run, e)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const called = await noteStart($, run, e)
    // a call that can leave a task, a subagent's too, is dated before it runs and recorded only once it went through
    const at = mayStartBg(e) ? await $.clock.now().catch(() => null) : null
    let ran
    try {
      ran = await next(e)
    } finally {
      await noteEnd($, run, called)
    }
    const r = ran as { deny?: unknown; isError?: unknown } | null | undefined
    if (at !== null && r?.deny === undefined && r?.isError !== true) await noteBgStart($, bgStartOf(e, ran, at))
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
    // the main loop's turn ending means nothing of it is in flight, whatever ends went unseen
    if (e.agentId === undefined) await noteIdle($, run)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await noteMeasure($, run, e)
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
      const progress = await progressSources($, run)
      // a Raster is drawn on the terminal only; every other surface gets the text gauge and sparkline
      const raster = e.surface === 'terminal'
      const compact = await read($, compactA).catch(() => null)
      const layout = paneLayout(snap, { columns: e.props.bodyColumns, nowMs, raster, cpuHist, progress, compact })
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

  // a task's notification row says it ended: BG hides it without waiting for the next Stop
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const id = e.props.origin?.kind === 'task-notification' ? e.props.task?.id : undefined
    if (id) {
      try {
        const sid = sidOf(await $.session.id())
        if (run.endedSid !== sid) {
          run.ended.clear()
          run.endedSid = sid
        }
        if (run.ended.size < 64) run.ended.add(id)
      } catch {
        // the task then leaves with the next Stop
      }
    }
    return next(e)
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
