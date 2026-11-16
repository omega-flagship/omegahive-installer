import { describe, expect, it } from 'vitest'
import { ownsShortcut, OWNS_SHORTCUT } from '../../lib/shortcutOwner'
import { askSummons } from './summon'

/** A fake element: `owner` is the data-owns-shortcut value of its nearest marked ancestor (or none). */
const el = (owner: string | null, tag = 'DIV') => ({
  tagName: tag,
  isContentEditable: false,
  closest: (sel: string) => (sel === `[${OWNS_SHORTCUT}]` && owner !== null ? { getAttribute: (a: string) => (a === OWNS_SHORTCUT ? owner : null) } : null),
})
const key = (k: string, target: unknown, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean } = { meta: true }) => ({ key: k, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, target })

describe('a region can own a shortcut; the Ask yields there and summons everywhere else (Kimi FIX-FIRST 1)', () => {
  it('reads the owner marker on the nearest marked ancestor, by exact combo', () => {
    expect(ownsShortcut(el('mod+k mod+e'), 'mod+k')).toBe(true)
    expect(ownsShortcut(el('mod+e'), 'mod+k')).toBe(false)
    expect(ownsShortcut(el('mod+kk'), 'mod+k')).toBe(false)
    expect(ownsShortcut(el(null), 'mod+k')).toBe(false)
    expect(ownsShortcut(null, 'mod+k')).toBe(false)
    expect(ownsShortcut({}, 'mod+k')).toBe(false)
  })
  it('the platform’s mod+K inside the code canvas is the canvas’s (Change…), not the Ask’s', () => {
    expect(askSummons(key('k', el('mod+k')), true)).toBe(false) // ⌘K on a Mac
    expect(askSummons(key('K', el('mod+k'), { ctrl: true }), false)).toBe(false) // Ctrl+K elsewhere
  })
  it('the other modifier is not mod+K: on a Mac, Ctrl+K in the code still summons the Ask (the editor keeps it as delete-to-line-end otherwise)', () => {
    expect(askSummons(key('k', el('mod+k'), { ctrl: true }), true)).toBe(true)
    expect(askSummons(key('k', el('mod+k')), false)).toBe(true)
  })
  it('⌘K / Ctrl+K anywhere else still summons the Ask', () => {
    for (const mac of [true, false]) {
      expect(askSummons(key('k', el(null)), mac)).toBe(true)
      expect(askSummons(key('k', el(null), { ctrl: true }), mac)).toBe(true)
      expect(askSummons(key('k', el('mod+e')), mac)).toBe(true)
    }
  })
  it('`/` summons outside typing, never while typing; plain k never does', () => {
    expect(askSummons(key('/', el(null), {}))).toBe(true)
    expect(askSummons(key('/', el('mod+k'), {}))).toBe(true)
    expect(askSummons(key('/', el(null, 'INPUT'), {}))).toBe(false)
    expect(askSummons(key('k', el(null), {}))).toBe(false)
  })
})
