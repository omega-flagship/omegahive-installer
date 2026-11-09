import { useVisibleAuthority, visibleOwner } from '../../lib/useVisibleAuthority'
import { usePhase } from '../../shell/phase'
import { usePhaseAnchor } from '../phaseAnchor'
import { currentEpoch, onIdentityChange } from '../../lib/identityEpoch'
import { AnimatePresence, m } from 'framer-motion'
import { Activity, useSyncExternalStore, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { hsl, NOTICE_ROW, openGallery, shown, useHive, useHomeRequested, useNoticeRow, useResting, useRoomyLayout, useReducedMotion, useRoute } from '../sdk'
import { Boot } from './Boot'
import { CommandLine, Console } from './CommandLine'
import { dropAwaiting, openSession, run } from './commands'
import { goalList, orderedMinds, pendingList, slug } from './model'
import { InboxPane, MindsPane, PANE_FEATURE, SessionPane, StreamPane } from './Panes'
import { alarm, bus, pulse, Rain, speak } from './rain'
import { INBOX_TABS, LAYOUTS, PANE_TITLE, PANES, useC, type PaneId } from './state'
import './construct.css'
import { ApprovalDecision } from '../ApprovalDecision'
import { modalLayers } from '../../ui/useModalContainment'
import { watchAskEcho } from './askEcho'

const approvalOwner = visibleOwner(useC, s => s.answering, request => request !== null)
export const useConstructApprovalAuthority = () => useVisibleAuthority('hive-pro', true, 'construct-approval', approvalOwner)

/**
 * CONSTRUCT: the hive as an operator's terminal. Digital rain behind tiled panes (stream, minds, session, inbox),
 * a command language at the bottom, CRT optics on top. Everything is keyboard driven; on a phone it becomes one
 * swipeable pane with command chips.
 */
export default function Construct() {
  const epoch = useSyncExternalStore(onIdentityChange, currentEpoch, currentEpoch)
  return <ConstructBody key={epoch} />
}

function ConstructBody() {
  const anchor = usePhaseAnchor()
  const home = usePhase(s => s.phased && s.phase !== 'pro')
  const reduced = useReducedMotion()
  const desktop = useRoomyLayout()
  const phone = !desktop
  const [booting, setBooting] = useState(!reduced)
  // a surface's X lands on the plain terminal (home:requested)
  useHomeRequested(() => useC.getState().clearToHome())
  const endBoot = useCallback(() => {
    setBooting(false)
    pulse(1)
  }, [])

  const answering = useC((s) => s.answering)
  const answeringSession = useC((s) => s.answeringSession)
  const approvalCurrent = useConstructApprovalAuthority()

  // the reveal waits for the boot overlay to fade
  const bootDelay = reduced ? 0 : 0.18

  return (
    <div className={`cx-root${phone ? ' is-phone' : ''}${reduced ? ' is-reduced' : ''}`}>
      <div className="cx-shell">
        <Activity mode={home ? 'hidden' : 'visible'}>
          <ProWorkspace phone={phone} booting={booting} bootDelay={bootDelay} />
        </Activity>
        <div ref={anchor} className="cx-phase-anchor" hidden={!home} />
        <CommandLine phone={phone} />
      </div>
      {!home && <div className="cx-crt" aria-hidden />}
      <AnimatePresence>{!home && booting && <Boot key="boot" onDone={endBoot} />}</AnimatePresence>
      <AnimatePresence>{!home && answering && <ApprovalDecision current={approvalCurrent} key={answering.id} seen={answering} session={answeringSession ?? undefined} onClose={() => useC.getState().answer(null)} restoreFocus={afterAnswer} />}</AnimatePresence>
    </div>
  )
}

function ProWorkspace({ phone, booting, bootDelay }: { phone: boolean; booting: boolean; bootDelay: number }) {
  useHiveWiring()
  useKeys(phone)
  useSessionReset()
  useAskEcho()
  return <><RainLayer /><StatusBar phone={phone} />{!booting && (phone ? <PhoneDeck boot={bootDelay} /> : <Grid boot={bootDelay} />)}{!booting && phone && <Chips />}</>
}

/**
 * Where focus goes when the decision dialog closes: back to what opened it while that request still waits; otherwise
 * to the inbox pane itself (never onto another request's controls, Review R3).
 */
function afterAnswer(opener: HTMLElement | null): HTMLElement | null {
  const row = opener?.closest<HTMLElement>('[data-cx-ap]')
  const settled = row ? useHive.getState().approvals[row.dataset.cxAp ?? '']?.status !== 'pending' : false
  if (opener && opener.isConnected && opener !== document.body && !settled) return opener
  const pane = document.querySelector<HTMLElement>('[data-pane="inbox"]')
  if (pane && !pane.hasAttribute('tabindex')) pane.setAttribute('tabindex', '-1')
  return pane ?? document.querySelector<HTMLElement>('.cx-cmd input')
}

// ------------------------------------------------------------------ rain

function RainLayer() {
  const host = useRef<HTMLDivElement>(null)
  const far = useRef<HTMLCanvasElement>(null)
  const near = useRef<HTMLCanvasElement>(null)
  const reduced = useReducedMotion()
  const level = useC((s) => s.rainLevel)
  // the rain is decoration: it stops while it cannot be seen (rain off, a classic page or app over the construct)
  const route = useRoute()
  // the rain stops while the page rests (the rest draws its own, lower rain)
  const resting = useResting((s) => s.resting)
  const shown = level > 0 && route.name === 'hive' && !resting
  const rainRef = useRef<Rain | null>(null)
  const shownRef = useRef(shown)
  useEffect(() => {
    if (!far.current || !near.current || !host.current) return
    // no 2D canvas (a locked-down or headless browser): the construct works without its rain
    if (!far.current.getContext('2d') || !near.current.getContext('2d')) return
    const rain = new Rain(far.current, near.current, host.current, reduced)
    rainRef.current = rain
    const fit = () => rain.resize(window.innerWidth, window.innerHeight)
    fit()
    let t = 0
    const onResize = () => {
      clearTimeout(t)
      t = window.setTimeout(fit, 120)
    }
    const vis = () => (document.hidden || !shownRef.current ? rain.stop() : rain.start())
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', vis)
    if (!document.hidden && shownRef.current) rain.start()
    return () => {
      rain.stop()
      rainRef.current = null
      clearTimeout(t)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', vis)
    }
  }, [reduced])
  useEffect(() => {
    shownRef.current = shown
    const rain = rainRef.current
    if (!rain) return
    if (shown && !document.hidden) rain.start()
    else rain.stop()
  }, [shown])
  return (
    <div ref={host} className="cx-rainbox" aria-hidden style={{ opacity: level } as CSSProperties}>
      <canvas ref={far} className="cx-rain cx-rain-far" />
      <canvas ref={near} className="cx-rain cx-rain-near" />
    </div>
  )
}

// ------------------------------------------------------------------ the Ask, echoed

/** The orchestrator's presence, echoed in the console while the construct is shown (askEcho.ts). */
function useAskEcho() {
  useEffect(() => watchAskEcho(), [])
}

// ------------------------------------------------------------------ hive wiring

/**
 * Surface K1 for the construct's own memory: when the session changes (another client: another hive or person), its
 * open session, any waiting preview and the decision dialog are dropped. The console itself is cleared on EVERY
 * identity change, a re-login on the same client included, mounted or not (state.ts, lib/identityEpoch).
 */
function useSessionReset() {
  const client = useHive((s) => s.client)
  const seen = useRef(client)
  useEffect(() => {
    if (seen.current === client) return
    seen.current = client
    dropAwaiting()
    useC.getState().clear()
    useC.getState().openMind(null)
    useC.getState().answer(null)
  }, [client])
}

function useHiveWiring() {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const approvals = useHive((s) => s.approvals)
  const activity = useHive((s) => s.activity)
  const swarmKey = Object.keys(swarms).sort().join(',')

  // load what the panes show
  useEffect(() => {
    const h = useHive.getState()
    void h.loadApprovals().catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!swarmKey) return
    const h = useHive.getState()
    for (const id of swarmKey.split(',')) void h.loadGoals(id).catch(() => undefined)
  }, [swarmKey])

  // names the rain may spell
  useEffect(() => {
    bus.pool = Object.values(agents).map((a) => shown(a.name))
  }, [agents])

  // open the liveliest awake mind on first entry, so the session pane is never a dead end
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || useC.getState().mind) return
    const list = orderedMinds(agents, swarms)
    if (!list.length) return
    opened.current = true
    const pick = [...list].filter((a) => a.status === 'awake').sort((a, b) => (b.last_active_at ?? '').localeCompare(a.last_active_at ?? ''))[0]
    if (pick) {
      useC.getState().openMind(pick.id)
      useC.getState().setMindSel(list.indexOf(pick))
      void useHive.getState().loadMessages(pick.id).catch(() => undefined)
    }
  }, [agents, swarms])

  // alerts: a new request glitches the inbox, tints the rain amber and spells the asking mind
  const pend = useMemo(() => pendingList(approvals), [approvals])
  const lastPend = useRef<Set<string> | null>(null)
  useEffect(() => {
    const ids = new Set(pend.map((a) => a.id))
    const prev = lastPend.current
    lastPend.current = ids
    if (!prev) return
    const fresh = pend.filter((a) => !prev.has(a.id))
    if (!fresh.length) return
    alarm()
    useC.getState().doGlitch('inbox')
    const a = useHive.getState().agents[fresh[0].agent_id]
    if (a) speak(shown(a.name))
    useC.getState().print([[{ t: '⚠ ', c: 'amber' }, { t: a ? shown(a.name) : 'a mind', hue: a?.hue, c: 'hi' }, { t: ` asks to run ${fresh[0].skill}`, c: 'amber' }, { t: '  · inbox to review it', c: 'dim' }]])
  }, [pend])

  // every hive event brightens the rain; errors glitch the stream
  const lastSeq = useRef<number | null>(null)
  useEffect(() => {
    const top = activity[0]
    if (!top) return
    if (lastSeq.current == null) {
      lastSeq.current = top.id
      return
    }
    if (top.id === lastSeq.current) return
    const fresh = activity.filter((a) => a.id > lastSeq.current!)
    lastSeq.current = top.id
    pulse(Math.min(0.6, 0.18 * fresh.length))
    for (const ev of fresh) {
      if (ev.kind === 'error') {
        alarm()
        useC.getState().doGlitch('stream')
      }
      if ((ev.kind === 'birth' || ev.kind === 'goal' || ev.kind === 'error') && ev.agent_id) {
        const a = useHive.getState().agents[ev.agent_id]
        if (a) speak(shown(a.name))
      }
    }
  }, [activity])
}

// ------------------------------------------------------------------ keys

function useKeys(phone: boolean) {
  const route = useRoute()
  const over = useRef(false)
  useEffect(() => {
    over.current = route.name !== 'hive'
  }, [route])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
      const c = useC.getState()
      const h = useHive.getState()
      // The native chooser owns its keyboard. Escape closes the Ask's top
      // layer before it can close the terminal console underneath.
      if (e.defaultPrevented || t?.closest('.ask-scoped-answerer') || (e.key === 'Escape' && document.documentElement?.dataset.askPop !== undefined)) return
      if (h.paletteOpen) return
      // classic pages over us own the keyboard
      if (over.current) return
      // so do a modal (a decision, Change UI, stop-all) and anything outside the construct (the Ω menu): a key pressed
      // there is never a construct command, let alone an answer
      if (modalLayers.size > 0) return
      if (t && t !== document.body && t.isConnected && !t.closest('.cx-root')) return
      const consume = () => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      // alt chords work everywhere, even while typing
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        const d = /^Digit([1-4])$/.exec(e.code)
        if (d) {
          consume()
          const p = PANES[Number(d[1]) - 1]
          c.setFocus(p)
          if (p === 'session') c.focusSession()
          else if (t && typing) t.blur()
          return
        }
        if (e.code === 'KeyL') {
          consume()
          void run('layout')
          return
        }
        if (e.code === 'BracketRight' || e.code === 'BracketLeft') {
          consume()
          const i = PANES.indexOf(c.focus)
          c.setFocus(PANES[(i + (e.code === 'BracketRight' ? 1 : PANES.length - 1)) % PANES.length])
          return
        }
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key
      // Enter and Space on a focused control (a button, a link, a tab) are that control's, never a pane command
      if ((k === 'Enter' || k === ' ') && t?.closest('button, a[href], [role="tab"], summary')) return
      if (k === 'Escape') {
        if (c.consoleOpen) {
          consume()
          c.setConsole(false)
        }
        return
      }
      if (k === '/' || k === ':') {
        consume()
        c.focusCmd()
        return
      }
      if (k === '?') {
        consume()
        void run('help')
        return
      }
      if (/^[1-4]$/.test(k)) {
        consume()
        c.setFocus(PANES[Number(k) - 1])
        return
      }
      if (k === '[' || k === ']') {
        consume()
        const i = PANES.indexOf(c.focus)
        c.setFocus(PANES[(i + (k === ']' ? 1 : PANES.length - 1)) % PANES.length])
        return
      }
      if (k === 'L') {
        consume()
        void run('layout')
        return
      }
      const down = k === 'ArrowDown' || k === 'j'
      const up = k === 'ArrowUp' || k === 'k'
      if (c.focus === 'minds') {
        const list = orderedMinds(h.agents, h.swarms)
        if (!list.length) return
        const a = list[Math.min(c.mindSel, list.length - 1)]
        if (down || up) {
          consume()
          c.setMindSel(Math.max(0, Math.min(list.length - 1, c.mindSel + (down ? 1 : -1))))
          return
        }
        if (k === 'Enter' || k === 'o') {
          consume()
          openSession(a)
          return
        }
        if ((k === 'w' || k === 's') && !e.repeat) {
          consume()
          void run(`${k === 'w' ? 'wake' : 'sleep'} ${slug(a.name)}`)
          return
        }
      }
      if (c.focus === 'inbox') {
        const n = c.inboxTab === 'approvals' ? pendingList(h.approvals).length : c.inboxTab === 'goals' ? goalList(h.goals).length : 0
        if (down || up) {
          consume()
          c.setInboxSel(Math.max(0, Math.min(Math.max(0, n - 1), c.inboxSel + (down ? 1 : -1))))
          return
        }
        if (k === 't') {
          consume()
          c.setInboxTab(INBOX_TABS[(INBOX_TABS.indexOf(c.inboxTab) + 1) % INBOX_TABS.length])
          return
        }
        if (c.inboxTab === 'approvals' && n) {
          // a, Enter or Space open the selected request in the shared decision dialog; a key never answers by itself
          if ((k === 'a' || ((k === 'Enter' || k === ' ') && !t?.closest('button, a, [role="tab"]'))) && !e.repeat) {
            consume()
            const ap = pendingList(h.approvals)[Math.min(c.inboxSel, n - 1)]
            // stamped with the session it was shown under, at the press (Surface O)
            if (ap) c.answer(ap, h.session)
            return
          }
        }
      }
      if (c.focus === 'session' && (k === 'Enter' || k === 'i')) {
        consume()
        c.focusSession()
        return
      }
      if (k === 'Enter' && c.focus === 'stream') {
        consume()
        c.focusCmd()
        return
      }
      // any other printable key starts a command
      if (k.length === 1 && !phone && /\S/.test(k)) {
        consume()
        c.focusCmd(k)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phone])
}

// ------------------------------------------------------------------ chrome

function StatusBar({ phone }: { phone: boolean }) {
  const agents = useHive((s) => s.agents)
  const thinking = useHive((s) => s.thinking)
  const approvals = useHive((s) => s.approvals)
  const conn = useHive((s) => s.connection)
  const hive = useHive((s) => s.hive)
  const focus = useC((s) => s.focus)
  const layout = useC((s) => s.layout)
  const all = Object.values(agents)
  const awake = all.filter((a) => a.status === 'awake').length
  const busy = Object.values(thinking).filter((x) => x === 'llm' || x === 'skills').length
  const pending = pendingList(approvals).length
  const spent = all.reduce((s, a) => s + a.spent_usd, 0)
  const live = conn === 'open'
  return (
    <div data-xc-keep-clear="" className="cx-status" role="banner">
      <span className="cx-brand">
        <span className="cx-brand-mark">▙</span> {phone ? 'CONSTRUCT' : (hive?.name ?? 'OMEGAHIVE').toUpperCase()}
      </span>
      {!phone && (
        <nav className="cx-tabsbar" aria-label="Panes">
          {PANES.map((p, i) => (
            <button key={p} className={focus === p ? 'is-on' : ''} onClick={() => useC.getState().setFocus(p)} aria-current={focus === p}>
              <span className="cx-c-dim">{i + 1}</span>:{PANE_TITLE[p].toLowerCase()}
              {p === 'inbox' && pending > 0 && <span className="cx-c-amber">({pending})</span>}
              {focus === p ? '*' : ''}
            </button>
          ))}
          <button className="cx-layout-btn" onClick={() => void run('layout')} title="cycle layout (alt+L)">
            ▦ {layout}
            <span className="cx-c-dim"> {LAYOUTS.indexOf(layout) + 1}/{LAYOUTS.length}</span>
          </button>
        </nav>
      )}
      <span className="cx-status-r">
        <span className={live ? 'cx-c-hi' : 'cx-c-amber cx-blink'}>{live ? '◉' : '◌'}</span>
        {!phone && <span className={live ? 'cx-c-txt' : 'cx-c-amber'}> {live ? 'live' : conn}</span>}
        <span className="cx-sep" aria-hidden="true">│</span>
        <span className="cx-c-hi">{awake}</span>
        <span className="cx-c-dim">/{all.length}{phone ? '' : ' awake'}</span>
        {busy > 0 && !phone && (
          <>
            <span className="cx-sep" aria-hidden="true">│</span>
            <span className="cx-c-cyan">{busy} thinking</span>
          </>
        )}
        {pending > 0 && (
          <>
            <span className="cx-sep" aria-hidden="true">│</span>
            <button className="cx-c-amber cx-blink-soft cx-bare" onClick={() => void run('inbox')}>
              ⚠ {pending}
            </button>
          </>
        )}
        {!phone && (
          <>
            <span className="cx-sep" aria-hidden="true">│</span>
            <span className="cx-c-txt">${spent.toFixed(2)}</span>
          </>
        )}
        {/* the time is the host's OS clock, bottom right (shell/OsClock): one clock, in the same place in every experience */}
        {!phone && (
          <button className="cx-bare cx-c-dim cx-ui-btn" onClick={() => openGallery(true)} title="choose another experience">
            ui
          </button>
        )}
      </span>
    </div>
  )
}

const AREA: Record<string, Record<PaneId, string>> = {
  operator: { minds: 'minds', stream: 'stream', session: 'session', inbox: 'inbox' },
  quad: { minds: 'minds', stream: 'stream', session: 'session', inbox: 'inbox' },
  stack: { minds: 'minds', stream: 'stream', session: 'session', inbox: 'inbox' },
}

function Grid({ boot }: { boot: number }) {
  const layout = useC((s) => s.layout)
  const focus = useC((s) => s.focus)
  const show = (p: PaneId) => layout !== 'monocle' || focus === p
  const area = (p: PaneId): CSSProperties => ({ gridArea: layout === 'monocle' ? 'main' : AREA[layout][p] })
  return (
    <main className="cx-grid" data-layout={layout}>
      {show('minds') && <PaneSlot style={area('minds')} id="minds" boot={boot} />}
      {show('stream') && <PaneSlot style={area('stream')} id="stream" boot={boot} />}
      {show('session') && <PaneSlot style={area('session')} id="session" boot={boot} />}
      {show('inbox') && <PaneSlot style={area('inbox')} id="inbox" boot={boot} />}
      <Console />
    </main>
  )
}

function PaneSlot({ id, boot, style, phone = false }: { id: PaneId; boot: number; style?: CSSProperties; phone?: boolean }) {
  return (
    <div className="cx-slot" style={style}>
      {id === 'minds' ? <MindsPane boot={boot} /> : id === 'stream' ? <StreamPane boot={boot} /> : id === 'session' ? <SessionPane boot={boot} phone={phone} /> : <InboxPane boot={boot} />}
    </div>
  )
}

// ------------------------------------------------------------------ phone

function PhoneDeck({ boot }: { boot: number }) {
  const focus = useC((s) => s.focus)
  const pending = useHive((s) => countWaiting(s.approvals))
  const reduced = useReducedMotion()
  const noticeRow = useNoticeRow()
  const idx = PANES.indexOf(focus)
  const [dir, setDir] = useState(1)
  const start = useRef<{ x: number; y: number } | null>(null)
  const go = (d: number) => {
    const n = (idx + d + PANES.length) % PANES.length
    setDir(d)
    useC.getState().setFocus(PANES[n])
  }
  return (
    <main className="cx-deck">
      <nav data-xc-keep-clear="" className="cx-pager" aria-label="Panes">
        {PANES.map((p, i) => (
          <button
            key={p}
            className={p === focus ? 'is-on' : ''}
            aria-current={p === focus}
            // on a phone one pane shows at a time: the orchestrator points at a pane through its tab
            data-presence-feature={PANE_FEATURE[p]}
            onClick={() => {
              setDir(i > idx ? 1 : -1)
              useC.getState().setFocus(p)
            }}
          >
            <span className="cx-c-dim">{i + 1}</span> {PANE_TITLE[p].toLowerCase()}
            {p === 'inbox' && pending > 0 && <span className="cx-c-amber"> {pending}</span>}
          </button>
        ))}
      </nav>
      {/* the host's notice sits in this row, as tall as the notice, so the pane and the console below are never under it */}
      {noticeRow && <PhoneNoticeRow />}
      <div
        className="cx-deck-stage"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('input,select,button,textarea')) return
          start.current = { x: e.clientX, y: e.clientY }
        }}
        onPointerUp={(e) => {
          const s = start.current
          start.current = null
          if (!s) return
          const dx = e.clientX - s.x
          const dy = e.clientY - s.y
          if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.6) go(dx < 0 ? 1 : -1)
        }}
        onPointerCancel={() => (start.current = null)}
      >
        <AnimatePresence initial={false} custom={dir} mode="popLayout">
          <m.div
            key={focus}
            className="cx-deck-card"
            custom={dir}
            initial={reduced ? false : { x: `${dir * 30}%`, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { x: `${-dir * 30}%`, opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.24, ease: [0.2, 0.9, 0.1, 1] }}
          >
            <PaneSlot id={focus} boot={boot} phone />
          </m.div>
        </AnimatePresence>
        <Console />
      </div>
    </main>
  )
}

/** The phone deck's reserved notice row (followups-r9 item 2): empty, sized by the host to the notice's actual height. */
export function PhoneNoticeRow() {
  return <div {...{ [NOTICE_ROW]: '' }} className="cx-notice-row" />
}

const countWaiting = (approvals: Record<string, { status: string }>) => {
  let n = 0
  for (const id in approvals) if (approvals[id].status === 'pending') n++
  return n
}

function Chips() {
  const mindId = useC((s) => s.mind)
  const mind = useHive((s) => (mindId ? s.agents[mindId] : undefined))
  const pending = useHive((s) => countWaiting(s.approvals))
  const chips: { label: string; run?: string; insert?: string; tone?: string; hue?: number }[] = []
  if (pending) chips.push({ label: `inbox ${pending}`, run: 'inbox', tone: 'amber' })
  if (mind) {
    const name = slug(mind.name)
    chips.push(mind.status === 'awake' ? { label: `sleep ${name}`, run: `sleep ${name}`, hue: mind.hue } : { label: `wake ${name}`, run: `wake ${name}`, hue: mind.hue })
  }
  chips.push(
    { label: 'open…', insert: 'open ' },
    { label: 'page…', insert: 'page ' },
    { label: 'ls minds', run: 'ls minds' },
    { label: 'tasks', run: 'tasks' },
    { label: 'task…', insert: 'task ' },
    { label: 'usage', run: 'usage' },
    { label: 'swarm new', run: 'swarm new' },
    { label: 'status', run: 'status' },
    { label: 'map', run: 'help features' },
    { label: 'help', run: 'help' },
  )
  return (
    <div data-xc-keep-clear="" className="cx-chips" role="toolbar" aria-label="Quick commands">
      {chips.map((c) => (
        <button
          key={c.label}
          className={`cx-chip${c.tone === 'amber' ? ' is-amber' : ''}`}
          onClick={() => {
            if (c.run) {
              if (c.run === 'inbox') useC.getState().setFocus('inbox')
              void run(c.run)
            } else useC.getState().focusCmd(c.insert)
          }}
        >
          {c.hue != null && <span style={{ color: hsl(c.hue, 90, 64) }}>■ </span>}
          {c.label}
        </button>
      ))}
    </div>
  )
}

