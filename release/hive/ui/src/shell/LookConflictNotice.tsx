import { useState } from 'react'
import { useIsDesktop } from '../lib/hooks'
import { useHive } from '../store/store'
import { BAR } from './layout'
import { chooseMineAgain, dismissConflict, useLook } from './uiVariant'

/**
 * The one quiet notice after a look conflict (r1m): the host held a look this page did not know about, possibly chosen on
 * another device, and the page now shows it. One action, Use mine, makes the person's own choice again, only when they
 * tap it (never automatically). No modal; it sits where the look preview bar sits, in every layout and experience, worn
 * in the experience's own tokens. Gone with the next identity change (shell/uiVariant restartSaveQueue).
 */
export function LookConflictNotice() {
  const look = useLook()
  const client = useHive((s) => s.client)
  const [busy, setBusy] = useState(false)
  const desktop = useIsDesktop()
  const c = look.conflict
  if (!c) return null
  // clear of the HUD and the navigation, and below the preview bar when that is showing too
  const below = look.preview && !look.galleryOpen ? 56 : 0
  const place = desktop ? { top: BAR.hudTop + (look.layout === 'topbar' ? BAR.height + BAR.gap : 0) + below } : { bottom: `calc(var(--sab) + 84px + ${below}px)` }
  return (
    <div
      role="status"
      className="xc-dress xc-frame glass-strong fixed left-1/2 z-[75] flex max-w-[calc(100vw-16px)] -translate-x-1/2 flex-wrap items-center gap-1 rounded-2xl py-1 pr-1 pl-3 text-small"
      style={place}
      data-tour="look-conflict-notice"
    >
      <span className="py-2 pr-2 text-ink-2">
        Your look was changed on another device to <b className="font-semibold text-ink">{c.name}</b>.
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await chooseMineAgain(client)
          } finally {
            setBusy(false)
          }
        }}
        className="min-h-11 rounded-xl border border-control px-3 font-semibold text-ink hover:border-accent"
        data-tour="look-conflict-use-mine"
      >
        Use mine
      </button>
      <button type="button" onClick={dismissConflict} className="min-h-11 rounded-xl px-3 text-ink-3 hover:text-ink" aria-label="Dismiss" data-tour="look-conflict-dismiss">
        Dismiss
      </button>
    </div>
  )
}
