import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useHive, useReducedMotion, useRoute } from '../sdk'
import { cancelAwaiting, complete, promptRoute, run, type Cand } from './commands'
import { slug } from './model'
import { Segs } from './Segs'
import { useC } from './state'
import { Decode } from './Decode'
import { useAskField, useSeen } from '../../features/ask/useAskField'
import { guardComposing } from '../../features/ask/keys'
import { PanelView } from '../../features/ask/ClassicAsk'
import { Thread, ThreadHead, useThreadRows } from '../../features/ask/Thread'
import { shownMind } from '../../features/ask/words'
import { presenceCommand } from '../../features/ask/Presence'
import { useAskStore, type AskRow } from '../../store/ask'
import { bindEpoch, onIdentityChange } from '../../lib/identityEpoch'
import type { Candidate } from '../../lib/intent'

interface TabRun {
  base: string
  start: number
  cands: Cand[]
  i: number
}

const sentence = (c: Candidate) => c.parts.map((p) => p.t).join('')

/**
 * The prompt, and the universal Ask (UNIVERSAL_ASK_DESIGN §1.2, Construct: "the prompt is the Ask"). The command
 * language parses first (autocomplete with ghost text, Tab / Shift+Tab cycling, history on ↑/↓, inline usage, a result
 * line); anything that is not a command falls through to the shared Ask (useAskField: the fast path, then the
 * swarm's orchestrator), with its suggestions in the same completion list, its turns steerable while it works, and
 * its thread as the ASK log above the prompt. Same store, same safety, same keyboard and screen-reader contract as
 * every other skin; only the grammar is the terminal's.
 */
/** `ask <words>`: always a mind, through the Ask's own row and guarded Enter (useAskField forcedAsk); stable for the hook. */
const forcedAsk = (v: string): string | null => {
  const r = promptRoute(v)
  return r.to === 'ask' && r.forced ? r.text : null
}

/** The Ask acted on a request typed here: say it in the console as typed, and only now cancel a pending yes/no. */
const echoDispatch = ({ you, steering }: { you: string; steering: boolean }) => {
  cancelAwaiting()
  useC.getState().echoAsk([{ t: '❯ ', c: 'cyan' }, { t: you, c: 'txt' }, { t: steering ? '  ↳ steer' : '  → ask', c: 'dim' }])
}

export function CommandLine({ phone }: { phone: boolean }) {
  const f = useAskField({ experience: 'construct', forcedAsk, onDispatch: echoDispatch })
  const value = f.value
  const setValue = f.change
  const [tab, setTab] = useState<TabRun | null>(null)
  const [hIdx, setHIdx] = useState(-1)
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const flash = useC((s) => s.flash)
  const mindId = useC((s) => s.mind)
  const mind = useHive((s) => (mindId ? s.agents[mindId] : undefined))
  const threadOpen = useAskStore((s) => s.threadOpen)
  // a page over the construct covers the prompt: the host's floating terminal line is the Ask then (one landmark)
  const covered = useRoute().name !== 'hive'
  const comp = useMemo(() => complete(value), [value])
  // the command language parses first; anything else is a request for the Ask
  const route = promptRoute(value)
  // a request for the Ask, typed plainly or as `ask <words>`: either way its row is shown and Enter is the Ask's (r2.2)
  const asking = !tab && route.to === 'ask'
  // while the first word is still a command's prefix, its completions stay offered (Tab completes it)
  const cands = tab ? tab.cands : asking && /\s/.test(value.trim()) ? [] : comp.cands
  const sel = tab ? tab.i : 0
  const ghost = !tab && comp.token && cands[0] && cands[0].v.toLowerCase().startsWith(comp.token.toLowerCase()) ? cands[0].v.slice(comp.token.length) : ''
  const askList = asking && !f.panel ? f.list : []
  const who = shownMind(f.thread?.mind.name ?? f.answerer)
  const answer = useLatestAnswer()
  // what the orchestrator is doing right now, as the command a second operator would type
  const doing = useAskStore((s) => s.presence[s.presence.length - 1])

  useEffect(() => {
    if (!phone) input.current?.focus({ preventScroll: true })
  }, [phone])
  // an identity change takes the earlier person's typing with it: the field, a Tab cycle's base, a recalled draft
  useEffect(
    () =>
      onIdentityChange(() => {
        setValue('')
        setTab(null)
        setHIdx(-1)
        setDraft('')
      }),
    [setValue],
  )
  // other parts of the construct hand the prompt focus (and sometimes a starting text)
  useEffect(
    () =>
      useC.subscribe((s, prev) => {
        if (s.cmdFocus === prev.cmdFocus) return
        const el = input.current
        if (!el) return
        if (s.cmdFocus.text != null) {
          setValue(s.cmdFocus.text)
          setTab(null)
        }
        el.focus({ preventScroll: true })
      }),
    [setValue],
  )

  const accept = (v: string, start = comp.start) => {
    const next = value.slice(0, start) + v + ' '
    setValue(next)
    setTab(null)
    input.current?.focus()
  }

  const submit = () => {
    const v = value
    setTab(null)
    setHIdx(-1)
    // `ask <words>` never comes here: it is a request for the Ask (asking), shown as its paid row and sent through the
    // Ask's guarded Enter (r2.2); the words are never kept in the terminal's history on this device
    // a command (whatever it then says, a refusal included) is run as the command; never handed to the Ask
    setValue('')
    void run(v)
  }

  /**
   * A request for the Ask: the shared policy (run, choose, clarify, steer, or the orchestrator) through the guarded Enter.
   * The echo and the cancelling of a pending yes/no happen only when it acts (echoDispatch), never on a refused Enter.
   */
  const askEnter = (e: KeyboardEvent<HTMLInputElement>) => f.onKeyDown(e)

  const escape = () => {
    if (useC.getState().consoleOpen) useC.getState().setConsole(false)
    else if (useAskStore.getState().threadOpen) useAskStore.getState().setThreadOpen(false)
    else input.current?.blur()
    return true
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // an IME's confirming key is the input method's: never a command, never an Ask (keys.ts; Kimi r2 #1)
    if (guardComposing(e)) return
    const k = e.key
    // the Ask's own keys while a request is being typed: suggestions, the policy's panel, Esc stepping back
    if (asking || f.panel) {
      // Enter on a request goes to the Ask; Enter on a command (even with the Ask's panel still open) runs the command
      if (k === 'Enter' && !tab && asking) {
        e.preventDefault()
        askEnter(e)
        return
      }
      if ((k === 'ArrowUp' || k === 'ArrowDown') && askList.length) return f.onKeyDown(e)
      if (k === 'Escape') {
        e.stopPropagation()
        return f.onKeyDown(e, escape)
      }
      if (k === 'Tab' && !comp.cands.length && !tab) return f.onKeyDown(e)
    }
    if (k === 'Tab') {
      e.preventDefault()
      if (tab) {
        const i = (tab.i + (e.shiftKey ? tab.cands.length - 1 : 1)) % tab.cands.length
        setTab({ ...tab, i })
        setValue(tab.base.slice(0, tab.start) + tab.cands[i].v)
        return
      }
      const list = comp.cands
      if (!list.length) return
      if (list.length === 1) return accept(list[0].v)
      // fill the longest common prefix first, then cycle
      const lcp = list.reduce((p, c) => {
        let j = 0
        while (j < p.length && j < c.v.length && p[j].toLowerCase() === c.v[j].toLowerCase()) j++
        return p.slice(0, j)
      }, list[0].v)
      if (lcp.length > comp.token.length) {
        setValue(value.slice(0, comp.start) + lcp)
        return
      }
      setTab({ base: value, start: comp.start, cands: list, i: 0 })
      setValue(value.slice(0, comp.start) + list[0].v)
      return
    }
    if (k === 'ArrowRight' && ghost && input.current?.selectionStart === value.length) {
      e.preventDefault()
      setValue(value + ghost)
      return
    }
    if (k === 'Enter') {
      e.preventDefault()
      if (tab) {
        accept(tab.cands[tab.i].v, tab.start)
        return
      }
      submit()
      return
    }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      const h = useC.getState().history
      if (!h.length) return
      e.preventDefault()
      setTab(null)
      if (k === 'ArrowUp') {
        const i = hIdx < 0 ? h.length - 1 : Math.max(0, hIdx - 1)
        if (hIdx < 0) setDraft(value)
        setHIdx(i)
        setValue(h[i])
      } else if (hIdx >= 0) {
        const i = hIdx + 1
        if (i >= h.length) {
          setHIdx(-1)
          setValue(draft)
        } else {
          setHIdx(i)
          setValue(h[i])
        }
      }
      return
    }
    if (k === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (tab) {
        setValue(tab.base)
        setTab(null)
      } else if (value) setValue('')
      else escape()
      return
    }
    if (e.ctrlKey && (k === 'l' || k === 'L')) {
      e.preventDefault()
      useC.getState().clear()
      return
    }
    if (e.ctrlKey && (k === 'c' || k === 'C') && value && input.current?.selectionStart === input.current?.selectionEnd) {
      e.preventDefault()
      useC.getState().echo([{ t: '❯ ', c: 'cyan' }, { t: value + '^C', c: 'dim' }])
      setValue('')
      return
    }
    if (e.ctrlKey && (k === 'u' || k === 'U')) {
      e.preventDefault()
      setValue('')
    }
  }

  const showList = focused && cands.length > 0 && (value.trim().length > 0 || tab != null)
  const showAsk = focused && askList.length > 0
  // what Enter may act on is what the prompt shows (enter.ts AskSeen): the Ask's lines, or its panel
  useSeen(f.declareSeen, showAsk, focused && !!f.panel)
  const listId = `${id}-ask`
  const cmdListId = `${id}-cmd`
  const activeIdx = f.active ? askList.indexOf(f.active) : -1
  // the command completions on show: a window that always holds the selected one (Tab cycles through all of them)
  const limit = phone ? 5 : 9
  const from = Math.min(Math.max(0, sel - limit + 1), Math.max(0, cands.length - limit))
  const shownCands = cands.slice(from, from + limit)
  // the option the field points at: the Ask's while its list shows, otherwise the selected command completion
  const activeId = showAsk ? (activeIdx >= 0 ? `${id}-o${activeIdx}` : undefined) : showList ? `${id}-c${sel}` : undefined
  const controls = [showList ? cmdListId : '', showAsk ? listId : ''].filter(Boolean).join(' ') || undefined
  return (
    // the Ask's landmark here (one per page: the host's own floating line takes over only when a page covers this)
    <section aria-label={covered ? undefined : 'Ask'} data-ask-zone="" data-skin="command-line" className="cx-ask-zone">
      <AnimatePresence>{threadOpen && !covered && <AskLog key="log" phone={phone} />}</AnimatePresence>
      <div data-xc-keep-clear="" className={`cx-cmd${focused ? ' is-focus' : ''}${asking ? ' is-ask' : ''}${f.answering ? ' is-answering' : ''}`}>
        <AnimatePresence>
          {(showList || showAsk || f.panel) && (
            <m.div key="ac" className="cx-ac" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.12 }}>
              {showList && (
                <ul id={cmdListId} role="listbox" aria-label="Completions" className="cx-ac-list" data-unsaved-ignore="">
                  {from > 0 && <li className="cx-c-dim" aria-hidden>{`${from} earlier · shift+tab`}</li>}
                  {shownCands.map((c, k) => {
                    const i = from + k
                    return (
                    <li
                      key={c.v}
                      id={`${id}-c${i}`}
                      role="option"
                      aria-selected={i === sel && !showAsk}
                      className={i === sel && !showAsk ? 'is-sel' : ''}
                      onPointerDown={(e) => {
                        e.preventDefault()
                        accept(c.v, tab ? tab.start : comp.start)
                      }}
                    >
                      <span className="cx-c-hi">{c.v}</span>
                      {c.d && <span className="cx-c-dim"> {c.d}</span>}
                    </li>
                    )
                  })}
                  {cands.length > from + limit && <li className="cx-c-dim" aria-hidden>+{cands.length - from - limit} more · keep typing</li>}
                </ul>
              )}
              {f.panel ? (
                <div className="cx-ask-panel">
                  <PanelView f={f} />
                </div>
              ) : (
                showAsk && (
                  <ul id={listId} role="listbox" aria-label="What this will do" className="cx-ac-list cx-ac-ask" data-unsaved-ignore="">
                    {askList.map((c, i) => (
                      <li
                        key={c.key}
                        id={`${id}-o${i}`}
                        role="option"
                        aria-selected={c === f.active}
                        aria-label={sentence(c)}
                        className={c === f.active ? 'is-sel' : ''}
                        onPointerDown={(e) => {
                          e.preventDefault()
                          void f.take(c)
                        }}
                        onMouseMove={() => i !== f.sel && f.setSel(i)}
                      >
                        <span className="cx-c-cyan">{c.tag.toLowerCase().padEnd(6, ' ')}</span>
                        <span className="cx-c-txt">{sentence(c)}</span>
                      </li>
                    ))}
                  </ul>
                )
              )}
            </m.div>
          )}
        </AnimatePresence>
        <div className="cx-hint" aria-live="polite">
          {f.answering ? (
            <span className="cx-ask-status">
              <span className="cx-c-cyan">{who.toLowerCase()}@hive</span> <span className="cx-spin" aria-hidden />{' '}
              {doing && doing.op === useAskStore.getState().open ? (
                <>
                  <span className="cx-c-hi">{presenceCommand(doing)}</span>
                  {doing.caption && <span className="cx-c-dim">{`  # ${doing.caption}`}</span>}
                </>
              ) : (
                <span className="cx-c-txt">{f.step === 'sending' ? 'connecting' : f.step ?? 'working'}</span>
              )}
              <span className="cx-c-dim"> · type to steer · </span>
              <button type="button" className="cx-key" onClick={() => void useAskStore.getState().stop()} aria-label="Stop the answer">
                stop
              </button>
            </span>
          ) : asking ? (
            <>
              <span className="cx-c-cyan">ask </span>
              <span className="cx-c-dim">· not a command: enter asks the fast path, then {who.toLowerCase()} · </span>
              <span className="cx-c-dim">tab completes · esc clears</span>
            </>
          ) : comp.usage && value.trim() ? (
            <>
              <span className="cx-c-dim">usage </span>
              <span className="cx-c-hi">{comp.usage}</span>
              <span className="cx-c-dim"> · {comp.desc}</span>
            </>
          ) : answer ? (
            <span key={answer.id} className="cx-flash">
              <span className="cx-flash-l">
                <span className="cx-c-cyan">{shownMind(answer.who).toLowerCase()}@hive ❯ </span>
                <Decode text={answer.text.replace(/\s+/g, ' ').slice(0, 160)} className="cx-c-hi" />
              </span>
            </span>
          ) : flash ? (
            <m.span key={flash.id} className="cx-flash" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              {flash.lines.map((l, i) => (
                <span key={i} className="cx-flash-l">
                  <Segs segs={l} />
                </span>
              ))}
            </m.span>
          ) : (
            <span className="cx-c-dim">
              type <span className="cx-c-hi">help</span>, or just ask · <span className="cx-c-hi">tab</span> completes · <span className="cx-c-hi">↑↓</span> history
              {!phone && (
                <>
                  {' '}
                  · <span className="cx-c-hi">esc</span> then <span className="cx-c-hi">1–4</span> for panes
                </>
              )}
            </span>
          )}
          <button type="button" className="cx-key cx-ask-toggle" onClick={() => useAskStore.getState().setThreadOpen(!threadOpen)} aria-expanded={threadOpen} aria-label={threadOpen ? 'Hide the ask log' : 'Show the ask log'}>
            {threadOpen ? 'log ×' : 'ask log'}
          </button>
        </div>
        <label className="cx-prompt">
          <span className="cx-c-cyan">operator</span>
          <span className="cx-c-dim">@</span>
          <span className="cx-c-hi">hive</span>
          <span className="cx-c-dim">:~{mind ? '/' + slug(mind.name) : ''}</span>
          <span className={`cx-glow ${asking ? 'cx-c-cyan' : 'cx-c-hi'}`}> {asking ? '⟫' : '❯'} </span>
          <span className="cx-field">
            <span className="cx-ghost" aria-hidden>
              <span className="cx-ghost-v">{value}</span>
              {ghost}
            </span>
            <input
              ref={input}
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setTab(null)
                setHIdx(-1)
              }}
              onKeyDown={onKey}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              aria-label="Command line: type a command, or ask anything"
              aria-describedby="cx-cmd-help"
              role="combobox"
              aria-expanded={showAsk || showList}
              aria-controls={controls}
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              data-ask-input=""
              // resting mode: keys typed on the resting screen land here (the prompt is Construct's Ask)
              data-rest-type=""
              placeholder={focused ? '' : f.answering ? 'type to steer it while it works' : phone ? 'type a command, or ask' : 'press / to type a command, or just ask'}
            />
          </span>
        </label>
        <span id="cx-cmd-help" hidden>
          Type a command such as help, ls minds, open a mind, say mind text; anything else is asked. Tab completes, up and down recall history.
        </span>
      </div>
    </section>
  )
}

/**
 * The newest answer, for the line under the prompt (shown decoded once, as it arrives; never on first sight). It belongs
 * to the Ask's thread it arrived in (stand-in ASK_EVERYWHERE_R1 #1): a thread reset (New thread, Delete thread, every
 * identity change) hides it in the same render, an identity change also drops it from state inside the change itself
 * (lib/identityEpoch), and a write made for an earlier identity never lands (bindEpoch: checked at the write, and
 * the expiry through its guarded commit).
 */
function useLatestAnswer(): AskRow | null {
  const rows = useThreadRows()
  const askEpoch = useAskStore((s) => s.epoch)
  const last = useMemo(() => [...rows].reverse().find((r) => r.kind === 'answer'), [rows])
  const seen = useRef<string | null | undefined>(undefined)
  const [shown, setShown] = useState<{ row: AskRow; ask: number } | null>(null)
  useEffect(
    () =>
      onIdentityChange(() => {
        seen.current = null
        setShown(null)
      }),
    [],
  )
  useEffect(() => {
    if (seen.current === undefined) {
      seen.current = last?.id ?? null
      return
    }
    if (!last) {
      // the thread was cleared: whatever was shown went with it (never drawn without its row: see the return)
      seen.current = null
      return
    }
    if (last.id === seen.current) return
    seen.current = last.id
    const binding = bindEpoch()
    // checked again at the write itself: shown only while the identity it arrived under is still the current one
    setShown(binding.current() ? { row: last, ask: useAskStore.getState().epoch } : null)
    // the expiry, a write after a wait: only under the identity it was set under (bindEpoch's guarded commit)
    const t = window.setTimeout(() => void binding.commit(() => setShown(null)), 9000)
    return () => window.clearTimeout(t)
  }, [last])
  return shown && last && shown.ask === askEpoch ? shown.row : null
}

/** The ASK log: the shared thread in the terminal's grammar, above the prompt (the Ask's memory, not the console's). */
function AskLog({ phone }: { phone: boolean }) {
  const reduced = useReducedMotion()
  return (
    <m.div
      className={`cx-ask-log${phone ? ' is-phone' : ''}`}
      role="region"
      aria-label="Ask thread"
      initial={reduced ? false : { opacity: 0, y: 18, clipPath: 'inset(100% 0% 0% 0%)' }}
      animate={{ opacity: 1, y: 0, clipPath: 'inset(0% 0% 0% 0%)' }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12, clipPath: 'inset(100% 0% 0% 0%)' }}
      transition={{ duration: reduced ? 0 : 0.2, ease: [0.2, 0.9, 0.1, 1] }}
    >
      <header className="cx-pane-head">
        <span className="cx-pane-n">⟫_</span>
        <span className="cx-pane-t">ASK</span>
      </header>
      <ThreadHead variant="terminal" onClose={() => useAskStore.getState().setThreadOpen(false)} />
      <Thread variant="terminal" />
    </m.div>
  )
}

/** Scrollback of everything the command line printed. */
export function Console() {
  const open = useC((s) => s.consoleOpen)
  const lines = useC((s) => s.console)
  const reduced = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length, open])
  // the viewport can shrink under the reader (the phone's notice row opening, a resize): a console that was showing
  // its newest line keeps showing it; one scrolled back stays where it was
  useEffect(() => {
    const el = ref.current
    if (!el || !open || typeof ResizeObserver === 'undefined') return
    let atEnd = true
    const onScroll = () => { atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 4 }
    const ro = new ResizeObserver(() => { if (atEnd) el.scrollTop = el.scrollHeight })
    el.addEventListener('scroll', onScroll, { passive: true })
    ro.observe(el)
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
    }
  }, [open])
  return (
    <AnimatePresence>
      {open && (
        <m.div
          key="console"
          className="cx-console"
          initial={reduced ? false : { opacity: 0, y: 24, clipPath: 'inset(100% 0% 0% 0%)' }}
          animate={{ opacity: 1, y: 0, clipPath: 'inset(0% 0% 0% 0%)' }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 16, clipPath: 'inset(100% 0% 0% 0%)' }}
          transition={{ duration: reduced ? 0 : 0.22, ease: [0.2, 0.9, 0.1, 1] }}
          role="log"
          aria-label="Console"
        >
          <header className="cx-pane-head">
            <span className="cx-pane-n">&gt;_</span>
            <span className="cx-pane-t">CONSOLE</span>
            <span className="cx-pane-meta">
              <button className="cx-key" onClick={() => useC.getState().clear()}>
                clear
              </button>{' '}
              <button className="cx-key" onClick={() => useC.getState().setConsole(false)}>
                esc ×
              </button>
            </span>
          </header>
          <div className="cx-console-body" ref={ref}>
            {lines.map((l) => (
              <div key={l.id} className="cx-line">
                <Segs segs={l.segs} />
              </div>
            ))}
          </div>
        </m.div>
      )}
    </AnimatePresence>
  )
}
