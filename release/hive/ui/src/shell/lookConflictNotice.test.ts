import { describe, expect, it } from 'vitest'
import source from './LookConflictNotice.tsx?raw'
import app from '../App.tsx?raw'

/** r1m: the one quiet conflict notice: mounted once, worn in the experience's tokens, 44 px controls, never a modal. */
describe('the look-conflict notice', () => {
  it('says what happened, with one action (Use mine) and Dismiss, both 44 px', () => {
    expect(source).toContain('Your look was changed on another device to')
    expect(source).toContain('Use mine')
    const buttons = source.split('<button').slice(1)
    expect(buttons).toHaveLength(2)
    for (const b of buttons) expect(b).toMatch(/\bmin-h-11\b/)
  })
  it('is a status, not a modal; tokens only; no motion of its own', () => {
    expect(source).toMatch(/role="status"/)
    expect(source).not.toMatch(/aria-modal|role="dialog"|role="alertdialog"/)
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|bg-white|bg-black|text-white|text-black/i)
    expect(source).not.toMatch(/framer-motion|animate-/)
    expect(source).toMatch(/xc-dress/)
  })
  it('acts only on a tap: Use mine is the only caller of chooseMineAgain', () => {
    expect(source.match(/chooseMineAgain\(/g)).toHaveLength(1)
    expect(source).toMatch(/onClick=\{async \(\) => \{[\s\S]*chooseMineAgain\(client\)/)
  })
  it('is mounted once, beside the look preview bar', () => {
    expect(app.match(/<LookConflictNotice \/>/g)).toHaveLength(1)
  })
})
