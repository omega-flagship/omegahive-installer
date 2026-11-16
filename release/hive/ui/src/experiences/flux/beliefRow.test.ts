import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Belief } from '../sdk'
import { BeliefRow } from './panels'

/**
 * followups-r9 item 3 (Kimi r3.6 #3): a Flux belief row carries sureness evidence (the meter and its words), so it is
 * rendered at full opacity from its first frame: no fade-in that would show the evidence dimmed. Reduced motion: no
 * arrival motion at all. INVENTED belief only.
 */
const belief = { statement: 'invented-sky-is-teal', tv: { strength: 0.8, confidence: 0.6 }, updated_at: '2026-10-19T00:00:00Z' } as unknown as Belief
const render = (i: number, reduced: boolean) => renderToStaticMarkup(createElement('ul', null, createElement(BeliefRow, { b: belief, i, reduced })))
const rowStyle = (html: string) => html.match(/<li\b[^>]*style="([^"]*)"/)?.[1] ?? ''
const opacities = (style: string) => [...style.matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1]))

describe('a Flux belief row, as first rendered', () => {
  for (const reduced of [false, true]) {
    it(`never starts below full opacity (reduced motion ${reduced ? 'on' : 'off'})`, () => {
      for (const i of [0, 5, 20]) {
        const html = render(i, reduced)
        expect(html).toContain('data-flux-belief')
        const style = rowStyle(html)
        for (const o of opacities(style)) expect(o).toBeGreaterThanOrEqual(1)
        // nothing inside the row (the meter, the words) is dimmed on arrival either
        expect(html).not.toMatch(/opacity:\s*0(\.\d+)?(;|")/)
      }
    })
  }

  it('reduced motion: the row is rendered in place; otherwise only a slide (a non-semantic cue)', () => {
    expect(rowStyle(render(3, true))).not.toMatch(/translate/)
    expect(rowStyle(render(3, false))).toMatch(/translateY\(8px\)/)
  })
})
