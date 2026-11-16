import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApprovalOdds } from './ApprovalsView'

/**
 * uifix-r3.1 (Kimi P3): the approvals "answered before" line says how sure the hive is that this would be approved, and
 * reads correctly for every sureness word ("the hive is doubts it it would be approved" was not English).
 */
const drawn = (html: string) =>
  html
    .replace(/<span class="sr-only">[^<]*<\/span>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

describe('ApprovalOdds', () => {
  it.each([
    [{ f: 0.95, c: 0.9 }, 'near certain'],
    [{ f: 0.85, c: 0.7 }, 'confident'],
    [{ f: 0.7, c: 0.5 }, 'fairly sure'],
    [{ f: 0.1, c: 0.1 }, 'tentative'],
    [{ f: 0.1, c: 0.9 }, 'doubts it'],
  ])('%o → "… The hive: %s"', (tv, word) => {
    const text = drawn(renderToStaticMarkup(createElement(ApprovalOdds, { tv })))
    expect(text).toBe(`· would it be approved? The hive: ${word}`)
    expect(text).not.toMatch(/the hive is|it it/i)
  })
})
