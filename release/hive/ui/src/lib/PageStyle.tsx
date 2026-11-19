// Purpose: draws a look's own stylesheet as a <style> element the page's CSP admits. The hive serves every page with
// style-src 'self' 'nonce-…' (hive/core/app.py page_csp), so the browser drops a <style> element without that nonce whole
// and none of its rules apply. This one carries the nonce the page was served with, as vite's own injected styles do.
import { memo } from 'react'
import { pageNonce } from './appFrame'

/**
 * A stylesheet drawn in place, such as Canvas's board styles. Where the page has no nonce (the dev server, the demo, a
 * test) there is no page policy to pass, and the element goes without one. The page's nonce stays the same while the
 * page lives and the CSS is a module constant, so memo keeps the look's re-renders from redrawing it.
 */
export const PageStyle = memo(function PageStyle({ css }: { css: string }) {
  return <style nonce={pageNonce() ?? undefined}>{css}</style>
})
