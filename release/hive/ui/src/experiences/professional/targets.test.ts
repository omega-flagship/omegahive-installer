import { describe, expect, it } from 'vitest'

/**
 * Stand-in OMEGATOWN_PROFESSIONAL R1 P2: every actionable Professional target is at least 44×44 px at every breakpoint.
 * Static check of the stylesheet's declarations only: it cannot see clipping, overlap or rendered size, which the
 * Surface browser run measures (elementFromPoint across the 44×44 box at 390 and 1440). No rule that styles a button,
 * link, field, Ask choice or option, at any breakpoint, may set a height under 44px or pull its box out with a
 * negative margin (a clipped card would cut the hit area: stand-in R2 P2).
 */
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
const css = fs.readFileSync(new URL('./styles.css', import.meta.url).pathname, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const ACTIONABLE = /button|\.pr-button|\.pr-link|\.pr-primary|\.pr-row-main|input|textarea|select|\.ask-btn|\.ask-choice|\[role=|\ba\b/

function rules(src: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = []
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selector: m[1].replace(/^[\s\S]*\{/, '').trim(), body: m[2] })
  return out
}

describe('Professional targets are at least 44×44', () => {
  it('no actionable rule, at any breakpoint, sets a height or min-height below 44px', () => {
    const small: string[] = []
    for (const { selector, body } of rules(css)) {
      if (!ACTIONABLE.test(selector) || /\.pr-sr\b/.test(selector)) continue
      for (const m of body.matchAll(/(?<![-\w])(min-height|height)\s*:\s*(\d+(?:\.\d+)?)px/g)) if (Number(m[2]) < 44) small.push(`${selector} { ${m[1]}:${m[2]}px }`)
    }
    expect(small).toEqual([])
  })

  it('no actionable rule uses a negative margin (its hit area would leave a clipping card)', () => {
    const pulled: string[] = []
    for (const { selector, body } of rules(css)) {
      if (!ACTIONABLE.test(selector) || /\.pr-sr\b/.test(selector)) continue
      for (const m of body.matchAll(/(?<![-\w])(margin(?:-block|-inline|-top|-bottom|-left|-right)?)\s*:\s*([^;]+)/g)) if (/(^|\s)-\d/.test(m[2])) pulled.push(`${selector} { ${m[1]}:${m[2].trim()} }`)
    }
    expect(pulled).toEqual([])
  })

  it('the Ask card head is at least as tall as its Conversation target', () => {
    const body = (sel: string) => rules(css).filter((r) => r.selector === sel).map((r) => r.body).join(';')
    expect(body('.pr-ask-layer .pr-card-head')).toMatch(/min-height:44px/)
  })

  it('the base button and link carry both 44px dimensions; the phone nav, topbar, mind controls and Ask toggle are 44px tall', () => {
    const body = (sel: string) => rules(css).filter((r) => r.selector === sel).map((r) => r.body).join(';')
    expect(body('.pr-button')).toMatch(/min-height:44px/)
    expect(body('.pr-button')).toMatch(/min-width:44px/)
    expect(body('.pr-link')).toMatch(/min-height:44px/)
    expect(body('.pr-link')).toMatch(/min-width:44px/)
    expect(body('.pr-sidebar nav button')).toMatch(/min-height:44px/)
    expect(body('.pr-topbar-actions .pr-button')).toMatch(/min-height:44px/)
    expect(body('.pr-mind-control .pr-button')).toMatch(/min-height:44px/)
    expect(body('.pr-ask-layer .pr-card-head .pr-link')).toMatch(/min-height:44px/)
  })
})

describe('r3: the conversation composer at 390 opens clear of the Universal Ask', () => {
  it('.pr-main keeps the Ask’s room as its scroll padding, and an opened conversation brings its composer into view', () => {
    const body = (sel: string) => rules(css).filter((r) => r.selector === sel).map((r) => r.body).join(';')
    expect(body('.pr-main')).toMatch(/scroll-padding-bottom:calc\(var\(--sab,0px\) \+ var\(--ask-room,0px\) \+ 8px\)/)
    const conv = fs.readFileSync(new URL('./Conversation.tsx', import.meta.url).pathname, 'utf8')
    expect(conv).toMatch(/<form ref=\{composer\} className="pr-composer"/)
    expect(conv).toMatch(/useEffect\(\(\) => \{\s*composer\.current\?\.scrollIntoView\?\.\(\{ block: 'nearest' \}\)\s*\}, \[\]\)/)
  })
})
