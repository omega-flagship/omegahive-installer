// Purpose: the Ω menu draws an entry marked beside (an app's Leave, composed in program.metta) as a visible button next
// to the Ω mark, in the one row other layers keep clear of, ending a long name in an ellipsis, which runs that entry, and
// draws nothing beside the mark when no entry is marked.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OmegaMenu, type OmegaSection } from './OmegaMenu'

const draw = (sections: OmegaSection[]) => renderToStaticMarkup(createElement(OmegaMenu, { heading: 'Create · Home', context: 'classic', sections }))
const besides = (html: string) => [...html.matchAll(/<button[^>]*data-omega-beside=""[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])

describe('the Ω mark says the way out of an app', () => {
  it('draws an entry marked beside as a visible button next to the mark, and only that entry', () => {
    const html = draw([{ items: [{ label: 'Leave Create', run: () => undefined, beside: true }, { label: 'Code', run: () => undefined }] }])
    expect(besides(html)).toEqual(['Leave Create'])
    expect(html.indexOf('data-omega-button')).toBeLessThan(html.indexOf('data-omega-beside'))   // after the mark, in its row
  })
  it('draws nothing beside the mark where no entry is marked (every look and page but an app)', () => {
    expect(besides(draw([{ items: [{ label: 'Back to Apps', run: () => undefined }] }]))).toEqual([])
    expect(besides(draw([]))).toEqual([])
  })
  it('holds the mark and the entry beside it in one row, which ends a long app name in an ellipsis and keeps it whole in the title', () => {
    const label = 'Leave Tip calculator with quick tip buttons and bill splitting'
    const html = draw([{ items: [{ label, run: () => undefined, beside: true }] }])
    // the row every layer keeping clear of Ω measures holds the mark, then Leave
    expect(html.indexOf('data-omega-row')).toBeGreaterThan(-1)
    expect(html.indexOf('data-omega-row')).toBeLessThan(html.indexOf('data-omega-button'))
    expect(html.indexOf('data-omega-button')).toBeLessThan(html.indexOf('data-omega-beside'))
    const beside = html.match(/<button[^>]*data-omega-beside=""[^>]*>/)?.[0] ?? ''
    expect(beside).toContain(`title="${label}"`)
    expect(beside).toMatch(/class="[^"]*\bmax-w-\[min\(320px,calc\(100vw-224px\)\)\][^"]*\btruncate\b/)
    expect(besides(html)).toEqual([label])
  })
})
