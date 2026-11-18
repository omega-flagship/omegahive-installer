/**
 * Purpose: what every view's frame shares, whatever drew the view (an HTML document in ViewFrame's LiveView, or a MeTTa
 * view in MettaFrame): inline or full screen in one dialog, and where a view's words for its maker go. The bar above a
 * view, with Full screen and Close, is the first part of views.metta's view-host.
 *
 * The frame lives in a <dialog> from the start: inline it is an open dialog drawn in the page's flow; fullscreen it is
 * the same dialog shown modal, in the browser's top layer, so no transformed ancestor (a sliding panel, an entering row)
 * can trap it, and what is inside is never moved, so the view keeps its state.
 */
import { useLayoutEffect, type RefObject } from 'react'
import type { ArtifactView } from '../../api/moneyWork'
import { cx } from '../../lib/cx'
import { useEscape } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import type { DisplayMode } from './viewBridge'

export type ViewPlace = 'chat' | 'page'

/** Words from a view, for its maker: into that mind's message box, where the person decides whether to send them. */
export function toMaker(place: ViewPlace) {
  return (text: string, view: ArtifactView) => {
    const mind = view.mind_id
    if (!mind) return
    // the draft store is read only when a view asks, so loading this file touches no per-person state
    void import('../../experiences/drafts').then(({ draftWriter }) => {
      draftWriter(`dot:chat:${mind}`)(text)
      if (place === 'page') navigate({ name: 'dot', id: mind, tab: 'chat' })
    })
  }
}

/**
 * Keep the dialog in step with the mode: inline an open dialog in the flow, fullscreen the same dialog shown modal.
 * Escape returns to inline (fullscreen is the top layer of the hive's Escape stack) and leaves the page open. `redraw`
 * names anything that draws a new dialog (unfolding one).
 */
export function useDialogMode(box: RefObject<HTMLDialogElement | null>, mode: DisplayMode, setMode: (m: DisplayMode) => void, redraw?: unknown): void {
  useEscape(() => setMode('inline'), mode === 'fullscreen')
  useLayoutEffect(() => {
    const dialog = box.current
    if (!dialog) return
    const modal = dialog.matches(':modal')
    if (mode === 'fullscreen' && !modal) { if (dialog.open) dialog.close(); dialog.showModal() }
    if (mode === 'inline' && modal) dialog.close()
    // inline opens by its attribute, not show(): show() runs the dialog focusing steps, and a view appearing in a chat
    // would take the focus from the person's message box
    if (!dialog.open) dialog.setAttribute('open', '')
  }, [box, mode, redraw])
}

/** The dialog's own classes, inline in the flow or fullscreen over the page. */
export const dialogClass = (full: boolean) => cx(
  'm-0 max-w-none border-0 p-0 text-ink',
  full ? 'fixed inset-0 h-dvh max-h-none w-dvw bg-[var(--color-void)] backdrop:bg-shade/70' : 'static block h-auto w-full bg-transparent',
)
