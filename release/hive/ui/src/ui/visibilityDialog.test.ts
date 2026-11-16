import { describe, expect, it } from 'vitest'

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

/**
 * The Public or Private picker is drawn on the page (a portal), so it is not next to its button in the focus order. It
 * is a modal dialog through the shared containment (ui/useModalContainment): focus moves into it when it opens, Tab
 * stays inside, the page under it is inert, Escape closes it and focus goes back to its button. Walked in a browser on
 * modal-harness.html; this pins the wiring.
 */
describe('the Public or Private picker is a contained dialog', () => {
  const src = fs.readFileSync(new URL('./Visibility.tsx', import.meta.url), 'utf8')

  it('uses the shared containment, returning focus to its button, and Escape closes it', () => {
    expect(src).toMatch(/useModalContainment\(boxRef, \{ restoreFocus: \(\) => anchor\.current\?\.querySelector<HTMLElement>\('button'\)/)
    expect(src).toMatch(/useEscape\(onClose\)/)
    expect(src).toMatch(/role="dialog" aria-modal="true"/)
  })

  it('waits for its place without visibility:hidden, which would refuse the focus moved into it', () => {
    expect(src).toMatch(/style=\{place \?\? \{ top: 0, left: 0, opacity: 0 \}\}/)
    expect(src).not.toMatch(/visibility: 'hidden'/)
  })

  it('is on the harness page, so it can be walked with the other dialogs', () => {
    const harness = fs.readFileSync(new URL('./modal-harness-main.tsx', import.meta.url), 'utf8')
    expect(harness).toMatch(/<VisibilityControl kind="agent"/)
  })
})
