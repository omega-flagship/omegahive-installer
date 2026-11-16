import { describe, expect, it } from 'vitest'

const fsName = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }

/**
 * j0-fixes r1 item 7 (J0 live, Professional): Studio's empty-state heading inherited the chrome's dark ink onto the
 * canvas's dark backdrop. The words drawn straight on the backdrop now use the canvas's OWN ink pair (--dc-ink /
 * --dc-ink-2 against --dc-surface), whatever the experience; this holds them to at least 4.5:1. The render smoke
 * measures the computed colours under Professional and Classic as well.
 */
const css = readFileSync(decodeURIComponent(new URL('./designCanvas.css', import.meta.url).pathname), 'utf8')
const token = (name: string) => {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)
  expect(m, name).not.toBeNull()
  return m![1]
}
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const rule = (sel: string) => new RegExp(`(^|\\n)${sel.replace(/[.[\]()*+?^$|\\]/g, '\\$&').replace(/ /g, '\\s+')}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? ''

describe('the empty state reads in every experience', () => {
  it('the canvas’s own ink pair is at least 4.5:1 on its surface', () => {
    expect(ratio(token('--dc-ink'), token('--dc-surface'))).toBeGreaterThanOrEqual(4.5)
    expect(ratio(token('--dc-ink-2'), token('--dc-surface'))).toBeGreaterThanOrEqual(4.5)
  })
  it('the heading, the line under it, and the recent links take the canvas’s ink, never the chrome’s', () => {
    expect(rule('.dc-empty-title')).toMatch(/color:\s*var\(--dc-ink\)/)
    expect(rule('.dc-empty-body')).toMatch(/color:\s*var\(--dc-ink-2\)/)
    expect(rule('.dc-empty .dc-quiet')).toMatch(/color:\s*var\(--dc-ink-2\)/)
    expect(rule('.dc-recent-btn')).toMatch(/color:\s*var\(--dc-ink\)/)
  })
  it('inside an experience the ink and the surface come from the same chrome, as a pair (never one without the other)', () => {
    const dress = rule('html[data-xc-active] .xc-dress .dc')
    expect(dress).toMatch(/--dc-surface:\s*var\(--xc-surface\)/)
    expect(dress).toMatch(/--dc-ink:\s*var\(--xc-ink\)/)
    expect(dress).toMatch(/--dc-ink-2:\s*var\(--xc-ink-2\)/)
    expect(dress).toMatch(/background-color:\s*var\(--dc-surface\)/)
  })
})
