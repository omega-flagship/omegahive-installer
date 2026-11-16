import { describe, expect, it } from 'vitest'
import { askUnderModal } from '../features/ask/placement'
import askHostSource from '../features/ask/AskHost.tsx?raw'

/** Kimi K3 follow-up (9593fd1) P2-5: the Ask dims exactly while a layer makes it unusable, and stays so through a nav menu. */
const doc = (modal: boolean) => ({ querySelector: (s: string) => (modal && s === '[aria-modal="true"]:not([data-ask-own])' ? ({} as Element) : null) })
const ask = (inert: boolean) => ({ closest: (s: string) => (inert && s === '[inert]' ? ({} as Element) : null) })

describe('P2-5: a nav menu over the More sheet (or the rail) never flips the Ask to live', () => {
  it('the More sheet open (aria-modal): under', () => {
    expect(askUnderModal(doc(true), ask(true))).toBe(true)
  })
  it('a nav menu opened inside the sheet: still under (no toggle on open or close)', () => {
    // sheet still aria-modal, Ask inert under the menu's containment
    expect(askUnderModal(doc(true), ask(true))).toBe(true)
  })
  it('a nav menu over the rail (no aria-modal, but its containment made the Ask inert): under', () => {
    expect(askUnderModal(doc(false), ask(true))).toBe(true)
  })
  it('nothing open: live', () => {
    expect(askUnderModal(doc(false), ask(false))).toBe(false)
    expect(askUnderModal(doc(false), null)).toBe(false)
  })
  it('AskHost decides it with askUnderModal on its own root', () => {
    expect(askHostSource).toContain("askUnderModal(document, document.getElementById('ask'))")
  })
})
