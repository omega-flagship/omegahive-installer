// Purpose: tests for the one sentence that puts a limit's held amount beside its spend, and for the meter's held segment.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Meter } from '../../ui/primitives'
import { spentAndHeld } from './heldWords'

describe('a limit shows what is held beside what is spent', () => {
  it('names the holds only when there are some', () => {
    expect(spentAndHeld(1.98, 0.6)).toBe('$1.98 spent and $0.60 held for calls not yet settled')
    expect(spentAndHeld(1.98, 0)).toBe('$1.98 spent')
    expect(spentAndHeld(1.98)).toBe('$1.98 spent')
    expect(spentAndHeld(1.98, null)).toBe('$1.98 spent')
  })
  it('the meter draws the held part after the spent part, never past the limit', () => {
    const html = (held: number) => renderToStaticMarkup(createElement(Meter, { value: 1, held, max: 2, label: 'Lab spend against its limit' }))
    expect(html(0.5)).toContain('data-meter-held')
    expect(html(0.5)).toMatch(/width:\s*25%/)
    expect(html(5)).toMatch(/width:\s*50%/)
    expect(html(0)).not.toContain('data-meter-held')
  })
})
