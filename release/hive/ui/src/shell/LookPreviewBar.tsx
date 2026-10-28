import { AnimatePresence, m } from 'framer-motion'
import { useState } from 'react'
import { useIsDesktop } from '../lib/hooks'
import { useHive } from '../store/store'
import { BAR } from './layout'
import { barKeep } from './lookActions'
import { DEFAULT_VARIANT, lookName, openGallery, previewLook, resetLook, useLook } from './uiVariant'
import { requestState, undoPreview } from '../features/requestExperience/store'

/** While a look is being previewed (and the gallery, which has the same controls, is closed), a small bar stays on screen in every layout: keep it, undo it, or reset. */
export function LookPreviewBar() {
  const look = useLook()
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const desktop = useIsDesktop()
  // clear of the HUD's stats and of whichever navigation is showing: under the HUD on desktop, above the tab bar on phones
  const place = desktop ? { top: BAR.hudTop + (look.layout === 'topbar' ? BAR.height + BAR.gap : 0) } : { bottom: 'calc(var(--sab) + 84px)' }
  const p = look.preview
  // the experience's name while one is previewed, never its companion look's (small things F1); a look made from the
  // person's words is named as itself (its live status is said by barKeep)
  const fromWords = !!p && requestState().previewing?.prefs === p
  const name = fromWords ? p?.variant?.name ?? lookName(p) : lookName(p)
  return (
    <AnimatePresence>
      {p && !look.galleryOpen && (
        <m.div
          key="look-preview"
          role="status"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className="xc-dress xc-frame glass-strong fixed left-1/2 z-[75] flex whitespace-nowrap max-w-[calc(100vw-16px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-2xl py-1 pr-1 pl-3 text-[13px]"
          style={place}
          data-tour="look-preview-bar"
        >
          <span className="pr-2 whitespace-nowrap text-ink-2">
            Previewing <b className="font-semibold text-ink">{name}</b>
          </span>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                // said only to the person who pressed it (shell/lookActions binds it before its await)
                await barKeep(client, p, name, toast)
              } finally {
                setBusy(false)
              }
            }}
            className="min-h-9 rounded-xl px-3 font-semibold text-[var(--color-primary-ink)]"
            style={{ background: 'linear-gradient(180deg, var(--color-primary-top), var(--color-accent))' }}
          >
            Keep
          </button>
          <button onClick={() => (requestState().previewing?.prefs === p ? undoPreview() : previewLook(null))} className="min-h-9 rounded-xl px-3 text-ink-2 hover:bg-white/[0.06] hover:text-ink">
            Undo
          </button>
          <button onClick={() => openGallery(true)} className="min-h-9 rounded-xl px-3 text-ink-2 hover:bg-white/[0.06] hover:text-ink">
            More looks
          </button>
          <button onClick={() => void resetLook(client)} className="min-h-9 rounded-xl px-3 text-ink-3 hover:bg-white/[0.06] hover:text-ink">
            Reset to {DEFAULT_VARIANT.name}
          </button>
        </m.div>
      )}
    </AnimatePresence>
  )
}
