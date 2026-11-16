import { useSyncExternalStore } from 'react'
import { NATIVE_GRAMMARS, type FormId, type Grammar } from './contract'

/**
 * An app form opened in an experience it has no rendering of its own for renders its classic layout dressed in that
 * experience's chrome: the same tokens every shared window wears (experiences/chrome.ts, written on <html> as --xc-*
 * by applyChrome; lib/appBridge ChromeTokens hands the same set to framed apps). Its surfaces, ink, accent, corners and
 * type are then the experience's, never the classic room's (consistency audit 2026-10-07: Commons and Evolve stayed
 * navy/lavender and green/lime in Cosmos, Construct and Flux; the case file stayed dark inside light Canvas).
 *
 * Content keeps its own colours (data, charts, artwork). The form's semantic tones (for, against, warning, ok) come
 * from its own measured sets: the classic set on a dark chrome, the paper set on a light one (contrast.test.ts).
 */

/** The chrome tokens as CSS values (resolved by the browser from <html>). */
export const XC = {
  surface: 'var(--xc-surface)',
  raised: 'var(--xc-raised)',
  ink: 'var(--xc-ink)',
  ink2: 'var(--xc-ink-2)',
  ink3: 'var(--xc-ink-3)',
  line: 'var(--xc-line)',
  edge: 'var(--xc-edge)',
  accent: 'var(--xc-accent)',
  onAccent: 'var(--xc-on-accent)',
  danger: 'var(--xc-danger)',
  font: 'var(--xc-font)',
  display: 'var(--xc-display)',
  radius: 'var(--xc-radius)',
  controlRadius: 'var(--xc-control-radius)',
} as const

/** A second raised tone (hover, selected rows): the raised surface with a little of the ink. */
export const XC_RAISED_2 = 'color-mix(in srgb, var(--xc-ink) 7%, var(--xc-raised))'

/**
 * Whether a form opened in `host` wears the chrome: the person is in an experience (not classic) and the form has no
 * rendering of its own for it.
 */
export function dressedIn(form: FormId, host: Grammar | null | undefined): boolean {
  return !!host && host !== 'classic' && !NATIVE_GRAMMARS[form].includes(host)
}

/** The `data-xc-scheme` the experience chrome writes on <html> (Canvas has a dark board), kept current. */
export function useXcScheme(): 'light' | 'dark' {
  return useSyncExternalStore(
    (cb) => {
      if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => undefined
      const mo = new MutationObserver(cb)
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-xc-scheme'] })
      return () => mo.disconnect()
    },
    () => (document.documentElement.dataset.xcScheme === 'dark' ? 'dark' : 'light'),
    () => 'light',
  )
}
