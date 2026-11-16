import { navigate, parse, type Route } from '../lib/router'

/** The latest goTo: an earlier one still looking for its place stops when a newer one starts. */
let generation = 0

/**
 * Go to a page and, when a place inside it is named (a heading's selector), bring that part into view and move focus
 * there once the page has drawn it. Used by the nav menu's "Go to" places and their palette entries. The look stops
 * once the person is no longer on that page (or another goTo started), so a selector that happens to exist on the
 * next page is never focused there.
 */
export function goTo(route: Route, reveal?: string): void {
  navigate(route)
  if (!reveal) return
  const mine = ++generation
  let tries = 0
  const look = () => {
    if (mine !== generation || parse(window.location.hash).name !== route.name) return
    const el = document.querySelector<HTMLElement>(reveal)
    if (el) {
      el.scrollIntoView({ block: 'center' })
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
      el.focus({ preventScroll: true })
    } else if (tries++ < 20) setTimeout(look, 150)
  }
  setTimeout(look, 150)
}
