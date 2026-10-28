import { plural } from '../../lib/plural'
import { AnimatePresence, m } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FEATURES, featureById } from '../../features/registry'
import { openClassic, openGallery, openPalette, shown, storeIdentity, useHive, useHomeRequested, useReducedMotion } from '../sdk'
import { Ask, isStillAct, type Receipt } from './Ask'
import { registerActHandler } from '../../features/ask/handlers'
import { Thread, ThreadHead } from '../../features/ask/Thread'
import { usePresenceWords } from '../../features/ask/Presence'
import { useAskView } from '../../features/ask/view'
import { askOrigin, useAskStore } from '../../store/ask'
import './vocab'
import { groupsInOrder, STILL_PLACE, type SheetKind } from './features'
import type { Act } from './intent'
import { cap, dateLine, greeting, spell } from './language'
import { Learned } from './Learned'
import { Needs } from './Needs'
import { Now } from './Now'
import { Reading } from './Reading'
import { searchHive } from './search'
import { Sheet } from './Sheets'
import { useNow, useSprings, useWorld } from './shared'
import './still.css'
import { DirectingStudio } from '../../features/studioLive/DirectingStudio'


/** How long Still waits for the hive before saying plainly that nothing is confirmed (and letting go of busy). */
const WAIT_MS = 15_000
const TIMEOUT = Symbol('timeout')
function within<T>(p: Promise<T>): Promise<T | typeof TIMEOUT> {
  let t: number | undefined
  return Promise.race([p, new Promise<typeof TIMEOUT>((r) => (t = window.setTimeout(() => r(TIMEOUT), WAIT_MS)))]).finally(() => window.clearTimeout(t))
}
/**
 * The store's wake/sleep reports a refusal only as an error toast (it resolves either way), so Still watches for
 * that toast to tell the person plainly and keep their words.
 */
/** The store says whether the hive took it (no longer read back from the toasts). */
async function confirmed(run: () => Promise<boolean>): Promise<'ok' | 'refused' | 'timeout'> {
  const r = await within(run())
  if (r === TIMEOUT) return 'timeout'
  return r ? 'ok' : 'refused'
}

/**
 * Still: the hive as a calm sheet of paper. No navigation. A greeting, one place to ask, and three quiet passages:
 * what needs you, what is happening, and what the hive has learned. Opening a mind turns the page into a reading room.
 */
export default function Still() {
  const world = useWorld()
  const reduced = useReducedMotion()
  const sp = useSprings()
  const now = useNow(30_000)
  const hiveName = useHive((s) => s.hive?.name)
  const [focus, setFocus] = useState<string | null>(null)
  const [sheet, setSheet] = useState<SheetKind | null>(null)
  const everyRef = useRef<HTMLElement>(null)
  const ask = useRef<HTMLInputElement>(null)
  const needHead = useRef<HTMLElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const needsRef = useRef<HTMLElement>(null)
  const nowRef = useRef<HTMLElement>(null)
  const learnedRef = useRef<HTMLElement>(null)

  const open = useCallback((id: string) => {
    if (!returnTo.current) returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSheet(null)
    setFocus(id)
  }, [])
  const openSheet = useCallback((k: SheetKind) => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setFocus(null)
    setSheet(k)
  }, [])
  const close = useCallback(() => {
    setFocus(null)
    setSheet(null)
    const back = returnTo.current
    returnTo.current = null
    window.setTimeout(() => (back && document.contains(back) ? back.focus({ preventScroll: true }) : ask.current?.focus({ preventScroll: true })), 60)
  }, [])
  const away = !!focus || !!sheet
  // a surface's X lands on the plain page: no reading room or sheet left open (home:requested)
  useHomeRequested(() => {
    returnTo.current = null
    setFocus(null)
    setSheet(null)
  })

  // Esc leaves the reading room (after any classic page above us has had its turn).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== 'Escape' || !away) return
      e.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [away, close])

  // "/" asks. Captured first, so the classic shell's "/" (search) does not also fire here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || away || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      if (!t?.closest?.('.still') && t !== document.body) return
      e.preventDefault()
      e.stopPropagation()
      ask.current?.focus({ preventScroll: true })
      ask.current?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [away, reduced])

  const scrollTo = (k: 'needs' | 'now' | 'learned' | 'everything') => {
    ({ needs: needsRef, now: nowRef, learned: learnedRef, everything: everyRef })[k].current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    // the request's heading, never its Yes: a decision starts with reading
    if (k === 'needs') window.setTimeout(() => needHead.current?.focus({ preventScroll: true }), reduced ? 0 : 450)
  }

  const act = async (a: Act): Promise<Receipt | null> => {
    const s = useHive.getState()
    const offline = (what: string): Receipt => ({ tone: 'error', keep: true, text: `Not connected to the hive, so ${what}. Your words are still here.` })
    switch (a.do) {
      case 'send':
        if (!s.client) return offline('nothing was sent')
        // the reading room shows it going, and keeps it with a Retry if the hive refuses
        open(a.mind.id)
        void s.sendMessage(a.mind.id, a.text)
        return null
      case 'open':
        open(a.mind.id)
        return null
      case 'sleep': {
        if (!s.client) return offline(`${a.mind.name} was not put to sleep`)
        // the store re-reads the host's may_sleep and the mind's status at the press, by the one awake rule (r1.3)
        // r1.4: bound to the identity this act started under
        const r = await within(s.sleepChecked(a.mind.id, a.mind.name, storeIdentity(s)))
        if (r === TIMEOUT) return { tone: 'error', keep: true, text: `No answer from the hive about putting ${a.mind.name} to sleep yet. Nothing is confirmed; check before trying again.` }
        if (!r) return null
        return r.ok ? { text: r.text } : { tone: 'error', keep: true, text: r.text }
      }
      case 'wake': {
        if (!s.client) return offline(`${a.mind.name} was not woken`)
        const r = await confirmed(() => s.agentAction(a.mind.id, 'wake'))
        if (r === 'refused') return { tone: 'error', keep: true, text: `The hive refused waking ${a.mind.name}. Nothing changed; your words are still here.` }
        if (r === 'timeout') return { tone: 'error', keep: true, text: `No answer from the hive about waking ${a.mind.name} yet. Nothing is confirmed; check before trying again.` }
        return { text: `Waking ${a.mind.name}.`, link: { label: 'Open the conversation', run: () => open(a.mind.id) } }
      }
      case 'remind':
        // not one of Still's own acts (Ask.tsx STILL_ACTS): the shared runner does it (features/ask/run.ts)
        return null
      case 'goal': {
        if (!s.client) return offline('no task was made')
        const g = await within(s.createGoal(a.swarm.id, { title: a.title }))
        if (g === TIMEOUT) return { tone: 'error', keep: true, text: `No answer from the hive about the task for ${a.swarm.name} yet. Nothing is confirmed; check its tasks before trying again.`, link: { label: 'See its tasks', run: () => openClassic({ name: 'tasks', swarm: a.swarm.id }) } }
        return g
          ? { text: `${a.swarm.name} has a new task: “${g.title}”.`, link: { label: 'See its tasks', run: () => openClassic({ name: 'tasks', swarm: a.swarm.id }) } }
          : { tone: 'error', keep: true, text: 'The task could not be made. Nothing changed; your words are still here.' }
      }
      case 'scroll':
        scrollTo(a.to)
        return null
      case 'feature':
        return openFeature(a.id, a.name)
      case 'swarm':
        openClassic({ name: 'swarm', id: a.swarm.id })
        return null
      case 'gallery':
        openGallery(true)
        return null
      case 'search': {
        // in place, with exactly what was typed; the shared palette (which cannot take a query) stays one step away
        const h = useHive.getState()
        const found = searchHive(a.text, { minds: world.minds, swarms: world.swarms, goals: h.goals, beliefs: h.beliefs })
        const run = (f: (typeof found)[number]) => () => {
          if (f.kind === 'mind') open(f.id)
          else if (f.kind === 'swarm') openClassic({ name: 'swarm', id: f.id })
          else if (f.kind === 'goal') openClassic({ name: 'tasks', ...(h.goals[f.id] ? { swarm: h.goals[f.id].swarm_id, task: f.id } : {}) })
          else openClassic({ name: 'swarm', id: f.id, statement: f.statement })
        }
        return {
          keep: true,
          text: found.length ? `${cap(spell(found.length))} ${found.length === 1 ? 'thing mentions' : 'things mention'} “${a.text}”.` : `Nothing here mentions “${a.text}”.`,
          link: { label: 'Search with the palette', run: openPalette },
          results: found.map((f) => ({ key: `${f.kind}-${f.id}-${f.statement ?? ''}`, title: f.title, sub: f.sub, run: run(f) })),
        }
      }
    }
  }

  /** Any hive feature: Still's own sheet or passage when it has one, the host's window, or its classic page. */
  const openFeature = (id: string, name?: string): Receipt | null => {
    const place = STILL_PLACE[id]
    const f = featureById(id)
    if (place && 'sheet' in place) openSheet(place.sheet)
    else if (place && 'scroll' in place) {
      setSheet(null)
      setFocus(null)
      window.setTimeout(() => scrollTo(place.scroll), 30)
    } else if (place?.host === 'gallery') openGallery(true)
    else if (place?.host === 'search') ask.current?.focus()
    else if (place?.host === 'stopall') useHive.getState().setStopAll(true)
    else if (f?.classic) {
      openClassic(f.classic)
      if (id === 'swarms.launch') return { text: name ? `Starting a new swarm. Name it “${name}” and choose who can see it; Private is first.` : 'Starting a new swarm. Choose who can see it; Private is first.' }
    }
    return null
  }

  // the floating line (when this box is out of view) does Still's acts the same way, with a thread row as receipt
  const actRef = useRef(act)
  useEffect(() => {
    actRef.current = act
  })
  useEffect(
    () =>
      registerActHandler('still', async (a, you) => {
        if (!isStillAct(a)) return false
        const origin = askOrigin()
        const r = await actRef.current(a)
        // Review B1: written only into the thread it started in
        if (r) useAskStore.getState().addLocal(you, r.text, { where: 'on the paper', origin })
        return r?.keep ? 'keep' : true
      }),
    [],
  )

  const d = new Date(now)
  const awake = world.minds.filter((x) => x.awake).length
  // what the paper shows, for the orchestrator (context.view): the minds awake and what needs the person
  useAskView('still', {
    title: 'Still',
    refs: world.minds.filter((x) => x.awake).slice(0, 20).map((x) => ({ kind: 'mind' as const, ref: x.id, label: x.name })),
    summary: `${world.pending} waiting on you; ${awake} of ${plural(world.minds.length, 'mind')} awake`,
  })
  const letterRows = useAskStore((s) => s.log.length)
  const words = usePresenceWords()
  const learnedToday = useHive((s) => {
    let n = 0
    for (const sid in s.beliefs) for (const st in s.beliefs[sid]) if (now - Date.parse(s.beliefs[sid][st].updated_at) < 86_400_000) n++
    return n
  })

  const rise = (i: number) => ({
    initial: reduced ? false : ({ opacity: 0, y: 14 } as const),
    animate: { opacity: 1, y: 0 },
    transition: { ...sp.gentle, delay: reduced ? 0 : 0.08 + i * 0.09 },
  })

  return (
    <div className="still" data-reduced={reduced}>
      <div className="still-paper" />
        <div className="still-scroll" aria-hidden={away} inert={away}>
          <main className="still-col">
            <header style={{ paddingTop: 'clamp(56px, 13vh, 132px)' }}>
              <m.p className="st-kicker" {...rise(0)} style={{ margin: '0 0 22px' }}>
                {dateLine(d)} · {shown(hiveName) || 'The hive'}
              </m.p>
              <m.h1 className="st-greet" {...rise(1)}>
                {greeting(d)}
              </m.h1>
              <m.p className="st-summary" {...rise(2)} style={{ marginTop: 26 }}>
                {world.pending ? (
                  <button className="st-link st-serif" style={{ fontSize: 'inherit' }} onClick={() => scrollTo('needs')}>
                    {world.pending === 1 ? 'One thing needs you' : `${cap(spell(world.pending))} things need you`}
                  </button>
                ) : (
                  'Nothing needs you'
                )}
                .{' '}
                {world.minds.length === 0
                  ? 'The hive is empty and waiting.'
                  : awake === 0
                    ? 'Every mind is resting.'
                    : `${cap(spell(awake))} ${awake === 1 ? 'mind is' : 'minds are'} awake`}
                {world.minds.length > 0 && awake > 0 && (learnedToday > 0 ? `, and the hive has learned ${spell(learnedToday)} ${learnedToday === 1 ? 'thing' : 'things'} today.` : '.')}
              </m.p>
            </header>

            <m.nav className="st-quick" aria-label="Start something" {...rise(2)}>
              <button className="st-link" onClick={() => openFeature('swarms.launch')}>
                Start a swarm
              </button>
              <span aria-hidden>·</span>
              <button className="st-link" onClick={() => openSheet('create')}>
                Make a mind
              </button>
              <span aria-hidden>·</span>
              <button className="st-link" onClick={() => scrollTo('everything')}>
                Everything
              </button>
            </m.nav>

            <m.div {...rise(3)} style={{ marginTop: 'clamp(36px, 7vh, 64px)' }}>
              <Ask inputRef={ask} world={world} onAct={act} />
              {/* J3 r4.3 O3: the Studio setup card / Directing Studio shows even before the letter has rows */}
              {letterRows === 0 && <DirectingStudio />}
              {letterRows > 0 && (
                <section className="st-letter" aria-label="Today’s page">
                  <ThreadHead variant="letter" />
                  <Thread variant="letter" words={words} />
                </section>
              )}
            </m.div>

            <m.section ref={needsRef} className="st-section" aria-labelledby="st-h-needs" data-presence-region="needs" data-presence-feature="decide.approvals" {...rise(4)}>
              <div className="st-section-head">
                <h2 id="st-h-needs" className="st-kicker" style={{ margin: 0 }}>
                  Needs you
                </h2>
              </div>
              <Needs headRef={needHead} />
            </m.section>

            <m.section ref={nowRef} className="st-section" aria-labelledby="st-h-now" data-presence-region="now" data-presence-feature="minds.see" {...rise(5)}>
              <div className="st-section-head">
                <h2 id="st-h-now" className="st-kicker" style={{ margin: 0 }}>
                  Happening now
                </h2>
              </div>
              <Now focusId={focus} onOpen={open} />
            </m.section>

            <m.section ref={learnedRef} className="st-section" aria-labelledby="st-h-learned" data-presence-region="learned" data-presence-feature="swarms.beliefs" {...rise(6)}>
              <div className="st-section-head">
                <h2 id="st-h-learned" className="st-kicker" style={{ margin: 0 }}>
                  Lately the hive learned
                </h2>
              </div>
              <Learned />
            </m.section>

            <m.section ref={everyRef} className="st-section" aria-labelledby="st-h-everything" data-presence-region="everything" {...rise(7)}>
              <div className="st-section-head">
                <h2 id="st-h-everything" className="st-kicker" style={{ margin: 0 }}>
                  Everything the hive can do
                </h2>
              </div>
              <p className="st-every-lede">
                Ask for any of these by name above, or choose one here. The {FEATURES.filter((f) => STILL_PLACE[f.id]).length} marked with a dot open on this paper; the rest open their full page, and come back here when closed.
              </p>
              <div className="st-every">
                {groupsInOrder().map(([g, label, list]) => (
                  <section key={g} className="st-every-group" aria-label={label}>
                    <h3>{label}</h3>
                    <p>
                      {list.map((f) => (
                        <span key={f.id}>
                          <button className="st-every-item" data-here={STILL_PLACE[f.id] ? '' : undefined} data-presence-feature={f.id} title={f.blurb} onClick={() => void openFeature(f.id)}>
                            {f.label}
                          </button>
                        </span>
                      ))}
                    </p>
                  </section>
                ))}
              </div>
            </m.section>

            <footer className="st-foot">
              Press <kbd>/</kbd> to ask for anything. The Ω below has every other way in.
            </footer>
          </main>
        </div>

        <AnimatePresence>
          {focus && <Reading key={focus} id={focus} onClose={close} />}
          {sheet && !focus && <Sheet key={sheet} kind={sheet} onClose={close} onOpenMind={open} onLaunch={() => openFeature('swarms.launch')} />}
        </AnimatePresence>
    </div>
  )
}
