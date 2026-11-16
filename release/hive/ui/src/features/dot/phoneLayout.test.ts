import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { DOT_PHONE_PEEK, DOT_PHONE_PEEK_GAP_PX } from './phoneLayout'
import { VisibilityControl } from '../../ui/Visibility'

/** Demo audit P1 #6: on a phone a mind's chat was one or two lines under its header. */
describe('a mind on a phone', () => {
  it('opens its sheet tall: on a 390x844 phone it leaves the chat most of the screen (was 66dvh, 557 px)', () => {
    const h = 844 - DOT_PHONE_PEEK_GAP_PX
    expect(DOT_PHONE_PEEK).toBe(`calc(100dvh - ${DOT_PHONE_PEEK_GAP_PX}px - var(--sat))`)
    expect(h).toBeGreaterThanOrEqual(0.8 * 844)
    expect(h).toBeLessThan(844 - 48)   // the top of the hive stays in view (the full snap is 100dvh - 48px)
  })
  it('who can see it folds into the controls row as an icon that keeps its name for assistive tech', () => {
    const html = renderToStaticMarkup(createElement(VisibilityControl, { kind: 'agent', id: 'a_x', value: { visibility: 'public', shared_with: [] }, iconOnly: true }))
    expect(html).toContain('aria-label="Who can see this: public"')
    expect(html.replace(/<[^>]+>/g, '').trim()).toBe('')
    const full = renderToStaticMarkup(createElement(VisibilityControl, { kind: 'agent', id: 'a_x', value: { visibility: 'public', shared_with: [] } }))
    expect(full.replace(/<[^>]+>/g, '').trim()).toBe('public')
  })
})
