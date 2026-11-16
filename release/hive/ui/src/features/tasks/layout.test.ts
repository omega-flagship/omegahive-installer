import { describe, expect, it } from 'vitest'
import { TASKS_BOARD, TASKS_PAGE_BODY } from './layout'

/** Demo audit P1 #5: on a phone the Tasks board was a 60 px strip under the filters and the add-task form. */
const unprefixed = (classes: string) => classes.split(/\s+/).filter((c) => !c.includes(':'))

describe('the Tasks page on a phone', () => {
  it('does not pin the page body to one screen (only from md up)', () => {
    expect(unprefixed(TASKS_PAGE_BODY)).not.toContain('h-full')
    expect(TASKS_PAGE_BODY).toContain('md:h-full')
  })
  it('gives the board most of a screen and never lets it shrink to what is left over', () => {
    expect(unprefixed(TASKS_BOARD)).toContain('min-h-[60vh]')
    expect(unprefixed(TASKS_BOARD)).not.toContain('flex-1')
    expect(unprefixed(TASKS_BOARD)).not.toContain('min-h-0')
    expect(TASKS_BOARD).toContain('md:flex-1')
  })
})
