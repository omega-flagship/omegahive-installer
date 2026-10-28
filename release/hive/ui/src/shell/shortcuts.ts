import { useEffect } from 'react'
import { isTypingTarget } from '../lib/hooks'
import { ownedHere } from '../lib/shortcutOwner'
import { navigate } from '../lib/router'
import { goKey } from './navItems'
import { useAdminView } from '../lib/useAdmin'
import { useHive } from '../store/store'
import { useIntro } from '../tour/introStore'

/**
 * The palette's ⌘K / Ctrl+K (useShortcuts binds exactly this): toggles the palette, except inside a region that owns
 * mod+K (the Code canvas: Change…), where it does nothing. Returns whether it took the key.
 */
export function handlePaletteKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; target: unknown; preventDefault(): void }, toggle: () => void, mac?: boolean): boolean {
  if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) return false
  if (ownedHere(e, 'mod+k', mac)) return false
  e.preventDefault()
  toggle()
  return true
}

/** Global keyboard shortcuts: ⌘K / Ctrl+K, `g` + a destination key (see navItems), n, /, ? (help). Esc is handled by the escape stack. */
export function useShortcuts(): void {
  // `g` keys reach what this person's navigation reaches (members: no admin-only pages; lib/useAdmin adminViewOf)
  const { adminView } = useAdminView()
  useEffect(() => {
    let g = 0
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (handlePaletteKey(e, () => {
        const s = useHive.getState()
        s.setPalette(!s.paletteOpen)
      })) return
      if ((e.metaKey || e.ctrlKey) && k === 'k') return
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      if (useHive.getState().paletteOpen) return
      if (e.key === '?') {
        e.preventDefault()
        const intro = useIntro.getState()
        if (!intro.tour && !intro.welcome) intro.setHelp(!intro.help)
        return
      }
      const now = performance.now()
      if (g && now - g < 1200) {
        g = 0
        const to = goKey(k, adminView)
        if (!to) return
        e.preventDefault()
        if ('go' in to) navigate(to.go)
        else useHive.getState().toast({ tone: 'info', title: `${to.adminOnly.label} is for this hive’s admins`, body: 'Your navigation shows every page you can use.' })
        return
      }
      if (k === 'g') {
        g = now
        return
      }
      if (k === 'n') {
        e.preventDefault()
        navigate({ name: 'new' })
      } else if (k === '/') {
        e.preventDefault()
        useHive.getState().setPalette(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [adminView])
}
