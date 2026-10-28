import { FEATURES, type Feature } from '../../features/registry'
import { atLeast, beliefText, plainText, countsPartial, heldForInbox, PREVIEW_HELD_WORDS, creatorLine, GOAL_TO, goalDrift, goalEffect, openClassic, openGallery, openPalette, ownerLine, PARTIAL_WORDS, progressOf, readContext, readPeople, seenOf, shown, sortMotivations, STATUS_WORDS, tasksOf, useHive, type Agent, type Decision, type GoalVerb } from '../sdk'
import { isUnsorted, loadMotivations, loadTaskLinks } from '../../lib/motivations'
import { featuresByGroup, findFeature, NATIVE_CMD, pageOpensClassic, reachLine } from './features'
import { ago, clock, goalList, orderedMinds, orderedSwarms, pad, pendingList, recentDecided, resolveMind, resolveSwarm, slug, bar, shortModel, statusTone, beliefRow, bySureness } from './model'
import { bus, pulse } from './rain'
import { approvalDrift, approvalSeenOf, askedAt } from '../../lib/approvalDecision'
import { accepts } from '../../lib/decisionGate'
import { makeMind } from '../../lib/makeMind'
import { useAskStore } from '../../store/ask'
import { bindEpoch } from '../../lib/identityEpoch'

const alertFlash = () => {
  bus.alert = Math.max(bus.alert, 0.35)
}
import { LAYOUTS, LAYOUT_NOTE, PANES, useC, type LayoutId, type PaneId, type Seg } from './state'
import { plural } from '../../lib/plural'

/**
 * The construct's command language. Every command is parsed here, completed here and run here, through the same
 * store actions the classic UI uses. Output goes to the console (listings) or the flash line (one-line results).
 */

export interface Cand {
  v: string
  d?: string
}

interface Cmd {
  name: string
  usage: string
  desc: string
  more?: string[]
  /** candidates for argument `i` (0-based), given the typed args so far */
  args?: (i: number, args: string[]) => Cand[]
  run(args: string[], rest: (from: number) => string): void | Promise<void>
}

const hive = () => useHive.getState()
const ui = () => useC.getState()
const minds = () => orderedMinds(hive().agents, hive().swarms)
const swarms = () => orderedSwarms(hive().swarms)

/** A phone-width terminal (about 44 columns): listings stack instead of using wide columns. */
const narrow = () => typeof window !== 'undefined' && window.innerWidth < 640

const say = (...segs: Seg[]) => ui().print([segs])
const sayAll = (lines: Seg[][]) => ui().print(lines, { open: true })
const fail = (cmd: string, msg: string, hint?: string[], tip?: string) => {
  const lines: Seg[][] = [[{ t: '✗ ', c: 'red' }, { t: `${cmd}: `, c: 'red' }, { t: msg, c: 'txt' }]]
  if (hint?.length) lines.push([{ t: '  did you mean ', c: 'dim' }, ...hint.flatMap((h, i) => [...(i ? [{ t: ', ', c: 'dim' as const }] : []), { t: h, c: 'hi' as const }]), { t: '?', c: 'dim' }])
  if (tip) lines.push([{ t: `  ${tip}`, c: 'dim' }])
  ui().print(lines)
  alertFlash()
}

const mindCands = (): Cand[] => minds().map((a, i) => ({ v: slug(a.name), d: `#${i + 1} · ${a.status}${a.swarm_id && hive().swarms[a.swarm_id] ? ' · ' + slug(hive().swarms[a.swarm_id].name) : ''}` }))
const swarmCands = (): Cand[] => swarms().map((w) => ({ v: slug(w.name), d: plural(w.member_ids.length, 'mind') }))

const mindArg = (cmd: string, q: string | undefined): Agent | null => {
  if (!q) {
    const open = ui().mind && hive().agents[ui().mind!]
    if (open) return open
    fail(cmd, 'which mind?', undefined, `usage: ${COMMANDS.find((c) => c.name === cmd)?.usage ?? cmd + ' <mind>'}`)
    return null
  }
  const r = resolveMind(q, minds())
  if ('ok' in r) return r.ok
  fail(cmd, r.err, r.hint, 'ls minds lists every mind')
  return null
}

/** Feature completions: every hive feature by id, labelled. */
const featureCands = (): Cand[] => FEATURES.map((f) => ({ v: f.id, d: f.label.toLowerCase() }))

/**
 * Open a feature the construct's way: its native command, or its classic page over the construct. `page` asks for the
 * page: a feature whose classic page does more than its command (`fuller`) opens that page instead of looping back.
 */
export function openFeature(f: Feature, opts: { page?: boolean } = {}): void {
  const n = NATIVE_CMD[f.id]
  if (opts.page && pageOpensClassic(f) && f.classic) {
    say({ t: '↗ ', c: 'hi' }, { t: `opening ${f.label.toLowerCase()}`, c: 'txt' }, { t: '  (close it to come back)', c: 'dim' })
    openClassic(f.classic)
    return
  }
  if (n && !n.arg) {
    void run(n.cmd)
    return
  }
  if (n?.arg) {
    say({ t: '⇢ ', c: 'hi' }, { t: f.label.toLowerCase(), c: 'txt' }, { t: `  ·  ${n.cmd} ${n.arg}`, c: 'dim' })
    ui().focusCmd(`${n.cmd} `)
    return
  }
  if (!f.classic) return fail('page', `${f.label.toLowerCase()} has no page yet`)
  say({ t: '↗ ', c: 'hi' }, { t: `opening ${f.label.toLowerCase()}`, c: 'txt' }, { t: '  (close it to come back)', c: 'dim' })
  openClassic(f.classic)
}

/**
 * One consequential step waiting for `yes` (answers, spawn, goal changes): bound to exactly what was previewed. `yes`
 * counts only as a fresh, separate command after the preview has been on screen for the arming window (ARM_MS), so a
 * recalled or chained `yes` cannot land on a preview nobody has read.
 */
let awaiting: { what: string; at: number; shown: number; ctx: string; go: () => Promise<void> } | null = null
const CONFIRM_MS = 90_000
/** A new session (client) drops a waiting preview: it was shown to someone else. */
export const dropAwaiting = () => {
  awaiting = null
}
const ask = (what: string, lines: Seg[][], go: () => Promise<void>) => {
  awaiting = { what, at: Date.now(), shown: performance.now(), ctx: readContext(hive().client), go }
  sayAll([...lines, [{ t: 'yes', c: 'hi' }, { t: ' to go ahead · ', c: 'dim' }, { t: 'no', c: 'hi' }, { t: ' (or anything else) cancels', c: 'dim' }]])
  ui().focusCmd('')
}

/** Ordered sections of the command reference. */
const SECTIONS: [string, string[]][] = [
  ['SESSION', ['open', 'close', 'say']],
  ['MINDS', ['ls', 'wake', 'sleep', 'start', 'stop', 'inspect', 'spawn']],
  ['SWARMS · WORK', ['swarm', 'beliefs', 'motivations', 'motivation', 'tasks', 'task']],
  ['DECIDE', ['inbox', 'approve', 'deny', 'decided', 'rules', 'stopall', 'yes', 'no']],
  ['WATCH · MONEY · PEOPLE', ['status', 'activity', 'usage', 'people']],
  ['HIVE', ['ask', 'page', 'help', 'palette', 'ui']],
  ['TERMINAL', ['focus', 'layout', 'rain', 'history', 'clear']],
]

const act = async (cmd: string, q: string | undefined, verb: 'wake' | 'sleep' | 'start' | 'stop') => {
  const a = mindArg(cmd, q)
  if (!a) return
  let action = verb
  if (verb === 'wake' && (a.status === 'stopped' || a.status === 'created' || a.status === 'error')) action = 'start'
  if (verb === 'wake' && a.status === 'awake') return say({ t: '· ', c: 'dim' }, { t: shown(a.name), hue: a.hue, c: 'hi' }, { t: ' is already awake', c: 'txt' })
  if (verb === 'sleep' && a.status === 'asleep') return say({ t: '· ', c: 'dim' }, { t: shown(a.name), hue: a.hue, c: 'hi' }, { t: ' is already asleep', c: 'txt' })
  say({ t: '⟳ ', c: 'amber' }, { t: `${action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : action === 'wake' ? 'waking' : 'sleeping'} `, c: 'txt' }, { t: shown(a.name), hue: a.hue, c: 'hi' }, { t: '…', c: 'dim' })
  pulse(0.4)
  const b = bindEpoch()
  const took = await hive().agentAction(a.id, action)
  b.commit(() => {
    const now = hive().agents[a.id]
    if (!took) return fail(cmd, `the hive did not ${action} ${shown(a.name)}`)
    if (now) say({ t: '✓ ', c: 'hi' }, { t: shown(now.name), hue: now.hue, c: 'hi' }, { t: ' is ', c: 'txt' }, { t: now.status, c: statusTone(now.status) as Seg['c'] })
  })
}

/**
 * `approve <n> …` / `deny <n> …` never answer by themselves (Review R2/R3): they preview the whole request (the exact
 * command, why it needs you, who asked, from which swarm, risk, when, its id) and the answer, and `yes` answers that
 * request only while it is still pending and unchanged. The number picks a request from the inbox as listed now; the
 * preview binds the answer to that request's id and content, so a reordered inbox cannot redirect it.
 */
const decideCmd = async (cmd: 'approve' | 'deny', args: string[]) => {
  const list = pendingList(hive().approvals)
  if (!list.length) return fail(cmd, 'the inbox is empty: nothing is waiting for you')
  const n = args[0] ? Number(args[0].replace(/^#/, '')) : list.length === 1 ? 1 : NaN
  if (!Number.isInteger(n) || n < 1 || n > list.length) return fail(cmd, args[0] ? `there is no request #${args[0]} (1–${list.length})` : `which one? ${list.length} are waiting`, undefined, 'inbox lists them with their numbers')
  const ap = list[n - 1]
  let d: Decision = cmd
  let minutes: number | undefined
  const mode = (args[1] ?? '').toLowerCase()
  if (cmd === 'approve' && mode === 'for') {
    d = 'for'
    minutes = Number(args[2] ?? 30)
    if (!(minutes > 0)) return fail(cmd, `'${args[2]}' is not a number of minutes`, undefined, 'approve <n> for <minutes>')
  } else if (cmd === 'approve' && (mode === 'always' || mode === 'remember')) d = 'remember'
  else if (cmd === 'deny' && mode === 'never') d = 'never'
  else if (mode) return fail(cmd, `unknown option '${mode}'`, undefined, cmd === 'approve' ? 'approve <n> [for <minutes> | always]' : 'deny <n> [never]')
  const seen = approvalSeenOf(ap)
  const who = hive().agents[ap.agent_id]
  const sw = who?.swarm_id ? hive().swarms[who.swarm_id] : undefined
  const label = { approve: 'approve once', for: `approve for ${minutes} min`, remember: 'approve always (saves a rule)', deny: 'refuse', never: 'refuse for good (saves a rule)' }[d]
  ask(`${cmd} #${n}`, [
    [{ t: `REQUEST #${n} · ${ap.risk.toUpperCase()} RISK · answer: ${label}`, c: 'inv' }],
    [{ t: 'asks', c: 'dim', w: 8 }, { t: who ? shown(who.name) : 'a mind', hue: who?.hue, c: 'hi' }, { t: `  ${ap.agent_id}`, c: 'dim' }],
    [{ t: 'swarm', c: 'dim', w: 8 }, { t: sw ? shown(sw.name) : who?.swarm_id ?? 'no swarm', c: 'txt' }],
    [{ t: 'skill', c: 'dim', w: 8 }, { t: ap.skill, c: 'hi' }],
    [{ t: 'request', c: 'dim', w: 8 }, { t: ap.command, c: 'txt' }],
    [{ t: 'why', c: 'dim', w: 8 }, { t: ap.reason || 'no rule given: this skill always needs a person', c: 'txt' }],
    [{ t: 'asked', c: 'dim', w: 8 }, { t: askedAt(ap.created_at), c: 'txt' }, { t: `  ·  ${ap.id}`, c: 'dim' }],
  ], async () => {
    const drift = approvalDrift(seen, hive().approvals[seen.id])
    if (drift) return fail(cmd, `${drift.charAt(0).toLowerCase()}${drift.slice(1)}`, undefined, `inbox lists it as it is now; ${cmd} again to review it`)
    say({ t: '⟳ ', c: 'amber' }, { t: `${d === 'deny' || d === 'never' ? 'refusing' : 'approving'} `, c: 'txt' }, { t: ap.skill, c: 'hi' }, { t: who ? ` for ${shown(who.name)}` : '', c: 'txt' })
    const b = bindEpoch()
    const r = await hive().decide(seen.id, d, minutes, seen.session)
    b.commit(() => {
      // UI review S5: a surface-preview build holds the answer for the Inbox (opened, and said there): not a failure
      if (heldForInbox(r)) return say({ t: '→ ', c: 'cyan' }, { t: 'opened the Inbox: ', c: 'txt' }, { t: PREVIEW_HELD_WORDS.body, c: 'dim' })
      if (!r) return fail(cmd, 'the hive did not take the answer; nothing changed')
      pulse(0.5)
      const done = { approve: 'approved once', for: `approved for ${minutes} min`, remember: 'approved always (rule saved)', deny: 'refused', never: 'refused for good (rule saved)' }[d]
      say({ t: '✓ ', c: d === 'deny' || d === 'never' ? 'amber' : 'hi' }, { t: `${ap.skill} `, c: 'hi' }, { t: done, c: 'txt' })
    })
  })
}

export const COMMANDS: Cmd[] = [
  {
    name: 'help',
    usage: 'help [command|features]',
    desc: 'commands by section; help features maps the whole hive',
    args: (i) => (i === 0 ? [{ v: 'features', d: 'every hive feature and how to reach it' }, ...COMMANDS.map((c) => ({ v: c.name, d: c.desc }))] : []),
    run: ([c]) => {
      if (c && /^feat|^map|^all|^every/.test(c.toLowerCase())) return helpFeatures()
      if (c) {
        const cmd = COMMANDS.find((x) => x.name === c.toLowerCase())
        if (!cmd) {
          const f = findFeature(c)
          if (f) return helpFeatures(f.group)
          return fail('help', `no command '${c}'`, closestCmd(c), 'help features lists everything the hive can do')
        }
        return sayAll([[{ t: cmd.usage, c: 'hi' }], [{ t: '  ' + cmd.desc, c: 'txt' }], ...(cmd.more ?? []).map((m) => [{ t: '  ' + m, c: 'dim' as const }])])
      }
      // a phone is ~44 columns: usage on one line, what it does under it
      const row = (x: Cmd): Seg[][] => (narrow() ? [[{ t: '  ' }, { t: x.usage, c: 'hi' }], [{ t: '    ' + x.desc, c: 'dim' }]] : [[{ t: '  ' }, { t: x.usage, c: 'hi', w: 36 }, { t: x.desc, c: 'txt' }]])
      sayAll([
        [{ t: 'CONSTRUCT · command reference', c: 'inv' }],
        ...SECTIONS.flatMap(([title, names]) => [
          [{ t: '' }],
          [{ t: `── ${title} `, c: 'dim' as const }],
          ...names.map((n) => COMMANDS.find((x) => x.name === n)).filter((x): x is Cmd => !!x).flatMap(row),
          ...(title === 'SESSION' ? [[{ t: '  ' }, { t: '> <text>', c: 'hi' as const, w: 36 }, { t: 'say <text> to the open session', c: 'txt' as const }]] : []),
        ]),
        [{ t: '' }],
        [{ t: 'every hive feature: ', c: 'dim' }, { t: 'help features', c: 'hi' }, { t: '  ·  open any of them: ', c: 'dim' }, { t: 'page <feature>', c: 'hi' }, { t: ' (tab completes)', c: 'dim' }],
        [{ t: 'keys  ', c: 'dim' }, { t: 'tab', c: 'hi' }, { t: ' complete · ', c: 'dim' }, { t: '↑↓', c: 'hi' }, { t: ' history · ', c: 'dim' }, { t: 'alt+1..4', c: 'hi' }, { t: ' panes · ', c: 'dim' }, { t: 'alt+l', c: 'hi' }, { t: ' layout · ', c: 'dim' }, { t: 'esc', c: 'hi' }, { t: ' pane keys (j/k ⏎ w s a d)', c: 'dim' }],
        [{ t: 'minds accept a name, a prefix, or their # from the MINDS table', c: 'dim' }],
      ])
    },
  },
  {
    name: 'ls',
    usage: 'ls minds|swarms|motivations|tasks [swarm]',
    desc: 'list minds, swarms, motivations or tasks',
    args: (i, a) => (i === 0 ? [{ v: 'minds', d: 'every mind' }, { v: 'swarms', d: 'every swarm' }, { v: 'motivations', d: 'why the work exists' }, { v: 'tasks', d: 'tasks by swarm' }] : i === 1 && a[0] !== 'swarms' && !a[0]?.startsWith('mot') ? swarmCands() : []),
    run: ([what = 'minds', w]) => {
      const k = what.toLowerCase()
      if (k.startsWith('mind')) return listMinds(w)
      if (k.startsWith('swarm')) return listSwarms()
      if (k.startsWith('mot')) return listMotivations()
      if (k.startsWith('task') || k.startsWith('goal')) return listGoals(w)
      fail('ls', `can't list '${what}'`, ['minds', 'swarms', 'motivations', 'tasks'].filter((x) => x[0] === k[0]), 'ls minds | ls swarms | ls motivations | ls tasks [swarm]')
    },
  },
  {
    name: 'open',
    usage: 'open <mind|feature>',
    desc: 'open a session with a mind, or any hive feature',
    args: (i) => (i === 0 ? [...mindCands(), ...featureCands()] : []),
    run: ([q]) => {
      if (!q) return fail('open', 'which mind?', undefined, 'open <mind>, e.g. open ' + (mindCands()[0]?.v ?? 'vega') + ' · or open <feature>, e.g. open money.usage')
      // a feature id (group.name) is never a mind name
      if (q.includes('.')) {
        const f = findFeature(q)
        if (f) return openFeature(f)
      }
      const r = resolveMind(q, minds())
      if (!('ok' in r)) {
        const f = findFeature(q)
        if (f) return openFeature(f)
      }
      const a = mindArg('open', q)
      if (!a) return
      openSession(a)
      say({ t: '⇢ ', c: 'hi' }, { t: 'session open: ', c: 'txt' }, { t: shown(a.name), hue: a.hue, c: 'hi' }, { t: '  (type to talk · /cmd runs a command · esc back to the prompt)', c: 'dim' })
    },
  },
  {
    name: 'close',
    usage: 'close',
    desc: 'close the open session',
    run: () => {
      ui().openMind(null)
      say({ t: '· session closed', c: 'dim' })
    },
  },
  {
    name: 'say',
    usage: 'say <mind> <text>',
    desc: 'send a message to a mind',
    args: (i) => (i === 0 ? mindCands() : []),
    run: (args, rest) => {
      const text = rest(1)
      if (!args[0] || !text) return fail('say', 'needs a mind and some words', undefined, 'say <mind> <text>, e.g. say vega what are you working on?')
      const a = mindArg('say', args[0])
      if (!a) return
      sendTo(a, text)
    },
  },
  { name: 'wake', usage: 'wake <mind>', desc: 'wake (or start) a mind', args: (i) => (i === 0 ? mindCands() : []), run: ([q]) => act('wake', q, 'wake') },
  { name: 'sleep', usage: 'sleep <mind>', desc: 'put a mind to sleep', args: (i) => (i === 0 ? mindCands() : []), run: ([q]) => act('sleep', q, 'sleep') },
  {
    name: 'start',
    usage: 'start <mind> | start swarm',
    desc: 'start a stopped mind, or a new swarm',
    args: (i) => (i === 0 ? [{ v: 'swarm', d: 'start a new swarm (private by default)' }, ...mindCands()] : []),
    run: ([q, ...rest]) => (q?.toLowerCase() === 'swarm' && !resolveMindExact(q) ? launchSwarm(rest.join(' ')) : act('start', q, 'start')),
  },
  {
    name: 'swarm',
    usage: 'swarm new [name]',
    desc: 'start a new swarm: purpose, roles, visibility (private by default)',
    more: ['swarm new            opens the launch flow over the construct', 'start swarm          the same', 'visibility: private (only you), shared or the whole hive, chosen in the flow'],
    args: (i) => (i === 0 ? [{ v: 'new', d: 'start a new swarm' }] : []),
    run: ([v, ...rest]) => {
      if (!v || v.toLowerCase() !== 'new') return fail('swarm', v ? `unknown '${v}'` : 'swarm what?', ['new'], 'swarm new [name] · ls swarms lists them')
      launchSwarm(rest.join(' '))
    },
  },
  { name: 'stop', usage: 'stop <mind>', desc: 'stop a mind’s process', args: (i) => (i === 0 ? mindCands() : []), run: ([q]) => act('stop', q, 'stop') },
  {
    name: 'inbox',
    usage: 'inbox [tasks|history]',
    desc: 'what is waiting for you',
    args: (i) => (i === 0 ? [{ v: 'approvals', d: 'requests to run skills' }, { v: 'tasks', d: 'tasks of every swarm' }, { v: 'history', d: 'decided requests and the rules' }] : []),
    run: ([t]) => {
      const k = t?.toLowerCase() ?? ''
      const tab = k.startsWith('g') || k.startsWith('t') ? 'goals' : k.startsWith('h') || k.startsWith('d') || k.startsWith('r') ? 'history' : 'approvals'
      ui().setInboxTab(tab)
      ui().setFocus('inbox')
      const list = pendingList(hive().approvals)
      if (tab === 'goals') return listGoals()
      if (tab === 'history') return COMMANDS.find((c) => c.name === 'decided')!.run([], () => '')
      if (!list.length) return say({ t: '✓ ', c: 'hi' }, { t: 'inbox zero: nothing needs you', c: 'txt' })
      sayAll([
        [{ t: `INBOX · ${list.length} waiting`, c: 'inv' }],
        ...list.map((ap, i) => {
          const a = hive().agents[ap.agent_id]
          return [
            { t: `[${i + 1}]`, c: 'hi' as const, w: 5 },
            { t: ap.risk.toUpperCase(), c: (ap.risk === 'high' ? 'red' : ap.risk === 'medium' ? 'amber' : 'txt') as Seg['c'], w: 7 },
            { t: a ? shown(a.name) : ap.agent_id, hue: a?.hue, c: 'hi' as const, w: 12 },
            { t: ap.skill, c: 'txt' as const, w: 18 },
            { t: ap.command, c: 'dim' as const },
          ]
        }),
        [{ t: 'approve <n> [for <min> | always] · deny <n> [never]', c: 'dim' }],
      ])
    },
  },
  {
    name: 'approve',
    usage: 'approve <n> [for <min>|always]',
    desc: 'allow a waiting request',
    more: ['approve 1            once', 'approve 1 for 30     for thirty minutes', 'approve 1 always     and remember the rule'],
    args: (i) => (i === 0 ? pendingCands() : i === 1 ? [{ v: 'for', d: 'for some minutes' }, { v: 'always', d: 'remember the rule' }] : i === 2 ? [{ v: '15' }, { v: '30' }, { v: '60' }] : []),
    run: (args) => decideCmd('approve', args),
  },
  {
    name: 'deny',
    usage: 'deny <n> [never]',
    desc: 'refuse a waiting request',
    args: (i) => (i === 0 ? pendingCands() : i === 1 ? [{ v: 'never', d: 'refuse for good' }] : []),
    run: (args) => decideCmd('deny', args),
  },
  {
    name: 'beliefs',
    usage: 'beliefs <swarm> [filter]',
    desc: 'what a swarm believes, strongest first',
    args: (i) => (i === 0 ? swarmCands() : []),
    run: async (args, rest) => {
      const r = resolveSwarm(args[0] ?? '', swarms())
      if (!('ok' in r)) return fail('beliefs', args[0] ? r.err : 'which swarm?', 'hint' in r ? r.hint : undefined, `swarms: ${swarms().map((w) => slug(w.name)).join(', ')}`)
      const w = r.ok
      const b = bindEpoch()
      try {
        await hive().loadBeliefs(w.id)
      } catch {
        return void b.commit(() => fail('beliefs', `could not load the beliefs of ${shown(w.name)}`))
      }
      // what was read belongs to the person it was read for: printed only while they are still the one signed in
      return void b.commit(() => {
        const filter = rest(1).toLowerCase()
        const list = Object.values(hive().beliefs[w.id] ?? {})
          .filter((b) => !filter || `${b.statement} ${beliefText(b.statement)}`.toLowerCase().includes(filter))
          .sort(bySureness)
        if (!list.length) return say({ t: '· ', c: 'dim' }, { t: `${shown(w.name)} holds no beliefs${filter ? ` matching '${filter}'` : ''} yet`, c: 'txt' })
        pulse(0.3)
        sayAll([
          [{ t: `BELIEFS · ${shown(w.name)} · ${list.length}`, c: 'inv' }],
          // uifix-r3 (S3): how sure in words, the two numbers labelled by their column, the belief as a sentence
          [{ t: 'how sure', c: 'dim', w: 14 }, { t: 'likelihood', c: 'dim', w: 13 }, { t: 'confidence', c: 'dim', w: 13 }, { t: 'belief', c: 'dim' }],
          ...list.slice(0, 60).map(beliefRow),
          ...(list.length > 60 ? [[{ t: `… ${list.length - 60} more · beliefs ${slug(w.name)} <filter> narrows`, c: 'dim' as const }]] : []),
        ])
      })
    },
  },
  {
    name: 'motivations',
    usage: 'motivations',
    desc: 'why the work exists: aims of people, swarms and minds',
    run: () => listMotivations(),
  },
  {
    name: 'motivation',
    usage: 'motivation <n>',
    desc: 'one motivation: its why, whose it is, and its tasks (n from motivations)',
    args: (i) => (i === 0 ? motivationCands() : []),
    run: ([n]) => showMotivation(n),
  },
  TASKS_CMD('tasks'),
  TASK_CMD('task'),
  // the old words still work, and say where the work lives now
  { ...TASKS_CMD('goals'), desc: 'old name for tasks' },
  { ...TASK_CMD('goal'), desc: 'old name for task' },
  {
    name: 'inspect',
    usage: 'inspect <mind>',
    desc: 'open a mind’s full panel (memory, model, schedule)',
    args: (i) => (i === 0 ? mindCands() : []),
    run: ([q]) => {
      const a = mindArg('inspect', q)
      if (a) openClassic({ name: 'dot', id: a.id })
    },
  },
  {
    name: 'page',
    usage: 'page <feature>',
    desc: 'open any hive feature (natively, or its classic page)',
    more: ['page money.usage     the full usage page (open money.usage: spend, natively)', 'page work.motivations  the classic motivations page, over the construct', 'help features        every feature, grouped'],
    args: (i) => (i === 0 ? featureCands() : []),
    run: ([p]) => {
      const f = findFeature(p)
      if (!f) {
        const near = p ? FEATURES.filter((x) => x.id.includes(p.toLowerCase()) || x.label.toLowerCase().includes(p.toLowerCase())).map((x) => x.id).slice(0, 4) : undefined
        return fail('page', p ? `no feature '${p}'` : 'which feature?', near, 'help features lists all of them · tab completes')
      }
      openFeature(f, { page: true })
    },
  },
  {
    name: 'focus',
    usage: 'focus <pane>',
    desc: 'move focus to a pane',
    args: (i) => (i === 0 ? PANES.map((p) => ({ v: p })) : []),
    run: ([p]) => {
      const hit = PANES.find((x) => p && x.startsWith(p.toLowerCase()))
      if (!hit) return fail('focus', p ? `no pane '${p}'` : 'which pane?', undefined, `panes: ${PANES.join(' ')}`)
      ui().setFocus(hit as PaneId)
    },
  },
  {
    name: 'layout',
    usage: 'layout [name]',
    desc: 'cycle or choose the tiling',
    args: (i) => (i === 0 ? LAYOUTS.map((l) => ({ v: l, d: LAYOUT_NOTE[l] })) : []),
    run: ([l]) => {
      const cur = ui().layout
      const next = l ? LAYOUTS.find((x) => x.startsWith(l.toLowerCase())) : LAYOUTS[(LAYOUTS.indexOf(cur) + 1) % LAYOUTS.length]
      if (!next) return fail('layout', `no layout '${l}'`, undefined, `layouts: ${LAYOUTS.join(' ')}`)
      ui().setLayout(next as LayoutId)
      say({ t: '▦ ', c: 'hi' }, { t: `layout ${next}`, c: 'hi' }, { t: ` · ${LAYOUT_NOTE[next as LayoutId]}`, c: 'dim' })
    },
  },
  {
    name: 'rain',
    usage: 'rain on|low|off',
    desc: 'set the digital rain',
    args: (i) => (i === 0 ? [{ v: 'on' }, { v: 'low' }, { v: 'off' }] : []),
    run: ([v = 'on']) => {
      const level = v === 'off' ? 0 : v === 'low' ? 0.45 : v === 'on' ? 1 : NaN
      if (Number.isNaN(level)) return fail('rain', `'${v}'?`, undefined, 'rain on | low | off')
      ui().setRain(level)
      bus.level = level
      say({ t: '≋ ', c: 'hi' }, { t: `rain ${v}`, c: 'txt' })
    },
  },
  {
    name: 'status',
    usage: 'status',
    desc: 'the hive at a glance',
    run: () => {
      const h = hive()
      const all = Object.values(h.agents)
      const awake = all.filter((a) => a.status === 'awake').length
      const thinking = Object.values(h.thinking).filter((t) => t !== 'idle').length
      const spent = all.reduce((s, a) => s + a.spent_usd, 0)
      sayAll([
        [{ t: `${h.hive?.name ?? 'OmegaHive'} ${h.hive?.version ?? ''}`, c: 'inv' }],
        [{ t: 'link', c: 'dim', w: 12 }, { t: h.connection, c: h.connection === 'open' ? 'hi' : 'amber' }],
        [{ t: 'minds', c: 'dim', w: 12 }, { t: `${all.length} · ${awake} awake · ${thinking} thinking`, c: 'txt' }],
        [{ t: 'swarms', c: 'dim', w: 12 }, { t: `${Object.keys(h.swarms).length}`, c: 'txt' }],
        [{ t: 'inbox', c: 'dim', w: 12 }, { t: `${pendingList(h.approvals).length} waiting`, c: pendingList(h.approvals).length ? 'amber' : 'txt' }],
        [{ t: 'spent', c: 'dim', w: 12 }, { t: `$${spent.toFixed(2)}`, c: 'txt' }],
      ])
    },
  },
  {
    name: 'history',
    usage: 'history',
    desc: 'commands you ran',
    run: () => {
      const h = ui().history
      if (!h.length) return say({ t: '· no history yet', c: 'dim' })
      sayAll(h.slice(-30).map((x, i, arr) => [{ t: String(h.length - arr.length + i + 1).padStart(4) + '  ', c: 'dim' }, { t: x, c: 'txt' }]))
    },
  },
  {
    name: 'decided',
    usage: 'decided [n]',
    desc: 'decision history: what was decided, by whom',
    args: (i) => (i === 0 ? [{ v: '20' }, { v: '50' }, { v: '100' }] : []),
    run: async ([n]) => {
      const b = bindEpoch()
      await hive().loadApprovals().catch(() => undefined)
      return void b.commit(() => {
        const most = Math.max(1, Math.min(200, Number(n) || 30))
        const list = recentDecided(hive().approvals, most)
        if (!list.length) return say({ t: '· nothing decided yet', c: 'dim' })
        const h = hive()
        const wide = !narrow()
        sayAll([
          [{ t: `DECIDED · last ${list.length}`, c: 'inv' }],
          [...(wide ? [{ t: 'when', c: 'dim' as const, w: 10 }] : []), { t: 'outcome', c: 'dim', w: 10 }, { t: 'mind', c: 'dim', w: 13 }, { t: 'skill', c: 'dim', w: 18 }, ...(wide ? [{ t: 'by', c: 'dim' as const }] : [])],
          ...list.map((ap) => {
            const a = h.agents[ap.agent_id]
            const ok = ap.status === 'approved' || ap.status === 'used'
            const row: Seg[] = [
              { t: clock(ap.decided_at ?? ap.created_at), c: 'dim' as const, w: 10 },
              { t: ap.status, c: (ok ? 'hi' : ap.status === 'expired' ? 'dim' : 'amber') as Seg['c'], w: 10 },
              { t: a ? shown(a.name) : ap.agent_id, hue: a?.hue, c: 'txt' as const, w: 13 },
              { t: ap.skill, c: 'txt' as const, w: 18 },
              { t: ap.decided_by ?? (ap.status === 'expired' ? 'timed out' : '—'), c: 'dim' as const },
            ]
            return wide ? row : row.slice(1, 4)
          }),
          [{ t: 'rules shows what minds may do without asking · page decide.history for the full record', c: 'dim' }],
        ])
      })
    },
  },
  {
    name: 'rules',
    usage: 'rules',
    desc: 'policy rules: what minds may do without asking',
    run: async () => {
      const b = bindEpoch()
      try {
        await hive().loadPolicy()
      } catch {
        return void b.commit(() => fail('rules', 'could not load the policy rules'))
      }
      return void b.commit(() => {
        const h = hive()
        const list = [...(h.policy ?? [])].sort((a, b) => a.scope.localeCompare(b.scope) || a.skill.localeCompare(b.skill))
        if (!list.length) return say({ t: '· no rules yet: every gated skill asks a person', c: 'dim' })
        const scope = (sc: string) => {
          if (sc === 'hive') return 'hive'
          const [k, id] = sc.split(':')
          const n = k === 'agent' ? h.agents[id]?.name : h.swarms[id]?.name
          return `${k === 'agent' ? 'mind' : 'swarm'}:${n ? slug(n) : id}`
        }
        sayAll([
          [{ t: `RULES · ${list.length}`, c: 'inv' }],
          narrow() ? [{ t: 'mode', c: 'dim', w: 7 }, { t: 'skill', c: 'dim', w: 16 }, { t: 'scope', c: 'dim' }] : [{ t: 'mode', c: 'dim', w: 7 }, { t: 'scope', c: 'dim', w: 22 }, { t: 'skill', c: 'dim', w: 18 }, { t: 'note', c: 'dim' }],
          ...list.flatMap((r): Seg[][] => {
            const mode: Seg = { t: r.mode, c: r.mode === 'allow' ? 'hi' : r.mode === 'deny' ? 'red' : 'amber', w: 7 }
            if (narrow()) return [[mode, { t: r.skill, c: 'hi', w: 16 }, { t: scope(r.scope), c: 'txt' }], ...(r.note ? [[{ t: '       ' + r.note, c: 'dim' as const }]] : [])]
            return [[mode, { t: scope(r.scope), c: 'txt', w: 22 }, { t: r.skill, c: 'hi', w: 18 }, { t: r.note || '—', c: 'dim' }]]
          }),
          [{ t: 'most specific wins: mind > swarm > hive · page decide.rules to change them', c: 'dim' }],
        ])
      })
    },
  },
  {
    name: 'stopall',
    usage: 'stopall',
    desc: 'the kill switch: stop every mind (asks first)',
    run: () => {
      alertFlash()
      hive().setStopAll(true)
    },
  },
  {
    name: 'activity',
    usage: 'activity [n]',
    desc: 'live activity, newest first (the STREAM pane, as a list)',
    run: ([n]) => {
      const h = hive()
      const list = h.activity.slice(0, Math.max(1, Math.min(200, Number(n) || 40)))
      ui().setFocus('stream')
      if (!list.length) return say({ t: '· the hive bus is quiet', c: 'dim' })
      sayAll([
        [{ t: `ACTIVITY · ${list.length}`, c: 'inv' }],
        ...list.map((ev) => {
          const a = ev.agent_id ? h.agents[ev.agent_id] : null
          return [
            { t: clock(ev.at), c: 'dim' as const, w: 10 },
            { t: ev.kind.toUpperCase(), c: (ev.kind === 'error' ? 'red' : ev.kind === 'approval' ? 'amber' : 'txt') as Seg['c'], w: 10 },
            ...(a ? [{ t: shown(a.name) + ' ', hue: a.hue, c: 'hi' as const }] : []),
            { t: ev.statement ? `${plainText(ev.text)} “${beliefText(ev.statement).replace(/\.$/, '')}”` : plainText(ev.text), c: 'txt' as const },
          ]
        }),
      ])
    },
  },
  {
    name: 'usage',
    usage: 'usage',
    desc: 'spend and tokens by mind (read only)',
    run: () => {
      const h = hive()
      const all = Object.values(h.agents).sort((a, b) => b.spent_usd - a.spent_usd)
      const total = all.reduce((t, a) => t + a.spent_usd, 0)
      const budget = all.reduce((t, a) => t + (a.budget_usd || 0), 0)
      const tok = new Map<string, number>()
      for (const u of h.usage) tok.set(u.agent_id, (tok.get(u.agent_id) ?? 0) + u.prompt_tokens + u.completion_tokens)
      const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))
      sayAll([
        [{ t: `USAGE · $${total.toFixed(2)} spent${budget ? ` of $${budget.toFixed(0)} budgeted` : ''}`, c: 'inv' }],
        [{ t: 'mind', c: 'dim', w: 14 }, { t: 'spent', c: 'dim', w: 10 }, { t: 'budget', c: 'dim', w: 22 }, ...(narrow() ? [] : [{ t: 'tokens*', c: 'dim' as const, w: 9 }, { t: 'model', c: 'dim' as const }])],
        ...all.map((a): Seg[] => {
          const frac = a.budget_usd ? a.spent_usd / a.budget_usd : 0
          const row: Seg[] = [
            { t: shown(a.name), hue: a.hue, c: 'hi' as const, w: 14 },
            { t: `$${a.spent_usd.toFixed(2)}`, c: 'txt' as const, w: 10 },
            { t: a.budget_usd ? `▕${bar(frac, 8)}▏ $${a.budget_usd}` : '—', c: (frac > 0.85 ? 'amber' : 'txt') as Seg['c'], w: 22 },
            { t: k(tok.get(a.id) ?? 0), c: 'dim' as const, w: 9 },
            { t: shortModel(a.model), c: 'dim' as const },
          ]
          return narrow() ? row.slice(0, 3) : row
        }),
        [{ t: '* tokens seen live this session · page money.usage for history, limits and settling calls', c: 'dim' }],
      ])
    },
  },
  {
    name: 'people',
    usage: 'people',
    desc: 'who can use this hive (read only)',
    run: async () => {
      if (!hive().client?.listPeople) return fail('people', 'this hive does not list people here', undefined, 'page people.manage opens the people page')
      // Surface K1: the answer belongs to the identity it was read under; a late answer for another one is dropped
      const ctx = readContext(hive().client)
      const b = bindEpoch()
      say({ t: '⟳ ', c: 'amber' }, { t: 'reading the member list…', c: 'dim' })
      try {
        const r = await readPeople()
        if (ctx !== readContext(hive().client) || !b.current()) return
        if (!r) return fail('people', 'this hive does not list people here', undefined, 'page people.manage opens the people page')
        const now = Date.now()
        const waiting = r.invites.filter((i) => i.status === 'pending')
        sayAll([
          [{ t: `PEOPLE · ${r.people.length}${waiting.length ? ` · ${waiting.length} invited` : ''}`, c: 'inv' }],
          ...r.people.map((p) => [
            { t: p.name || p.email.split('@')[0], c: (p.disabled ? 'dim' : 'hi') as Seg['c'], w: 20 },
            { t: p.role, c: (p.role === 'admin' ? 'amber' : 'txt') as Seg['c'], w: 8 },
            { t: p.disabled ? 'disabled' : p.last_seen_at ? `seen ${ago(p.last_seen_at, now)} ago` : 'never seen', c: 'dim' as const, w: 16 },
            { t: narrow() ? '' : p.email, c: 'dim' as const },
          ]),
          ...waiting.map((i) => [{ t: i.name || i.email, c: 'dim' as const, w: 20 }, { t: i.role, c: 'dim' as const, w: 8 }, { t: 'invited', c: 'amber' as const, w: 16 }, { t: i.email, c: 'dim' as const }]),
          [{ t: 'page people.manage to invite or change someone', c: 'dim' }],
        ])
      } catch (e) {
        if (ctx !== readContext(hive().client) || !b.current()) return
        const m = e instanceof Error ? e.message : ''
        fail('people', /403|forbidden|admin/i.test(m) ? 'admins only' : 'could not read the member list', undefined, 'page people.manage opens the people page')
      }
    },
  },
  {
    name: 'spawn',
    usage: 'spawn <name> [in <swarm>] [model <id>] [budget <usd>]',
    desc: 'create a mind (previews, then asks yes)',
    more: ['spawn nova                         a mind in the first swarm, the default model, $10', 'spawn nova in forge budget 5', 'spawn nova model mock/echo', 'page minds.create opens the full creation flow (persona, role, key)'],
    args: (i, a) => {
      const prev = a[i - 1]
      if (prev === 'in') return swarmCands()
      if (prev === 'model') return hive().models.map((m) => ({ v: m.id, d: m.local ? 'local' : m.provider }))
      if (prev === 'budget') return [{ v: '5' }, { v: '10' }, { v: '25' }]
      return i === 0 ? [] : [{ v: 'in', d: 'its swarm' }, { v: 'model', d: 'what it thinks with' }, { v: 'budget', d: 'dollars it may spend' }]
    },
    run: (args) => {
      const name = args[0]
      if (!name || ['in', 'model', 'budget'].includes(name.toLowerCase())) return fail('spawn', 'needs a name', undefined, 'spawn <name> [in <swarm>] [model <id>] [budget <usd>]')
      const h = hive()
      if (Object.values(h.agents).some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail('spawn', `the name '${name}' is taken`)
      const opt = (k: string) => {
        const i = args.findIndex((x, j) => j > 0 && x.toLowerCase() === k)
        return i > 0 ? args[i + 1] : undefined
      }
      let swarm = orderedSwarms(h.swarms)[0] ?? null
      const sq = opt('in')
      if (sq) {
        const r = resolveSwarm(sq, swarms())
        if (!('ok' in r)) return fail('spawn', r.err, r.hint)
        swarm = r.ok
      }
      const mq = opt('model')
      const model = mq ? h.models.find((m) => m.id === mq || m.id.endsWith('/' + mq)) : (h.models.find((m) => m.id.includes('sonnet')) ?? h.models.find((m) => !m.local) ?? h.models[0])
      if (!model) return fail('spawn', mq ? `no model '${mq}'` : 'no models are connected', mq ? closestModel(mq) : undefined, 'page build.models connects providers')
      const bq = opt('budget')
      const budget = bq === undefined ? 10 : Number(bq.replace(/^\$/, ''))
      if (!(budget >= 0) || !Number.isFinite(budget)) return fail('spawn', `'${bq}' is not an amount of dollars`)
      const hue = Math.floor(Math.random() * 360)
      ask(
        `spawn ${name}`,
        [
          [{ t: 'SPAWN · preview', c: 'inv' }],
          [{ t: 'name', c: 'dim', w: 10 }, { t: name, c: 'hi', hue }],
          [{ t: 'swarm', c: 'dim', w: 10 }, { t: swarm ? `${slug(swarm.name)} (${swarm.id})` : 'none', c: 'txt' }],
          [{ t: 'model', c: 'dim', w: 10 }, { t: model.id, c: 'txt' }, { t: model.local ? '  local, free' : '  paid by the hive default key', c: 'dim' }],
          [{ t: 'budget', c: 'dim', w: 10 }, { t: `$${budget}`, c: budget > 0 ? 'amber' : 'txt' }, { t: '  it may spend up to this', c: 'dim' }],
          [{ t: 'visible', c: 'dim', w: 10 }, { t: 'private (only you)', c: 'txt' }],
        ],
        async () => {
          // the preview, read again at the moment of dispatch: the name still free, the swarm and model still there
          const now = hive()
          if (Object.values(now.agents).some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail('spawn', `the name '${name}' was taken since the preview; nothing changed`)
          if (swarm && !now.swarms[swarm.id]) return fail('spawn', `the swarm '${slug(swarm.name)}' is gone since the preview; nothing changed`)
          if (!now.models.some((m) => m.id === model.id)) return fail('spawn', `the model '${model.id}' is no longer offered; nothing changed`)
          say({ t: '⟳ ', c: 'amber' }, { t: 'bringing ', c: 'txt' }, { t: name, c: 'hi', hue }, { t: ' to life…', c: 'txt' })
          // Review O-B2: bound to the session it was dispatched in; its token is shown once, by the hive's own reveal
          // window, and only in that session (lib/makeMind)
          const b = bindEpoch()
          await makeMind({ name, kind: 'omega', swarm_id: swarm?.id ?? null, model: model.id, hue, budget_usd: budget, visibility: 'private' }, (agent) => {
            b.commit(() => {
              pulse(0.9)
              say({ t: '✓ ', c: 'hi' }, { t: shown(agent.name), hue: agent.hue, c: 'hi' }, { t: ' is alive', c: 'txt' }, { t: `  · open ${slug(agent.name)}`, c: 'dim' })
            })
          }, null)
        },
      )
    },
  },
  {
    name: 'yes',
    usage: 'yes',
    desc: 'go ahead with the step just previewed',
    run: async () => {
      const w = awaiting
      if (!w) return fail('yes', 'nothing is waiting for a yes')
      // too soon: the preview stays, read it, then answer
      if (!accepts({ at: performance.now() }, w.shown)) return fail('yes', `'${w.what}' just appeared; read it, then yes`)
      awaiting = null
      // previewed under another hive or person (the client changed): it is not this person's yes to give
      if (w.ctx !== readContext(hive().client)) return fail('yes', `'${w.what}' was previewed for another session; nothing changed`)
      if (Date.now() - w.at > CONFIRM_MS) return fail('yes', `'${w.what}' was previewed too long ago; run it again to see it fresh`)
      const b = bindEpoch()
      try {
        await w.go()
      } catch (e) {
        b.commit(() => fail(w.what.split(' ')[0], e instanceof Error ? e.message : 'it did not go through; nothing changed'))
      }
    },
  },
  {
    name: 'no',
    usage: 'no',
    desc: 'cancel the step just previewed',
    run: () => {
      const w = awaiting
      awaiting = null
      say({ t: '· ', c: 'dim' }, { t: w ? `${w.what}: cancelled, nothing changed` : 'nothing was waiting', c: 'dim' })
    },
  },
  { name: 'clear', usage: 'clear', desc: 'clear the console', run: () => (ui().clear(), ui().setConsole(false)) },
  { name: 'ui', usage: 'ui', desc: 'choose another experience', run: () => openGallery(true) },
  { name: 'palette', usage: 'palette', desc: 'search everything', run: () => openPalette() },
  {
    name: 'ask',
    usage: 'ask [text]',
    desc: 'ask the swarm’s orchestrator; alone, show or hide the ask log',
    more: ['Anything that is not a command is asked too: the fast path first (pages, looks, search), then the orchestrator.', 'While it works, type to steer it; stop ends the turn.'],
    // `ask <text>` is sent by the prompt itself (CommandLine), through the shared Ask; here only the log toggles
    run: () => {
      const s = useAskStore.getState()
      s.setThreadOpen(!s.threadOpen)
      say({ t: '· ', c: 'dim' }, { t: s.threadOpen ? 'ask log hidden' : 'ask log open', c: 'txt' }, { t: '  · ask <text> asks the orchestrator', c: 'dim' })
    },
  },
]

/**
 * Is this the command language (Construct's own grammar parses first), or a request for the Ask? A command is a known
 * command name as the first word, or `>` (say it to the open session). Everything else falls through to the Ask: the
 * fast path, then the orchestrator (UNIVERSAL_ASK_DESIGN §1.2, Construct).
 */
export function isCommandText(input: string): boolean {
  const raw = input.trim()
  if (!raw) return false
  if (raw.startsWith('>')) return true
  const first = raw.split(/\s+/)[0].toLowerCase()
  return COMMANDS.some((c) => c.name === first)
}

/**
 * Where a line typed at the prompt goes (Review's condition for Construct, 2026-10-06): a line whose first word is a
 * command is ALWAYS the command, and if the command refuses or its arguments do not parse, that is the command's own
 * refusal (`run` prints it); it never quietly becomes a request to a model. Only a line whose first word is not a
 * command goes to the Ask (the fast path, then the orchestrator), plus an explicit `ask <text>`.
 */
export type PromptRoute = { to: 'none' } | { to: 'command' } | { to: 'ask'; text: string; forced: boolean }
export function promptRoute(input: string): PromptRoute {
  const raw = input.trim()
  if (!raw) return { to: 'none' }
  const forced = /^ask\s+(\S[\s\S]*)$/i.exec(raw)
  if (forced) return { to: 'ask', text: forced[1].trim(), forced: true }
  if (isCommandText(raw)) return { to: 'command' }
  return { to: 'ask', text: raw, forced: false }
}

/** A previewed step waiting for `yes` is cancelled, visibly, by anything else typed, a request for the Ask included. */
export function cancelAwaiting(): void {
  if (!awaiting) return
  say({ t: '· ', c: 'dim' }, { t: `${awaiting.what}: cancelled, nothing changed`, c: 'dim' })
  awaiting = null
}

const pendingCands = (): Cand[] =>
  pendingList(hive().approvals).map((ap, i) => ({ v: String(i + 1), d: `${ap.skill} · ${shown(hive().agents[ap.agent_id]?.name ?? '')} · ${ap.risk}` }))

const resolveMindExact = (q: string) => minds().find((a) => slug(a.name) === q.toLowerCase())

/** The launch flow (classic, over the construct): it offers Private, Shared or Hive visibility, Private first. */
function launchSwarm(name: string) {
  say({ t: '↗ ', c: 'hi' }, { t: 'starting a new swarm', c: 'txt' }, { t: name ? ` · name it “${name}” in the flow` : '', c: 'hi' }, { t: '  · private by default · close it to come back', c: 'dim' })
  openClassic({ name: 'launch' })
}

const GOAL_VERBS = ['done', 'failed', 'cancel', 'reopen']
const goalCands = (): Cand[] => goalList(hive().goals).slice(0, 80).map((g, i) => ({ v: String(i + 1), d: `${g.status} · ${plainText(g.title).slice(0, 40)}` }))

/** Change a task's status. Numbers come from `tasks`; the preview names the exact task and `yes` binds to its id. */
function patchGoalCmd(verb: string, n: string, name = 'task') {
  const list = goalList(hive().goals)
  const i = Number(n.replace(/^#/, ''))
  const g = list[i - 1]
  if (!g) return fail(name, `there is no task #${n} (1–${list.length})`, undefined, 'tasks lists them with their numbers')
  const to = GOAL_TO[verb as GoalVerb]
  if (g.status === to) return say({ t: '· ', c: 'dim' }, { t: `“${plainText(g.title)}” is already ${to}`, c: 'txt' })
  const sw = hive().swarms[g.swarm_id]
  const id = g.id
  // Review D1: `yes` binds to the goal exactly as previewed (status, holder, swarm, title, version), not just its id
  const seen = seenOf(g)
  const holder = g.claimed_by ? hive().agents[g.claimed_by.replace(/^agent:/, '')] : null
  const holderName = holder ? slug(holder.name) : g.claimed_by
  ask(`${name} ${verb} #${i}`, [
    [{ t: `TASK · ${g.status} → ${to}`, c: 'inv' }],
    [{ t: 'task', c: 'dim', w: 8 }, { t: `“${plainText(g.title)}”`, c: 'hi' }],
    [{ t: 'holder', c: 'dim', w: 8 }, { t: holderName ?? 'nobody', c: 'txt' }],
    [{ t: 'swarm', c: 'dim', w: 8 }, { t: sw ? slug(sw.name) : g.swarm_id, c: 'txt' }, { t: `  ·  ${id}`, c: 'dim' }],
    [{ t: 'effect', c: 'dim', w: 8 }, { t: goalEffect(g, to, holderName ?? null), c: 'txt' }],
  ], async () => {
    const drift = goalDrift(seen, hive().goals[id], to)
    if (drift) return fail(name, `${drift.charAt(0).toLowerCase()}${drift.slice(1)}`, undefined, `tasks lists it as it is now; ${name} ${verb} again to review it`)
    // Kimi #2 (next22): stamped with the session the goal was previewed under; Review B1: a lost answer is never
    // "is still …": the store reads the goal again and says what it shows
    const b = bindEpoch()
    const r = await hive().writeGoal(id, { status: to }, seen.session)
    // the outcome belongs to the person who said yes: printed only while they are still the one signed in
    return void b.commit(() => {
      if (r.kind === 'taken') return say({ t: '✓ ', c: 'hi' }, { t: `“${plainText(g.title)}” `, c: 'hi' }, { t: `is ${to}`, c: 'txt' }, { t: r.checked ? '  · the answer was lost; read again, the change is there' : '', c: 'dim' })
      if (r.kind === 'refused') return say({ t: '✗ ', c: 'red' }, { t: `“${plainText(g.title)}” `, c: 'hi' }, { t: `is still ${hive().goals[id]?.status ?? 'unknown'}`, c: 'txt' })
      say({ t: '? ', c: 'amber' }, { t: `“${plainText(g.title)}” `, c: 'hi' }, { t: r.why, c: 'txt' }, { t: r.kind === 'unknown' ? `  · Check again on the notice reads it; ${name} ${verb} again after that` : `  · ${name} ${verb} again to review it`, c: 'dim' })
    })
  })
}

const closestModel = (q: string) => hive().models.map((m) => m.id).filter((id) => id.includes(q.toLowerCase().split('/').pop() ?? q)).slice(0, 3)

/** The whole hive as a map: every feature, grouped, with the command (native) or page that reaches it. */
function helpFeatures(only?: string) {
  const groups = featuresByGroup().filter(([g]) => !only || g === only)
  const native = FEATURES.filter((f) => NATIVE_CMD[f.id]).length
  sayAll([
    [{ t: `HIVE MAP · ${FEATURES.length} features · ${native} native here`, c: 'inv' }],
    ...groups.flatMap(([, label, list]) => [
      [{ t: '' }],
      [{ t: `── ${label.toUpperCase()} `, c: 'dim' as const }],
      ...list.flatMap((f) => {
        const r = reachLine(f)
        const mark: Seg = { t: r.native ? '  ● ' : '  ○ ', c: r.native ? 'hi' : 'dim' }
        const how: Seg = { t: r.how, c: r.native ? 'hi' : 'cyan' }
        const out: Seg[][] = narrow() ? [[mark, { t: f.label.toLowerCase(), c: 'txt' }], [{ t: '      ' }, how]] : [[mark, { t: pad(f.label.toLowerCase(), 31), c: 'txt', w: 32 }, how]]
        return out
      }),
    ]),
    [{ t: '' }],
    [{ t: '● native in the construct · ○ opens its page over the construct · ', c: 'dim' }, { t: 'page <feature>', c: 'hi' }, { t: ' opens any of them', c: 'dim' }],
  ])
}

function closestCmd(q: string): string[] {
  const names = COMMANDS.map((c) => c.name)
  return names.filter((n) => n.startsWith(q.slice(0, 2).toLowerCase())).slice(0, 3).concat(names.filter((n) => q.length > 2 && n.includes(q.slice(1, 3)))).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3)
}

export function openSession(a: Agent, focus = true) {
  const list = minds()
  ui().openMind(a.id)
  ui().setMindSel(Math.max(0, list.findIndex((x) => x.id === a.id)))
  if (focus) ui().focusSession()
  void hive().loadMessages(a.id).catch(() => undefined)
  pulse(0.35)
}

export function sendTo(a: Agent, text: string) {
  void hive().sendMessage(a.id, text)
  if (ui().mind !== a.id) openSession(a, false)
  pulse(0.5)
  say({ t: '▸ ', c: 'cyan' }, { t: 'to ', c: 'dim' }, { t: shown(a.name), hue: a.hue, c: 'hi' }, { t: `: ${text}`, c: 'txt' })
}

function listMinds(w?: string) {
  let list = minds()
  const all = list
  if (w) {
    const r = resolveSwarm(w, swarms())
    if (!('ok' in r)) return fail('ls', r.err, r.hint)
    list = list.filter((a) => a.swarm_id === r.ok.id)
  }
  if (!list.length) return say({ t: '· no minds yet · ', c: 'dim' }, { t: 'page new', c: 'hi' }, { t: ' creates one', c: 'dim' })
  const h = hive()
  sayAll([
    [{ t: `MINDS · ${list.length}`, c: 'inv' }],
    [{ t: '#', c: 'dim', w: 4 }, { t: 'name', c: 'dim', w: 14 }, { t: 'swarm', c: 'dim', w: 16 }, { t: 'state', c: 'dim', w: 10 }, { t: 'model', c: 'dim', w: 24 }, { t: 'spent', c: 'dim' }],
    ...list.map((a) => [
      { t: String(all.indexOf(a) + 1), c: 'dim' as const, w: 4 },
      { t: shown(a.name), hue: a.hue, c: 'hi' as const, w: 14 },
      { t: a.swarm_id && h.swarms[a.swarm_id] ? slug(h.swarms[a.swarm_id].name) : '—', c: 'txt' as const, w: 16 },
      { t: a.status, c: statusTone(a.status) as Seg['c'], w: 10 },
      { t: pad(shortModel(a.model), 23), c: 'dim' as const, w: 24 },
      { t: `$${a.spent_usd.toFixed(2)}${a.budget_usd ? ` / $${a.budget_usd}` : ''}`, c: 'txt' as const },
    ]),
    [{ t: 'open <mind> · wake <mind> · sleep <mind>', c: 'dim' }],
  ])
}

function listSwarms() {
  const list = swarms()
  if (!list.length) return say({ t: '· no swarms yet', c: 'dim' })
  const h = hive()
  sayAll([
    [{ t: `SWARMS · ${list.length}`, c: 'inv' }],
    ...list.map((w) => {
      const members = w.member_ids.map((id) => h.agents[id]).filter(Boolean)
      const awake = members.filter((a) => a.status === 'awake').length
      return [
        { t: slug(w.name), hue: w.hue, c: 'hi' as const, w: 18 },
        { t: `${plural(members.length, 'mind')} · ${awake} awake`, c: 'txt' as const, w: 22 },
        { t: w.description || '—', c: 'dim' as const },
      ]
    }),
    [{ t: 'beliefs <swarm> · motivations · tasks <swarm> · task <swarm> <title>', c: 'dim' }],
  ])
}

/** `tasks` and its old name `goals`: tasks with who holds them; `tasks for <n>` (a motivation's number) or `tasks unsorted`. */
function TASKS_CMD(name: string): Cmd {
  return {
    name,
    usage: `${name} [swarm] | ${name} for <n> | ${name} unsorted`,
    desc: 'tasks, who holds them, and the motivations they serve',
    args: (i) => (i === 0 ? [{ v: 'for', d: 'the tasks of one motivation' }, { v: 'unsorted', d: 'tasks under no motivation you can see' }, ...swarmCands()] : []),
    run: ([w, n]) => {
      const k = w?.toLowerCase()
      if (k === 'for') return listGoals(undefined, n ? { motivation: n } : undefined)
      if (k === 'unsorted' || k === 'none') return listGoals(undefined, { unsorted: true })
      return listGoals(w)
    },
  }
}

/** `task` and its old name `goal`: post one, or change one's status through the confirm (Review D1). */
function TASK_CMD(name: string): Cmd {
  return {
    name,
    usage: `${name} <swarm> <title> | ${name} done|failed|cancel|reopen <n>`,
    desc: 'give a swarm a new task, or change one (n from tasks)',
    more: [`${name} forge map the north shore    a new task for forge`, `${name} done 3                       mark task #3 (from tasks) done`, `${name} reopen 2                     put a stalled or finished task back to open`],
    args: (i, a) => (i === 0 ? [...GOAL_VERBS.map((v) => ({ v, d: `mark a task ${v === 'reopen' ? 'open again' : v}` })), ...swarmCands()] : i === 1 && GOAL_VERBS.includes(a[0]) ? goalCands() : []),
    run: async (args, rest) => {
      const verb = args[0]?.toLowerCase()
      if (verb && GOAL_VERBS.includes(verb) && args[1] && /^#?\d+$/.test(args[1])) return patchGoalCmd(verb, args[1], name)
      const title = rest(1)
      if (!args[0] || !title) return fail(name, 'needs a swarm and a title', undefined, `${name} <swarm> <title>, e.g. ${name} ${swarmCands()[0]?.v ?? 'lyra'} map the north shore`)
      const r = resolveSwarm(args[0], swarms())
      if (!('ok' in r)) return fail(name, r.err, r.hint)
      say({ t: '⟳ ', c: 'amber' }, { t: 'posting task to ', c: 'txt' }, { t: shown(r.ok.name), hue: r.ok.hue, c: 'hi' })
      const b = bindEpoch()
      const g = await hive().createGoal(r.ok.id, { title })
      b.commit(() => {
        if (!g) return
        pulse(0.6)
        say({ t: '✓ ', c: 'hi' }, { t: 'task posted: ', c: 'txt' }, { t: `“${plainText(g.title)}”`, c: 'hi' }, { t: ` → ${shown(r.ok.name)} (${g.status})`, c: 'dim' })
      })
    },
  }
}

/** Motivations this person can read, in reading order (the numbers `motivation <n>` and `tasks for <n>` use). */
const motivationList = () => sortMotivations(Object.values(hive().motivations))
const motivationCands = (): Cand[] => motivationList().slice(0, 40).map((m, i) => ({ v: String(i + 1), d: `${m.status} · ${m.title.slice(0, 40)}` }))
const nameCtx = () => ({ me: null, agents: hive().agents, swarms: hive().swarms })

/** Load what the motivation commands read, once; says so when the hive keeps none. */
function readyMotivations(): boolean {
  const h = hive()
  if (!h.client?.listMotivations) {
    say({ t: '· ', c: 'dim' }, { t: 'this hive does not keep motivations yet; tasks work as before', c: 'txt' })
    return false
  }
  if (!h.motivationsLoaded || !h.taskLinksLoaded) {
    const b = bindEpoch()
    void Promise.all([loadMotivations(), loadTaskLinks()]).then(
      () => b.commit(() => say({ t: '· ', c: 'dim' }, { t: 'motivations read · run it again', c: 'txt' })),
      () => b.commit(() => say({ t: '✗ ', c: 'red' }, { t: 'could not read motivations', c: 'txt' })),
    )
    say({ t: '⟳ ', c: 'amber' }, { t: 'reading motivations…', c: 'txt' })
    return false
  }
  return true
}

function listMotivations() {
  if (!readyMotivations()) return
  const h = hive()
  const list = motivationList()
  if (!list.length) return say({ t: '· no motivations you can see yet', c: 'dim' }, { t: ' · page work.motivations names one', c: 'dim' })
  // a read that did not finish makes these counts floors (stand-in P2-4 on 57e64ca)
  const partial = countsPartial(h)
  sayAll([
    [{ t: `MOTIVATIONS · ${atLeast(list.length, partial)}`, c: 'inv' }],
    ...list.map((m, i) => {
      const p = progressOf(tasksOf(m.id, h.taskLinks), h.goals)
      // everything printed from it is tagged: redacted here the moment this person can no longer read it (stand-in P1-1 on 57e64ca)
      return [
        { t: `[${i + 1}]`, c: 'hi' as const, w: 6 },
        { t: m.status, c: (m.status === 'active' ? 'hi' : m.status === 'paused' ? 'amber' : 'dim') as Seg['c'], w: 10, mot: m.id },
        { t: `${p.done}/${atLeast(p.total - p.cancelled, partial)}`, c: 'dim' as const, w: 8, mot: m.id },
        { t: m.title, c: 'txt' as const, mot: m.id },
        { t: `  · ${ownerLine(m, nameCtx())} · ${creatorLine(m, nameCtx())}`, c: 'dim' as const, mot: m.id },
      ]
    }),
    ...(partial ? [[{ t: `· counts ${PARTIAL_WORDS}`, c: 'amber' as const }]] : []),
    [{ t: 'motivation <n> shows one · tasks for <n> lists its tasks · tasks unsorted lists the rest · page work.motivations changes them', c: 'dim' }],
  ])
}

function showMotivation(n?: string) {
  if (!readyMotivations()) return
  const h = hive()
  const list = motivationList()
  const m = n && /^#?\d+$/.test(n) ? list[Number(n.replace(/^#/, '')) - 1] : undefined
  if (!m) return fail('motivation', n ? `there is no motivation #${n} (1–${list.length})` : 'which one?', undefined, 'motivations lists them with their numbers')
  const ids = tasksOf(m.id, h.taskLinks)
  const p = progressOf(ids, h.goals)
  const partial = countsPartial(h)
  sayAll([
    // everything below is printed from it, so all of it is tagged (stand-in P1-1 on 57e64ca)
    [{ t: 'MOTIVATION · ', c: 'inv' }, { t: STATUS_WORDS[m.status], c: 'inv', mot: m.id }],
    [{ t: 'what', c: 'dim', w: 8 }, { t: m.title, c: 'hi', mot: m.id }],
    ...(m.why ? [[{ t: 'why', c: 'dim' as const, w: 8 }, { t: m.why, c: 'txt' as const, mot: m.id }]] : []),
    [{ t: 'whose', c: 'dim', w: 8 }, { t: `${ownerLine(m, nameCtx())} · ${creatorLine(m, nameCtx())}`, c: 'txt', mot: m.id }],
    [{ t: 'tasks', c: 'dim', w: 8 }, { t: `${p.done} of ${atLeast(p.total - p.cancelled, partial)} done${p.failed ? ` · ${p.failed} failed` : ''}${p.cancelled ? ` · ${p.cancelled} cancelled (not counted)` : ''}${partial ? ` · ${PARTIAL_WORDS}` : ''}`, c: 'txt', mot: m.id }],
    ...ids.slice(0, 12).map((id) => [{ t: '', w: 8 }, { t: h.goals[id]?.status ?? '?', c: 'dim' as const, w: 11, mot: m.id }, { t: h.goals[id]?.title ?? id, c: 'txt' as const, mot: m.id }]),
    [{ t: `tasks for ${list.indexOf(m) + 1} lists them with numbers · page work.motivations to change it or file tasks under it`, c: 'dim' }],
  ])
}

function listGoals(w?: string, by?: { motivation?: string; unsorted?: boolean }) {
  const h = hive()
  let sid: string | null = null
  if (w) {
    const r = resolveSwarm(w, swarms())
    if (!('ok' in r)) return fail('goals', r.err, r.hint)
    sid = r.ok.id
    void h.loadGoals(sid).catch(() => undefined)
  }
  let mo: string | null = null
  if (by?.motivation) {
    if (!readyMotivations()) return
    const m = /^#?\d+$/.test(by.motivation) ? motivationList()[Number(by.motivation.replace(/^#/, '')) - 1] : undefined
    if (!m) return fail('tasks', `there is no motivation #${by.motivation}`, undefined, 'motivations lists them with their numbers')
    mo = m.id
  }
  if (by?.unsorted && !readyMotivations()) return
  const refs = (id: string) => h.taskLinks[id] ?? []
  const list = goalList(h.goals).filter((g) => (!sid || g.swarm_id === sid) && (!mo || refs(g.id).some((r) => r.id === mo)) && (!by?.unsorted || isUnsorted(h.taskLinks, g.id)))
  if (!list.length) return say({ t: '· no tasks', c: 'dim' }, { t: sid || mo || by?.unsorted ? ' here' : ' yet', c: 'dim' }, { t: ' · task <swarm> <title> posts one', c: 'dim' })
  const all = goalList(h.goals)
  sayAll([
    [
      { t: `TASKS · ${mo || by?.unsorted ? atLeast(list.length, countsPartial(h)) : list.length}`, c: 'inv' },
      ...(mo ? [{ t: ' · for “', c: 'inv' as const }, { t: h.motivations[mo]?.title ?? '', c: 'inv' as const, mot: mo }, { t: '”', c: 'inv' as const }] : by?.unsorted ? [{ t: ' · under no motivation you can see', c: 'inv' as const }] : []),
      ...((mo || by?.unsorted) && countsPartial(h) ? [{ t: ` · ${PARTIAL_WORDS}`, c: 'amber' as const }] : []),
    ],
    ...list.slice(0, 80).map((g) => {
      const holder = g.claimed_by ? h.agents[g.claimed_by] : null
      const sw = h.swarms[g.swarm_id]
      return [
        { t: `[${all.indexOf(g) + 1}]`, c: 'hi' as const, w: 6 },
        { t: g.status, c: (g.status === 'stalled' || g.status === 'failed' ? 'red' : g.status === 'waiting' ? 'amber' : g.status === 'done' ? 'dim' : 'hi') as Seg['c'], w: 11 },
        { t: sw ? slug(sw.name) : '—', c: 'dim' as const, w: 15 },
        { t: holder ? shown(holder.name) : '·', hue: holder?.hue, c: 'txt' as const, w: 11 },
        // under `tasks for <n>`, that this task is listed at all comes from the motivation (stand-in P1-1 on 57e64ca)
        { t: plainText(g.title), c: 'txt' as const, ...(mo ? { mot: mo } : {}) },
        ...(refs(g.id).length ? [{ t: '  ◎ ', c: 'dim' as const }, { t: refs(g.id)[0].title, c: 'dim' as const, mot: refs(g.id)[0].id }, ...(refs(g.id).length > 1 ? [{ t: ` +${refs(g.id).length - 1}`, c: 'dim' as const }] : [])] : []),
      ]
    }),
    [{ t: 'task <swarm> <title> posts one · task done|failed|cancel|reopen <n> changes one · motivations shows the why', c: 'dim' }],
  ])
}

// ------------------------------------------------------------------ parsing and completion

export function tokenize(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean)
}

/** Text after the first `n` tokens, verbatim. */
function restAfter(s: string, n: number): string {
  let i = 0
  const t = s.replace(/^\s+/, '')
  let rest = t
  while (i < n) {
    const m = rest.match(/^\S+\s*/)
    if (!m) return ''
    rest = rest.slice(m[0].length)
    i++
  }
  return rest.trim()
}

export interface Completion {
  cands: Cand[]
  /** index in the input where the token being completed starts */
  start: number
  token: string
  /** usage of the command being typed */
  usage?: string
  desc?: string
}

export function complete(input: string): Completion {
  const lead = input.match(/^\s*/)![0].length
  if (input.trimStart().startsWith('>')) return { cands: [], start: input.length, token: '', usage: '> <text>', desc: 'say it to the open session' }
  const endsSpace = /\s$/.test(input)
  const toks = tokenize(input)
  const tokenIdx = endsSpace || !toks.length ? toks.length : toks.length - 1
  const token = endsSpace || !toks.length ? '' : toks[toks.length - 1]
  const start = endsSpace || !toks.length ? Math.max(lead, input.length) : input.length - token.length
  const filter = (list: Cand[]) => {
    const t = token.toLowerCase()
    const pre = list.filter((c) => c.v.toLowerCase().startsWith(t))
    if (pre.length || !t) return pre
    return list.filter((c) => c.v.toLowerCase().includes(t))
  }
  if (tokenIdx === 0) {
    const cands = filter(COMMANDS.map((c) => ({ v: c.name, d: c.desc })))
    const exact = COMMANDS.find((c) => c.name === token.toLowerCase())
    return { cands: exact && cands.length === 1 ? [] : cands, start, token, usage: exact?.usage, desc: exact?.desc }
  }
  const cmd = COMMANDS.find((c) => c.name === toks[0].toLowerCase())
  if (!cmd) return { cands: [], start, token }
  const args = toks.slice(1)
  const cands = cmd.args ? filter(cmd.args(tokenIdx - 1, args.map((a) => a.toLowerCase()))) : []
  const exact = cands.length === 1 && cands[0].v.toLowerCase() === token.toLowerCase()
  return { cands: exact ? [] : cands, start, token, usage: cmd.usage, desc: cmd.desc }
}

export async function run(input: string): Promise<void> {
  const raw = input.trim()
  if (!raw) return
  // never recorded: yes/no (a recalled yes must not land on a fresh preview) and what was said to a mind (history is
  // kept on this device, for anyone who uses it next)
  if (!/^(yes|no|say)$/i.test(raw.split(/\s+/)[0]) && !raw.startsWith('>')) ui().pushHistory(raw)
  ui().echo([{ t: '❯ ', c: 'cyan' }, { t: raw, c: 'txt' }])
  // a previewed step waits for `yes` and nothing else: anything other than yes/no cancels it, visibly
  const first = raw.split(/\s+/)[0].toLowerCase()
  if (awaiting && first !== 'yes' && first !== 'no') {
    say({ t: '· ', c: 'dim' }, { t: `${awaiting.what}: cancelled, nothing changed`, c: 'dim' })
    awaiting = null
  }
  if (raw.startsWith('>')) {
    const text = raw.slice(1).trim()
    const id = ui().mind
    const a = id ? hive().agents[id] : null
    if (!a) return fail('>', 'no session is open', undefined, 'open <mind> first, or say <mind> <text>')
    if (!text) return fail('>', 'say what?', undefined, '> <text>')
    return sendTo(a, text)
  }
  const toks = tokenize(raw)
  const name = toks[0].toLowerCase()
  const cmd = COMMANDS.find((c) => c.name === name)
  if (!cmd) {
    const mind = resolveMind(name, minds())
    const tip = 'ok' in mind ? `to talk to ${slug(mind.ok.name)}: say ${slug(mind.ok.name)} ${restAfter(raw, 1) || '<text>'}` : ui().mind ? `to talk to the open session, start with >  (e.g. > ${raw})` : 'help lists every command'
    return fail(name, 'unknown command', closestCmd(name), tip)
  }
  const b = bindEpoch()
  try {
    await cmd.run(toks.slice(1), (n) => restAfter(raw, n + 1))
  } catch (e) {
    b.commit(() => fail(name, e instanceof Error ? e.message : 'something went wrong'))
  }
}
