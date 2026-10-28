import { create } from 'zustand'
import { useHive, type Approval } from '../sdk'
import { onIdentityChange } from '../../lib/identityEpoch'
import { useAskStore } from '../../store/ask'

/** Construct's own UI state (never hive data): which pane has focus, the tiling, the open session, the console. */

export type PaneId = 'stream' | 'minds' | 'session' | 'inbox'
export const PANES: PaneId[] = ['stream', 'minds', 'session', 'inbox']
export const PANE_TITLE: Record<PaneId, string> = { stream: 'STREAM', minds: 'MINDS', session: 'SESSION', inbox: 'INBOX' }

export type LayoutId = 'operator' | 'quad' | 'stack' | 'monocle'
export const LAYOUTS: LayoutId[] = ['operator', 'quad', 'stack', 'monocle']
export const LAYOUT_NOTE: Record<LayoutId, string> = {
  operator: 'minds + stream left, session centre, inbox right',
  quad: 'four equal tiles',
  stack: 'session as master, the rest stacked',
  monocle: 'one pane full screen (alt+1..4 to switch)',
}

export type Tone = 'hi' | 'txt' | 'dim' | 'amber' | 'red' | 'cyan' | 'inv'
export interface Seg {
  t: string
  c?: Tone
  /** identity colour swatch drawn before the text */
  hue?: number
  /** pad to this many columns */
  w?: number
  /** The motivation whose words this is (its title or why). Redacted the moment this person can no longer read it. */
  mot?: string
}
export interface Line {
  id: number
  segs: Seg[]
  /** a copy of the shared Ask (a request as typed, the orchestrator's presence): the Ask epoch it was copied under */
  ask?: number
}

export type InboxTab = 'approvals' | 'goals' | 'history'
export const INBOX_TABS: InboxTab[] = ['approvals', 'goals', 'history']

interface CState {
  focus: PaneId
  layout: LayoutId
  /** true only while panes morph between tilings (framer measures layout only then) */
  morphing: boolean
  /** agent id of the open session */
  mind: string | null
  mindSel: number
  inboxSel: number
  inboxTab: InboxTab
  console: Line[]
  consoleOpen: boolean
  /** the last result, shown under the prompt for a few seconds */
  flash: { id: number; lines: Seg[][] } | null
  history: string[]
  /** bumps to make a pane glitch */
  glitch: Record<PaneId, number>
  rainLevel: number
  seq: number
  /** something asked the command line to take focus (with optional text) */
  cmdFocus: { n: number; text?: string }
  sessionFocus: number
  /** The request open in the shared decision dialog, exactly as it was when opened (Review R2/R3). */
  answering: Approval | null
  /** Surface O (O-B1 follow-up): the store session `answering` was shown under, stamped at the press (as Flux does). The dialog answers only in it. */
  answeringSession: string | null
  /** Opens (or, with null, closes) the decision dialog. `session`: the session the request was shown under; omitted, the store's session at the press. */
  answer(a: Approval | null, session?: string): void
  setFocus(p: PaneId): void
  setLayout(l: LayoutId): void
  openMind(id: string | null): void
  setMindSel(n: number): void
  setInboxSel(n: number): void
  setInboxTab(t: InboxTab): void
  print(lines: Seg[][], opts?: { open?: boolean }): void
  /** record in the console without touching the flash line */
  echo(segs: Seg[]): void
  /** Redact every motivation-derived segment (console and flash) whose motivation `keep` no longer allows. */
  redactMotivations(keep: (motivationId: string) => boolean): void
  /** record a copy of the shared Ask in the console: it lives only as long as the Ask's thread (its epoch) does */
  echoAsk(segs: Seg[]): void
  /** drop everything the console and the flash line hold (the scrollback of whoever was signed in) */
  forget(): void
  clear(): void
  setConsole(open: boolean): void
  /** home:requested (a surface's X): the plain terminal, with no console overlay, flash or session left open. */
  clearToHome(): void
  pushHistory(cmd: string): void
  doGlitch(p: PaneId): void
  setRain(v: number): void
  focusCmd(text?: string): void
  focusSession(): void
}

const HKEY = 'omegahive.construct.history'
const loadHistory = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(HKEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(-200) : []
  } catch {
    return []
  }
}

export const useC = create<CState>((set, get) => ({
  focus: 'session',
  layout: 'operator',
  morphing: false,
  mind: null,
  mindSel: 0,
  inboxSel: 0,
  inboxTab: 'approvals',
  console: [],
  consoleOpen: false,
  flash: null,
  history: loadHistory(),
  glitch: { stream: 0, minds: 0, session: 0, inbox: 0 },
  rainLevel: 1,
  seq: 0,
  cmdFocus: { n: 0 },
  sessionFocus: 0,
  answering: null,
  answeringSession: null,
  answer: (answering, session) => set({ answering, answeringSession: answering ? (session ?? useHive.getState().session) : null }),
  setFocus: (focus) => set({ focus }),
  setLayout: (layout) => {
    if (layout === get().layout) return
    // turn framer's layout measuring on, let it snapshot, then change the tiling and turn it off after the morph
    set({ morphing: true })
    requestAnimationFrame(() => {
      set({ layout })
      setTimeout(() => set({ morphing: false }), 700)
    })
  },
  openMind: (mind) => set({ mind }),
  setMindSel: (mindSel) => set({ mindSel }),
  setInboxSel: (inboxSel) => set({ inboxSel }),
  setInboxTab: (inboxTab) => set({ inboxTab, inboxSel: 0 }),
  print: (lines, opts = {}) => {
    let seq = get().seq
    const add = lines.map((segs) => ({ id: ++seq, segs }))
    const console = [...get().console, ...add].slice(-600)
    set({
      console,
      seq,
      consoleOpen: opts.open ? true : get().consoleOpen,
      flash: opts.open || !lines.length ? null : { id: seq, lines: lines.slice(-3) },
    })
  },
  echo: (segs) => {
    const seq = get().seq + 1
    set({ console: [...get().console, { id: seq, segs }].slice(-600), seq })
  },
  redactMotivations: (keep) => {
    const { console, flash } = get()
    const nextConsole = redactLines(console, keep)
    const nextFlash = flash && redactSegLines(flash.lines, keep)
    if (nextConsole === console && (!flash || nextFlash === flash.lines)) return
    set({ console: nextConsole, flash: flash && nextFlash !== flash.lines ? { ...flash, lines: nextFlash! } : flash })
  },
  echoAsk: (segs) => {
    const seq = get().seq + 1
    set({ console: [...get().console, { id: seq, segs, ask: useAskStore.getState().epoch }].slice(-600), seq })
  },
  clear: () => set({ console: [], flash: null }),
  forget: () => set({ console: [], flash: null, consoleOpen: false }),
  setConsole: (consoleOpen) => set({ consoleOpen }),
  clearToHome: () => set({ consoleOpen: false, flash: null, mind: null }),
  pushHistory: (cmd) => {
    const h = get().history.filter((x) => x !== cmd)
    h.push(cmd)
    const history = h.slice(-200)
    set({ history })
    try {
      localStorage.setItem(HKEY, JSON.stringify(history))
    } catch {
      /* private mode */
    }
  },
  doGlitch: (p) => set({ glitch: { ...get().glitch, [p]: get().glitch[p] + 1 } }),
  setRain: (rainLevel) => set({ rainLevel }),
  focusCmd: (text) => set({ cmdFocus: { n: get().cmdFocus.n + 1, text } }),
  focusSession: () => set({ focus: 'session', sessionFocus: get().sessionFocus + 1 }),
}))

// ------------------------------------------------------------------ revoked motivations leave the console (stand-in P1-1 on 57e64ca)

/** What a redacted motivation's words become: nothing of the title or why remains. */
export const REDACTED = '(a motivation you can no longer see)'

/** Each run of segments from a motivation no longer readable becomes one REDACTED segment. */
function redactSegs(segs: Seg[], keep: (id: string) => boolean): Seg[] {
  if (!segs.some((g) => g.mot && !keep(g.mot))) return segs
  const out: Seg[] = []
  for (const g of segs) {
    if (!(g.mot && !keep(g.mot))) out.push(g)
    else if (out.at(-1)?.t !== REDACTED) out.push({ t: REDACTED, c: 'dim' })
  }
  return out
}
function redactSegLines(lines: Seg[][], keep: (id: string) => boolean): Seg[][] {
  let changed = false
  const out = lines.map((segs) => {
    const next = redactSegs(segs, keep)
    if (next !== segs) changed = true
    return next
  })
  return changed ? out : lines
}
function redactLines(lines: Line[], keep: (id: string) => boolean): Line[] {
  let changed = false
  const out = lines.map((l) => {
    const segs = redactSegs(l.segs, keep)
    if (segs === l.segs) return l
    changed = true
    return { ...l, segs }
  })
  return changed ? out : lines
}

/**
 * Construct keeps its own console, apart from hive data, so the store's purge of a motivation this person can no longer
 * read (a complete re-read, a 404, a new session) is followed here at once: every segment printed from it is redacted.
 */
useHive.subscribe((s, prev) => {
  if (s.motivations !== prev.motivations) useC.getState().redactMotivations((id) => id in s.motivations)
})

/**
 * Custody of the console (stand-in ASK_EVERYWHERE_R1 #2; Surface K1). Registered at module load, so it holds whether
 * or not the construct is mounted:
 * - an identity change (another client, a re-init, or a re-login on the same client: lib/identityEpoch) drops
 *   everything printed for the earlier person, synchronously, inside the change itself;
 * - a reset of the Ask's thread (New thread, Delete thread, and every identity change) drops the console's copies of
 *   it (lines tagged with the Ask epoch they were copied under), so a deleted thread leaves no scrollback behind.
 */
onIdentityChange(() => useC.getState().forget())
let askEpoch = useAskStore.getState().epoch
useAskStore.subscribe((s) => {
  if (s.epoch === askEpoch) return
  askEpoch = s.epoch
  const lines = useC.getState().console
  if (lines.some((l) => l.ask !== undefined && l.ask !== askEpoch)) useC.setState({ console: lines.filter((l) => l.ask === undefined || l.ask === askEpoch) })
})
