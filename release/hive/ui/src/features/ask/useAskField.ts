/**
 * The headless Ask (UNIVERSAL_ASK_DESIGN §1.2): one hook every skin renders from, so behaviour, tests and safety are
 * shared and only the look differs. It holds the field, the fast path's candidates, the §2.4 policy on Enter, the
 * arming gate for person-typed hive actions (lib/decisionGate), history recall, and the hand-off to the orchestrator.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { accepts, ARM_MS } from '../../lib/decisionGate'
import { decide, resolve, type Candidate, type Decision, type IntentAct } from '../../lib/intent'
import { foldWords } from '../../lib/intent/features'
import { useRoute } from '../../lib/router'
import { askOrigin, throughMindOf, useAskStore } from '../../store/ask'
import { useHive } from '../../store/store'
import { currentEpoch, onIdentityChange } from '../../lib/identityEpoch'
import { currentView, isPrivateHash } from './view'
import { askContext, expectedAnswerer, routeSwarm, routingContext, SCOPED, useAskWorld, whereOf } from './context'
import { planAsk, planRecipient } from './answerer'
import { shown } from '../../lib/displayName'
import { askMind } from './mind'
import { performAct } from './run'
import { controlFromWords, expectConducted, useGuide } from '../guided/store'
import { bindEpoch } from '../../lib/identityEpoch'
import { guidedIntent } from '../guided/match'
import { ensureArchived } from '../swarm/deleteRequest'
import { showreelWords } from '../showreel/hook'
import { firstLightWords } from '../firstlight/door'
import { usePopDismiss } from './popDismiss'
import { askRows, asksMind, enterAction, highlighted, NOTHING_SEEN, type AskSeen } from './enter'
import { guardComposing } from './keys'
import { paysLine } from './words'

const DELETE_WORDS = /^\s*(?:please\s+|can you\s+|could you\s+)?(?:delete|remove)\s+\S/i

/** What opens under the field after Enter, when the policy does not simply run something. */
export type Panel =
  | { kind: 'choose'; options: Candidate[] }
  | { kind: 'clarify'; c: Candidate }
  | { kind: 'limit'; c: Candidate; safe?: Candidate }
  | { kind: 'none'; near: Candidate[] }
  | { kind: 'say'; text: string; tone?: 'warn' }
  | null

export interface AskFieldOpts {
  experience: string
  /** an experience's own handler for acts it does in place (Still's sheets); returns true when it handled the act */
  onAct?: import('./handlers').ActHandler
  /**
   * A skin's own explicit "ask a mind" words (Construct's `ask <words>`): the words to send when the field's text is
   * that command, else null. Such words never run straight from the skin (r2.2, stand-in P1): they show as the one paid
   * row ("Ask Vega: …", or the steer while a turn is answering), highlighted, and go through the same guarded Enter as
   * anything typed (what is seen, IME, busy, the arming window, the refusal notice). Pass a stable function.
   */
  forcedAsk?: (value: string) => string | null
  /**
   * Called once the field actually acts (never on a refused or ignored Enter), before the act runs: Construct echoes the
   * request into its console and cancels a pending yes/no only then (Kimi r2.2 #1). `steering`: a turn is answering.
   */
  onDispatch?: (d: { you: string; steering: boolean }) => void
}

/** recall (ArrowUp) of what was typed: one person's words only; a different session or person starts it empty */
const history: string[] = []
let historyOf = ''
const historyFor = () => {
  const o = askOrigin()
  const k = `${o.session}|${o.principal ?? ''}`
  if (k !== historyOf) {
    history.length = 0
    historyOf = k
  }
  return history
}
/**
 * Stand-in ASK_EVERYWHERE_R1 r2b: an identity change (lib/identityEpoch: another client, a re-init, a re-login on the
 * same client) takes the earlier person's words with it, synchronously, inside the change itself: the recall list here
 * (registered once, at module load, so it holds while no field is mounted) and every mounted field's typed words, its
 * recall position and what opened under it.
 */
interface MountedField {
  experience: string
  clear: () => void
  address: (id: string, displayedOriginCurrent: () => boolean) => boolean
  /** drop a prepared address, keep the words, and say so (the displayed place changed) */
  release: () => void
  /** the field holds unsent words (a reload would lose them: lib/chunkReload.ts) */
  hasWords: () => boolean
  /** put editable words in the field (a starter): never sends (j0-fixes r1) */
  fill: (words: string) => void
}
/**
 * Stand-in OMEGATOWN_PROFESSIONAL R1 P1: a prepared address whose place changed is never swallowed silently. The words
 * stay, the address is dropped, and this one line says what the next Enter does: it sends them to the Ask as ordinary
 * words (a mind named in them is still recognised, exactly as for anything typed). An identity change is different: the
 * field is cleared with the earlier person's words, and a retained handler stays silent.
 */
export const PLACE_CHANGED = 'That place changed. Send to the Ask instead?'
/** An experience whose displayed view changed releases any address prepared in its field (words kept, line shown). */
export function releaseAskAddress(experience: string): void {
  for (const field of [...fields]) if (field.experience === experience) field.release()
}
/**
 * Kimi r2 #3: an Enter that would act but is refused is said, never swallowed. One short notice in the shared notices
 * (they show in every experience, over notices and pickers alike); nothing is sent.
 */
export const REFUSED = {
  hidden: 'No choice is showing under the field. Close what is open, then pick a line.',
  empty: 'Type a little more, or pick a line.',
  busy: 'The last one is still running.',
  changed: 'The line under the field just changed. Read it, then press Enter again.',
  panel: 'Choose one of the lines shown, or press Esc.',
} as const
function refuseEnter(body: string): void {
  useHive.getState().toast({ tone: 'info', icon: 'info', title: 'Nothing was sent', body, group: 'ask-enter', ttl: 5000 })
}
const fields = new Set<MountedField>()
/**
 * A skin declares what it draws under ITS field (enter.ts AskSeen). The declaration is this field instance's own (each
 * mounted useAskField keeps its own; Still's page field and its floating line never share one), it follows every
 * change, and it is withdrawn when the skin hides or unmounts, so no field can act on a stale declaration (Kimi r2.1 #1).
 */
export function useSeen(declareSeen: (s: AskSeen) => void, rows: boolean, panel: boolean): void {
  useLayoutEffect(() => {
    declareSeen({ rows, panel })
    return () => declareSeen(NOTHING_SEEN)
  }, [declareSeen, rows, panel])
}
/**
 * ask-send-r1 (live eb006a94: a click on Ask said "No choice is showing"): a floating Ask is IN USE while focus is
 * anywhere within its capsule (the field, the Ask button, the mic, the rows), not only while the field itself has it.
 * Pressing or tabbing to the Ask button therefore keeps the rows the person is looking at drawn and seen, so that press
 * acts on exactly that row. Focus that truly leaves the capsule (elsewhere on the page, the window, Esc's blur) still
 * hides the rows and withdraws the declaration, and an Enter after that still refuses (REFUSED.hidden).
 * Spread `bind` on the capsule's outermost element; React's focus events bubble from every control inside it.
 */
export function useFocusWithin() {
  const [focused, setFocused] = useState(false)
  const onFocus = useCallback(() => setFocused(true), [])
  const onBlur = useCallback((e?: { currentTarget?: unknown; relatedTarget?: unknown }) => {
    const root = e?.currentTarget as { contains?: (n: unknown) => boolean } | null | undefined
    const to = e?.relatedTarget
    // focus moving to another control of the same capsule never leaves it
    if (to && root && typeof root.contains === 'function' && root.contains(to)) return
    setFocused(false)
  }, [])
  return { focused, bind: { onFocus, onBlur } }
}
/**
 * A press on a capsule control (the Ask button, as the rows already do) keeps the caret in the field: no browser
 * moves focus off it (Safari and touch never focus a pressed button, so the field would just lose focus).
 */
export const keepFieldFocus = (e: { preventDefault(): void }): void => e.preventDefault()
/** Some mounted Ask field holds unsent words. */
export const askFieldHasWords = (): boolean => [...fields].some((field) => field.hasWords())
/**
 * j0-fixes r1 (J0 live: a Studio starter SENT a paid request at once): a starter only FILLS the Ask with editable words.
 * Nothing is sent here; the person's own Enter or Send then goes through the guarded Ask (the paid row, the arming
 * window: filled words count as not typed, so a paid row they bring waits it out). Words the person already typed are
 * never overwritten unless `replace`: 'kept' says they are still there, so the caller may ask. 'none': no Ask field.
 */
export function fillAsk(words: string, opts: { replace?: boolean; experience?: string } = {}): 'filled' | 'kept' | 'none' {
  const list = [...fields].filter((f) => !opts.experience || f.experience === opts.experience)
  const field = list[list.length - 1]
  if (!field) return 'none'
  const text = words.trim().slice(0, 4000)
  if (!text) return 'none'
  if (field.hasWords() && !opts.replace) return 'kept'
  field.fill(text)
  return 'filled'
}
/**
 * A person prepares the mounted native Ask field, by exact visible mind ID. Nothing is sent here.
 * context.mind still means its swarm's orchestrator answers about it (owner API contract), never execution authority.
 */
export function addressAskMind(id: string, experience: string, displayedOriginCurrent: () => boolean): boolean {
  const shown = currentView()
  if (!displayedOriginCurrent() || !shown || shown.scope !== experience || !shown.view.refs?.some((ref) => ref.kind === 'mind' && ref.ref === id) || typeof window === 'undefined' || isPrivateHash(window.location.hash || '')) return false
  const agent = useHive.getState().agents[id]
  if (!agent || (agent.kind !== 'omega' && agent.kind !== 'iter')) return false
  const entry = [...fields].reverse().find((field) => field.experience === experience)
  return entry?.address(id, displayedOriginCurrent) ?? false
}
onIdentityChange(() => {
  history.length = 0
  historyOf = ''
  for (const field of [...fields]) field.clear()
})

export function useAskField({ experience, onAct, forcedAsk, onDispatch }: AskFieldOpts) {
  const route = useRoute()
  const world = useAskWorld()
  const [value, setValue] = useState('')
  const [addressed, setAddressed] = useState<{ id: string; prefix: string; epoch: number; current: () => boolean } | null>(null)
  const addressedNow = useRef<typeof addressed>(null)
  const [sel, setSel] = useState(0)
  const [moved, setMoved] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  // what opened under the field closes on Esc anywhere and on words typed outside the Ask (a mind's composer): popDismiss
  usePopDismiss(!!panel, () => setPanel(null))
  const [busy, setBusy] = useState(false)
  const armedAt = useRef(0)
  /** when the row Enter would run last changed under unchanged words (a refresh, not typing): Kimi r2 #4 */
  const refreshedAt = useRef(-Infinity)
  const lastTarget = useRef<{ key?: string; words: string }>({ words: '' })
  /** the last change of the words was the person's own typing (false: spoken words, interim ones included) */
  const typedEdit = useRef(true)
  /** what the skin drew under the field (enter.ts AskSeen); nothing declared, nothing seen */
  const seen = useRef<AskSeen>(NOTHING_SEEN)
  const declareSeen = useCallback((s: AskSeen) => {
    seen.current = s
  }, [])
  const histAt = useRef(-1)
  /** how the words in the field were made: spoken words stay 'voice' (audit only) until the field is sent or emptied */
  const via = useRef<'typed' | 'voice'>('typed')
  /** the field's words now (voice reads and writes them between renders) */
  const now = useRef('')
  const settings = useAskStore((s) => s.settings)
  const personal = useAskStore((s) => s.personal)
  const thread = useAskStore((s) => s.thread)
  const open = useAskStore((s) => s.open)
  const carry = useAskStore((s) => s.carry)
  const threadOpen = useAskStore((s) => s.threadOpen)
  const programs = useHive((s) => s.programs)
  const turns = useAskStore((s) => s.turns)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const canAsk = useHive((s) => !!s.client?.ask)

  const scope = useMemo(() => ({ experience, swarm: routeSwarm(route) }), [experience, route])
  const where = whereOf(route, experience)
  const cands = useMemo(() => resolve(value, scope, world, SCOPED), [value, scope, world])
  // "delete the Forge swarm": read the archived swarms once, so an archived one (cleanup pending) can be named too
  const deleteWords = DELETE_WORDS.test(value)
  useEffect(() => {
    if (deleteWords) void ensureArchived(useHive.getState().client)
  }, [deleteWords])
  // a mind named in the words: the orchestrator of its swarm answers, about it (the owner's ruling)
  const to = useMemo(() => {
    if (addressed && value.startsWith(addressed.prefix) && addressed.epoch === currentEpoch()) return addressed.id
    if (!value.trim()) return undefined
    const t = ` ${foldWords(value)} `
    const hits = world.minds.filter((m) => t.includes(` ${foldWords(m.name)} `) || t.includes(` ${foldWords(m.name)}'s `))
    return hits.length === 1 ? hits[0].id : undefined
  }, [value, world, addressed])
  const answerer = useMemo(
    () => expectedAnswerer(swarms, agents, { to, swarm: scope.swarm, defaultSwarm: settings?.swarm_id ?? null }),
    [swarms, agents, to, scope.swarm, settings],
  )
  // j0-fixes r1: who a new request reaches is ONE decision (answerer.ts planAsk), the very one the send makes (store
  // send): the chip, the paid row and the outgoing context can no longer disagree. Only a turn in flight keeps its
  // own mind (a steer goes to it); a closed thread or a since-chosen default never leaves an old name on the row.
  const plan = useMemo(() => {
    const ctx = routingContext(route, experience, to)
    const appId = 'private' in ctx ? undefined : ctx.program
    const pageApp = appId ? programs?.find((p) => p.id === appId) ?? { id: appId } : null
    return planAsk(ctx, { settings, personal, swarmOf: (id) => swarms[id], through: { minds: Object.values(agents), app: pageApp, prefer: throughMindOf }, thread, carry, threadOpen })
  }, [route, experience, to, programs, settings, personal, swarms, agents, thread, carry, threadOpen])
  // nothing decides who answers yet: the bar says so before the first send (answerer.ts)
  const chip = plan.chip
  // ONE recipient decision, by identity and name (planRecipient): everything below reads it
  const recipient = useMemo(() => planRecipient(plan, { agents, swarms, personal, settings }), [plan, agents, swarms, personal, settings])
  const planned = recipient.name ? shown(recipient.name) : null
  // while a turn is open the words STEER that turn (mind.ts askMind), so the open thread's mind is the recipient even
  // when another mind's name is typed (j0-fixes r1.4, stand-in P1): row, chip and send name the same mind
  const answererName = open && thread ? thread.mind.name : to ? answerer?.name ?? planned : planned
  // the same recipient, by identity: a steer goes to the open turn's mind; "is it you" is THIS id against the person's
  // own mind, never a name (j0-fixes r1.6: two minds can share a name)
  const answererId: string | null = open && thread ? thread.mind.id : to ? answerer?.id ?? recipient.id : recipient.id
  const answeringYou = !!answererId && !!personal?.id && answererId === personal.id
  // a skin's explicit "ask a mind" command: its words are the request, and the policy's answer is the mind (r2.2)
  const forced = forcedAsk ? forcedAsk(value) : null
  const decision: Decision = useMemo(() => (forced !== null ? { kind: 'mind' } : decide(cands, { orchestrator: canAsk })), [forced, cands, canAsk])
  // while it answers, the words go to it first (a steer): the field never locks (the owner, 2026-10-05). When the policy will
  // ask a mind, its row is first too, so the highlighted row is what Enter does (enter.ts, UI review ST1)
  const newThreadUsd = settings?.thread_budget_usd
  const shownList = useMemo(() => {
    const rows = forced !== null ? askRows([], forced, answererName, decision, !!open) : askRows(cands, value, answererName, decision, !!open)
    // j0-fixes r1: the paid row says who pays and what limit holds (never an invented estimate)
    const pays = paysLine({ steering: !!open, thread, answererId, newThreadUsd })
    return rows.map((c) => (c.key === 'mind' || c.key === 'steer' ? { ...c, pays } : c))
  }, [forced, cands, value, answererName, answererId, open, decision, thread, newThreadUsd])
  const active = highlighted(shownList, sel)

  useEffect(() => {
    const clear = () => {
      now.current = ''
      addressedNow.current = null; setAddressed(null)
      via.current = 'typed'
      histAt.current = -1
      setValue('')
      setSel(0)
      setMoved(false)
      setPanel(null)
    }
    const fill = (words: string) => {
      now.current = words
      addressedNow.current = null; setAddressed(null)
      // not the person's own typing: a paid row these words bring is read before Enter acts (the arming window)
      typedEdit.current = false
      via.current = 'typed'
      histAt.current = -1
      setValue(words); setSel(0); setMoved(false); setPanel(null)
    }
    const entry: MountedField = { experience, clear, fill, hasWords: () => now.current.trim() !== '', address: (id, displayedOriginCurrent) => {
      const agent = useHive.getState().agents[id]
      if (!agent || (agent.kind !== 'omega' && agent.kind !== 'iter')) return false
      const prefix = `About ${agent.name}: `
      const previous = addressedNow.current
      const old = previous && now.current.startsWith(previous.prefix) ? now.current.slice(previous.prefix.length) : now.current
      const next = prefix + old
      now.current = next
      via.current = 'typed'
      const address = { id, prefix, epoch: currentEpoch(), current: displayedOriginCurrent }
      addressedNow.current = address; setAddressed(address)
      setValue(next); setSel(0); setMoved(false); setPanel(null)
      return true
    }, release: () => {
      const previous = addressedNow.current
      if (!previous) return
      addressedNow.current = null; setAddressed(null)
      if (now.current.trim()) setPanel({ kind: 'say', text: PLACE_CHANGED })
    } }
    fields.add(entry)
    return () => { fields.delete(entry) }
  }, [experience])

  // re-arm whenever the suggestion Enter would act on changes (a press aimed at an earlier one never lands)
  const target = moved ? active?.key : decision.kind === 'own' ? decision.c.key : active?.key
  // The words are tracked TOGETHER with the target, on every change of either (r2.2, stand-in P1): typing that keeps the
  // same row ("kelp" → "kelps") still moves the words on, so a later refresh under unchanged words is always seen.
  useEffect(() => {
    const prev = lastTarget.current
    if (prev.key !== target) {
      armedAt.current = performance.now()
      // the row Enter runs changed, and not by the person's own typing: the words stood still (the hive or the turn
      // refreshed under the person's finger), or spoken words brought the row in. An Enter that would ask a mind waits
      // out the arming window, as a person-typed hive action does. The comparison is of this render's own snapshot
      // (`target` and `value` together), never of words written between renders (Kimi r2.1 #5).
      if (prev.words === value || !typedEdit.current) refreshedAt.current = performance.now()
    }
    lastTarget.current = { key: target, words: value }
  }, [target, value])

  const change = useCallback((v: string) => {
    typedEdit.current = true
    if (!v) via.current = 'typed'
    if (addressed && !v.startsWith(addressed.prefix)) { addressedNow.current = null; setAddressed(null) }
    now.current = v
    setValue(v)
    setSel(0)
    setMoved(false)
    setPanel(null)
    histAt.current = -1
  }, [addressed])

  const done = useCallback((you: string) => {
    const h = historyFor()
    if (you) h.unshift(you)
    h.length = Math.min(h.length, 30)
    via.current = 'typed'
    now.current = ''
    addressedNow.current = null; setAddressed(null)
    setValue('')
    setSel(0)
    setMoved(false)
  }, [])

  /** A prepared exact address is checked again at the ordinary person-submit and native run seams. */
  const addressCurrent = useCallback((you: string) => {
    if (!addressed || (you !== addressed.prefix.trimEnd() && !you.startsWith(addressed.prefix))) return true
    // A retained earlier-person or earlier-view handler neither sends nor writes into a later field.
    if (addressed.epoch !== currentEpoch()) return false
    const shown = currentView()
    if (!shown || shown.scope !== experience || !shown.view.refs?.some((ref) => ref.kind === 'mind' && ref.ref === addressed.id) || !addressed.current() || isPrivateHash(window.location.hash || '')) {
      // the place changed under a prepared address: keep the words, drop the address, say so; nothing is sent now
      if (addressedNow.current === addressed) { addressedNow.current = null; setAddressed(null) }
      setPanel({ kind: 'say', text: PLACE_CHANGED })
      return false
    }
    const live = useHive.getState().agents[addressed.id]
    if (!live || (live.kind !== 'omega' && live.kind !== 'iter')) {
      setPanel({ kind: 'say', tone: 'warn', text: 'That mind is no longer available here. Choose it again. Your words have not been sent.' })
      return false
    }
    return true
  }, [addressed, experience])

  const run = useCallback(
    async (act: IntentAct, you: string) => {
      if (!addressCurrent(you)) return
      onDispatch?.({ you, steering: !!useAskStore.getState().open })
      if (act.do === 'mind') {
        const spoken = via.current
        done(you)
        // what opened under the field ("Did you mean…", "None of these: ask …") is answered: it closes
        setPanel(null)
        const ctx = askContext(route, experience, where, to)
        const about = to ? world.minds.find((m) => m.id === to)?.name : undefined
        await askMind(act.text, ctx, { about, where, via: spoken })
        return
      }
      // a ready guided demo goes to the orchestrator, whose conductor drives it step by step (tour.step); a hive whose
      // conductor does not drive tours yet ends the turn without a step, and the same demo then plays here
      const guideText = act.do === 'guide' ? act.text : null
      const g = guideText ? guidedIntent(guideText) : null
      if (g?.kind === 'script' && g.script.status === 'ready' && canAsk && useHive.getState().client?.askActResult && !useAskStore.getState().open) {
        const spoken = via.current
        const origin = askOrigin()
        const bind = bindEpoch()
        done(you)
        const sent = askMind(guideText!, askContext(route, experience, where, to), { where, via: spoken })
        const op = useAskStore.getState().open
        if (op) expectConducted(op, g, { you, where, origin })
        await sent
        // not even sent (no hive bound for the Ask): it plays here
        // (after the await: only for the same person, checked in the tick that starts it)
        if (!op && bind.current() && origin.ok()) await useGuide.getState().start(g, { you, where, origin, note: 'The orchestrator could not take it, so it plays here.' })
        return
      }
      setBusy(true)
      // Review B1: where this act started; after each await nothing runs or is kept unless it still holds
      const origin = askOrigin()
      const stale = () => {
        // the session or person changed while it ran: the earlier person's words are not kept in the field or recall
        now.current = ''
        via.current = 'typed'
        setValue('')
        setSel(0)
        setMoved(false)
        setPanel(null)
      }
      try {
        const handled = await performAct(act, { you, where, experience, onAct }, origin)
        if (handled === 'stale') return stale()
        if (handled !== 'keep') done(you)
        setPanel(null)
      } finally {
        setBusy(false)
      }
    },
    [done, route, experience, where, to, onAct, world, canAsk, addressCurrent, onDispatch],
  )

  /** A candidate the person chose (or the policy picked). Person-typed hive actions wait out the arming window. */
  const take = useCallback(
    async (c: Candidate | undefined, ev: { repeat?: boolean; quiet?: boolean } = {}) => {
      if (!c) return
      // a press while the last act is still running is said, never swallowed (Kimi r2 #3); a send the person did not
      // press (voice send-on-pause) is refused quietly: the words stay in the field (Kimi r2.1 #3)
      if (busy) return ev.quiet ? undefined : refuseEnter(REFUSED.busy)
      if (!addressCurrent(value.trim())) return
      if (c.clarify) {
        setPanel({ kind: 'clarify', c })
        return
      }
      if (!c.act) {
        if (c.fill) change(c.fill)
        else if (c.limit) setPanel({ kind: 'limit', c })
        return
      }
      if (c.effect === 'own-action' && !accepts({ repeat: ev.repeat, at: performance.now() }, armedAt.current)) {
        if (!ev.repeat) setPanel({ kind: 'say', tone: 'warn', text: 'This just appeared. Read the line above, then press Enter again.' })
        return
      }
      await run(c.act, value.trim())
    },
    [busy, change, run, value, addressCurrent],
  )

  const submit = useCallback(
    /** `quiet`: not a press (voice send-on-pause): a refusal keeps the words and says nothing (Kimi r2.1 #3) */
    async (ev: { repeat?: boolean; quiet?: boolean } = {}) => {
      const refuse = (body: string) => (ev.quiet ? undefined : refuseEnter(body))
      const you = value.trim()
      if (!you || ev.repeat || !addressCurrent(you)) return
      // demo mode's showreel (features/showreel): "show me around" starts it; while it shows, its own script answers
      // "why?" and the like (0 model calls), and it pauses rather than being taken over
      if (!moved && showreelWords(you, { where })) return done(you)
      // First Light ("show me first light", "set me up"): the person's own journey (the invented newcomer on the simulator)
      if (!moved && firstLightWords(you)) return done(you)
      // while a guided demo plays: "next", "back", "pause", "stop" control it
      if (!moved && controlFromWords(you)) return done(you)
      // Enter does what clicking the visible highlighted row does: never a mind's answer under another row (ST1), never
      // from a row the person cannot see (r2.1), and mid-turn it steers only when the steer row is the highlighted one
      const e = enterAction(shownList, sel, moved, decision, { steering: !!open, seen: seen.current, placeChanged: panel?.kind === 'say' && panel.text === PLACE_CHANGED })
      if (e.kind === 'refuse') return refuse(REFUSED[e.why])
      // the paid row became the Enter row while the words stood still: read it first (Kimi r2 #4)
      if (asksMind(e) && !accepts({ repeat: ev.repeat, at: performance.now() }, refreshedAt.current)) return refuse(REFUSED.changed)
      if (e.kind === 'take') return take(e.c, ev)
      const d = e.d
      switch (d.kind) {
        case 'run':
        case 'open-decision':
        case 'own':
          return take(d.c, ev)
        case 'clarify':
          return setPanel({ kind: 'clarify', c: d.c })
        case 'which':
          setMoved(true)
          setSel(shownList.findIndex((c) => c.choice))
          return setPanel({ kind: 'say', text: 'Several things have that name. Pick one; nothing happens until you do.' })
        case 'choose':
          return setPanel({ kind: 'choose', options: d.options })
        case 'limit':
          return setPanel({ kind: 'limit', c: d.c, safe: d.safe })
        case 'mind':
          return run({ do: 'mind', text: you }, you)
        case 'none':
          return setPanel({ kind: 'none', near: d.near })
      }
    },
    [value, moved, take, decision, shownList, sel, run, done, addressCurrent, where, open, panel],
  )

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>, onEscape?: () => boolean) => {
      // a key that confirms an IME candidate belongs to the input method, never to the Ask (keys.ts)
      if (guardComposing(e)) return
      if (e.key === 'ArrowDown' && shownList.length) {
        e.preventDefault()
        setMoved(true)
        setSel((i) => (i + 1) % shownList.length)
      } else if (e.key === 'ArrowUp') {
        const h = historyFor()
        if (!value && h.length) {
          e.preventDefault()
          histAt.current = Math.min(h.length - 1, histAt.current + 1)
          now.current = h[histAt.current]
          // recalled words are not typed toward what is now under them: the row they bring is a refresh (Kimi r2.2 #2)
          typedEdit.current = false
          via.current = 'typed'
          setValue(h[histAt.current])
        } else if (shownList.length) {
          e.preventDefault()
          setMoved(true)
          setSel((i) => (i - 1 + shownList.length) % shownList.length)
        }
      } else if (e.key === 'Tab' && !e.shiftKey && active?.fill && value && active.fill.toLowerCase().startsWith(value.toLowerCase()) && active.fill !== value) {
        e.preventDefault()
        change(active.fill)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        void submit({ repeat: e.repeat })
      } else if (e.key === 'Escape') {
        // Esc steps back: what opened under the field, then the words, then the skin (thread, blur)
        if (panel) {
          e.preventDefault()
          setPanel(null)
        } else if (value) {
          e.preventDefault()
          change('')
        } else if (onEscape?.()) e.preventDefault()
      }
    },
    [shownList, value, active, change, submit, panel],
  )

  /** Spoken words into the field (interim words included): editable like typing; marked as voice for the audit. */
  const voiceText = useCallback(
    (v: string) => {
      change(v)
      // spoken words, interim ones too: a row they bring in is not one the person typed toward (Kimi r2.1 #5)
      typedEdit.current = false
      if (v) via.current = 'voice'
    },
    [change],
  )

  const turn = open ? turns[open] : undefined
  return {
    value,
    change,
    voiceText,
    valueNow: () => now.current,
    sel,
    setSel: (i: number) => {
      setSel(i)
      setMoved(true)
    },
    list: value.trim() ? shownList : [],
    active,
    take,
    submit,
    onKeyDown,
    panel,
    setPanel,
    busy,
    where,
    route,
    answerer: answererName,
    answererId,
    answeringYou,
    to,
    chip,
    thread,
    // a request not yet known to have arrived is not being answered (Review B1, 45392df): the thread says it is checking
    answering: !!open && turn?.state !== 'checking',
    step: turn?.step ?? (turn?.state === 'sending' ? 'sending' : undefined),
    run,
    armMs: ARM_MS,
    declareSeen,
  }
}
