/**
 * A shared Page may replace the fixed fallback only with a committed row.
 * Page waits for entrance completion and relinquishes its lease at exit start.
 * Per-body/per-row leases survive overlapping commits and StrictMode cleanups.
 * Registration proves ownership, not CSS visibility or pointer geometry.
 */
const pages = new WeakMap<HTMLElement, Map<HTMLElement, number>>()

export function acquirePageInlineBar(body: HTMLElement, row: HTMLElement): (() => void) | undefined {
  if (body.ownerDocument.body !== body || row.ownerDocument !== body.ownerDocument ||
      !body.contains(row) || !row.hasAttribute('data-studio-bar') ||
      !row.hasAttribute('data-inline') || !row.hasAttribute('data-inline-ready') ||
      row.hasAttribute('inert') || row.getAttribute('aria-hidden') === 'true' ||
      row.getAttribute('data-inline-owner') !== 'page') return
  let owners = pages.get(body)
  if (!owners) {
    owners = new Map()
    pages.set(body, owners)
  }
  owners.set(row, (owners.get(row) ?? 0) + 1)
  // The row is marked before CSS is allowed to hide the global fallback.
  row.setAttribute('data-page-inline-registered', '')
  body.setAttribute('data-page-inline-bar', '')
  let released = false
  return () => {
    if (released) return
    released = true
    const current = pages.get(body)
    if (!current) return
    const count = current.get(row) ?? 0
    if (count > 1) current.set(row, count - 1)
    else {
      current.delete(row)
      row.removeAttribute('data-page-inline-registered')
    }
    if (current.size === 0) {
      pages.delete(body)
      body.removeAttribute('data-page-inline-bar')
    }
  }
}
