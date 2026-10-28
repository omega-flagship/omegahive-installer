import { plural } from '../../lib/plural'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { fillAsk } from '../../features/ask/useAskField'
import { useAskView } from '../../features/ask/view'
import { readAskRoom } from '../../features/ask/askRoom'
import { isTypingTarget, useMediaQuery, useReducedMotion } from '../../lib/hooks'
import { Compare, Deliver, Drawer, Empty, ErrorState, NoticeLine, Skeleton, TopLine } from './Chrome'
import type { Reserve, View } from './geometry'
import { describeElement } from './model'
import { Stage } from './Stage'
import { useCanvas, type CanvasProps } from './useCanvas'
import { DECK_NOTE } from './words'
import './designCanvas.css'

/**
 * Design's living canvas (Surface, piece 1 of LIVING_CANVAS_REDESIGN_OUTLINE_20261005). The work fills the screen;
 * there are no panels. The universal Ask is the main way in; pointing at something reveals its controls beside it;
 * Make, Compare and Deliver are three states of the same canvas; the brief, versions, sources, custody receipts and
 * tools live in one pull-up drawer. Anything that leaves the canvas waits for the person's confirm in the host.
 * Design's engine, data contract and custody are unchanged: this is presentation and interaction over its contract.
 */
export default function DesignCanvas(props: CanvasProps) {
  const s = useCanvas(props)
  const reduced = useReducedMotion()
  const coarse = useMediaQuery('(pointer: coarse)')
  const phone = useMediaQuery('(max-width: 699px)')
  const { room, present } = useAskRoom()
  const ask = useAskFill()
  const [view, setView] = useState<{ v: View; fit: () => void; zoom: (f: number) => void } | null>(null)
  const idle = useIdle(2600)

  // the reserved bands: the quiet top line, and the Ask's bottom band (which also clears Ω's corner)
  const reserve: Reserve = useMemo(() => ({ top: phone ? 104 : 64, right: 0, bottom: phone ? Math.max(room, 84) + 52 : Math.max(room, 84), left: 0 }), [room, phone])

  // what the Ask knows about this page: ids and act ids; labels stay here (features/ask/view)
  const sel = s.scene && s.selected ? s.scene.elements.find((e) => e.id === s.selected) : null
  useAskView(
    'design-canvas',
    s.doc && s.scene
      ? {
          title: s.scene.title,
          refs: [{ kind: 'artifact', ref: s.doc.reference.artifact_id }, ...(sel ? [{ kind: 'item' as const, ref: sel.id }] : [])],
          acts: ['save-source'],
          summary: `Design canvas (${s.mode}): ${plural(s.scene.elements.length, 'element')}${sel ? `; selected ${describeElement(sel)}` : ''}${s.dirty ? '; changes not kept yet' : ''}`,
        }
      : { title: 'Design canvas', summary: s.phase.kind === 'empty' ? 'An empty canvas: nothing is open yet' : `The canvas is ${s.phase.kind}` },
  )

  // ⌘Z / ⇧⌘Z / Ctrl+Y anywhere on the page, unless the person is typing (the Ask, a field, the words editor)
  const { undo, redo } = s
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || isTypingTarget(e.target) || document.querySelector('[aria-modal="true"]')) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [undo, redo])

  const notify = useCallback((text: string) => s.setNotice({ text, tone: 'error' }), [s])
  // j0-fixes r1: a starter (and every other canvas suggestion) FILLS the Ask with editable words and never sends: the
  // person's own Send goes through the guarded Ask, which shows the paid row (who answers, who pays). Unsent words the
  // person already typed are never overwritten without asking.
  const askOrSay = useCallback(
    (text: string) => {
      const notInLook = () => s.setNotice({ text: 'The Ask is not in this look yet. Switch to Classic or Still to ask, or edit the design directly.', tone: 'warn' })
      if (!present) return notInLook()
      const r = ask(text)
      if (r === 'none') return notInLook()
      if (r === 'kept')
        s.setNotice({
          text: 'Your unsent words are still in the Ask. Nothing was sent.',
          tone: 'warn',
          action: { label: 'Replace them with this', run: () => void ask(text, true) },
        })
    },
    [present, ask, s],
  )
  const onView = useCallback((v: View, fit: () => void, zoom: (f: number) => void) => setView({ v, fit, zoom }), [])

  return (
    <div
      className="dc"
      data-mode={s.mode}
      data-idle={idle && s.mode === 'make' ? '' : undefined}
      data-reduced={reduced || undefined}
      data-phone={phone || undefined}
      role="region"
      aria-label={`${props.program.name}: the living canvas`}
      style={{ ['--dc-top' as string]: `${reserve.top}px`, ['--dc-bottom' as string]: `${reserve.bottom}px` }}
    >
      {s.phase.kind === 'empty' && <Empty ask={askOrSay} askReady={present} recent={s.recent} scope={props.scope} />}
      {s.phase.kind === 'loading' && <Skeleton reduced={reduced} />}
      {s.phase.kind === 'error' && (
        <ErrorState
          text={s.phase.text}
          actions={[
            ...(s.phase.retry ? [{ label: 'Try again', run: s.retry }] : []),
            ...(props.openOwn ? [{ label: 'Open in the Studio', run: props.openOwn }] : []),
            { label: 'Ask for help', run: () => askOrSay('This design would not open on the canvas. What can I do?') },
          ]}
        />
      )}
      {s.phase.kind === 'deck' && <ErrorState text={DECK_NOTE} actions={props.openOwn ? [{ label: 'Open in the Studio', run: props.openOwn }] : []} />}

      {s.phase.kind === 'ready' && s.scene && (
        <>
          {s.mode === 'make' && (
            <Stage
              scene={s.scene}
              selected={s.selected}
              onSelect={s.select}
              commit={s.commit}
              generation={s.generation}
              ask={askOrSay}
              reserve={reserve}
              reduced={reduced}
              coarse={coarse}
              onView={onView}
              notify={notify}
            />
          )}
          {s.mode === 'compare' && <Compare s={s} ask={askOrSay} />}
          {s.mode === 'deliver' && <Deliver s={s} ask={askOrSay} />}
          <TopLine s={s} zoom={view?.v.scale ?? null} onFit={() => view?.fit()} onZoom={(f) => view?.zoom(f)} phone={phone} />
          <Drawer s={s} open={s.drawer} onOpen={() => s.setDrawer(true)} onClose={() => s.setDrawer(false)} />
        </>
      )}
      <NoticeLine n={s.notice} onClose={() => s.setNotice(null)} />
    </div>
  )
}

// ------------------------------------------------------------------ the Ask, from the canvas

/**
 * The canvas's words put into the universal Ask, editable, for the person to send (j0-fixes r1). Nothing is sent from
 * here: no model request happens merely by choosing a starter (SOLO_ASK_STUDIO_HANDOFF "First creation").
 */
function useAskFill() {
  return useCallback((text: string, replace = false): 'filled' | 'kept' | 'none' => {
    const r = fillAsk(text, { replace })
    // the person's next keystroke edits the words (Classic and Still mark their field; Professional names its own)
    if (r === 'filled') document.querySelector<HTMLInputElement>('[data-ask-input], input[aria-label="Ask the hive"]')?.focus()
    return r
  }, [])
}

/** The Ask's bottom band (`--ask-room`, set by the host's Ask) and whether an Ask is on screen at all. */
function useAskRoom(): { room: number; present: boolean } {
  const read = () => {
    const root = document.documentElement
    const room = readAskRoom(root)
    return `${room}|${root.dataset.ask ? 1 : 0}`
  }
  const sig = useSyncExternalStore(
    (cb) => {
      const mo = new MutationObserver(cb)
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-ask'] })
      return () => mo.disconnect()
    },
    read,
    () => '0|0',
  )
  const [room, present] = sig.split('|')
  return { room: Number(room), present: present === '1' }
}

/** True after `ms` with no pointer or key on the page: the quiet controls recede (focus or hover brings them back). */
function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false)
  const t = useRef(0)
  useEffect(() => {
    const wake = () => {
      setIdle(false)
      window.clearTimeout(t.current)
      t.current = window.setTimeout(() => setIdle(true), ms)
    }
    wake()
    const kinds = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const
    kinds.forEach((k) => window.addEventListener(k, wake, { passive: true }))
    return () => {
      window.clearTimeout(t.current)
      kinds.forEach((k) => window.removeEventListener(k, wake))
    }
  }, [ms])
  return idle
}
