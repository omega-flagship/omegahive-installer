import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { experienceNoticeTop, noticeOverlap, noticeRowTop, type Box } from '../lib/frameFit'
import { NOTICE_ROW, reservesNoticeRow } from './experienceStage'
import { PhoneNoticeRow } from '../experiences/construct'

/**
 * followups-r9 item 2 (Design's saved render review of 0ab70940): on a phone, Construct's approval notice covered
 * console lines. The phone deck now reserves a row of its own for the notice; the host puts the pill in that row, and
 * the console is laid out after it, so no line is under the notice. Without a row the placement is unchanged.
 */
const phone = { width: 390, height: 844 }
const insets = { top: 47, right: 0, bottom: 34, left: 0 }
const pill = { width: 366, height: 44 }
const pager: Box = { left: 6, top: 97, right: 384, bottom: 141 }
// the row sits right after the pager (deck gap 6px); the console is laid out after the row
const row: Box = { left: 6, top: 147, right: 384, bottom: 191 }
const consoleBox: Box = { left: 6, top: 197, right: 384, bottom: 700 }
const consoleKeys: Box[] = [{ left: 300, top: 197, right: 384, bottom: 227 }]

describe('the reserved notice row on the experience stage', () => {
  it('a visible row: the pill sits in it, and covers none of the console laid out after it', () => {
    const top = noticeRowTop(phone, insets, row, pill)
    expect(top).toBe(147)
    expect(noticeOverlap(phone, top!, pill, [consoleBox], 0)).toBe(0)
    expect(noticeOverlap(phone, top!, pill, [pager], 0)).toBe(0)
  })

  it('no row (or an empty one): no row placement, the pill goes where it always went', () => {
    expect(noticeRowTop(phone, insets, null, pill)).toBeNull()
    expect(noticeRowTop(phone, insets, { ...row, bottom: row.top }, pill)).toBeNull()
    // and that placement, among console lines, is exactly what the row is for
    const before = experienceNoticeTop(phone, insets, [pager], pill, undefined, consoleKeys)
    expect(noticeOverlap(phone, before, pill, [consoleBox], 0)).toBeGreaterThan(0)
  })

  it('a row is kept between the device insets', () => {
    expect(noticeRowTop(phone, insets, { ...row, top: 10, bottom: 54 }, pill)).toBe(47)
    expect(noticeRowTop(phone, insets, { ...row, top: 830, bottom: 874 }, pill)).toBe(844 - 34 - 44)
  })

  it('the row opens only while a notice shows on the experience stage', () => {
    expect(reservesNoticeRow(1, { mode: 'experience', top: 147 })).toBe(true)
    expect(reservesNoticeRow(3, { mode: 'experience', top: 147 })).toBe(true)
    expect(reservesNoticeRow(0, { mode: 'experience', top: 147 })).toBe(false)
    expect(reservesNoticeRow(1, null)).toBe(false)
    expect(reservesNoticeRow(1, { mode: 'full', top: 8 })).toBe(false)
    expect(reservesNoticeRow(1, { mode: 'framed', lane: null })).toBe(false)
  })

  it("Construct's phone row carries the marker the host looks for, and nothing a reader or a keyboard meets", () => {
    const html = renderToStaticMarkup(createElement(PhoneNoticeRow))
    expect(html).toContain(`${NOTICE_ROW}=""`)
    expect(html).toContain('cx-notice-row')
    expect(html.replace(/<[^>]+>/g, '')).toBe('')
    expect(html).not.toMatch(/tabindex|<button|<a\b/)
  })
})
