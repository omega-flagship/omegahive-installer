import { describe, expect, it } from 'vitest'
import { AT_END_PX, atEnd, onChange, readsUp } from './stickToBottom'
import chatSource from '../features/dot/Chat.tsx?raw'
import threadSource from '../features/ask/Thread.tsx?raw'

// mind-chat r1 item 2: "hard to read while the text is moving". A log follows new and streamed words only while the
// reader is at the end; scrolled up, their place holds and "New messages ↓" says there is more.
describe('chat logs follow only a reader who is at the end', () => {
  it('at the end means within a few pixels of it, not a screenful', () => {
    expect(atEnd({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })).toBe(true)
    expect(atEnd({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 - AT_END_PX })).toBe(true)
    // the old mind chat counted 80 px from the end as "at the end": a reader one line up was pulled back down
    expect(atEnd({ scrollHeight: 1000, clientHeight: 400, scrollTop: 540 })).toBe(false)
    expect(AT_END_PX).toBeLessThanOrEqual(24)
  })
  it('a reader at the end follows new words; a reader who scrolled up keeps their place and is told there is more', () => {
    expect(onChange(true, true)).toBe('follow')
    expect(onChange(true, false)).toBe('follow')
    expect(onChange(false, true)).toBe('mark')
    expect(onChange(false, false)).toBe('hold')
  })
  it('the reader\'s own gesture upward stops following at once (a small trackpad scroll is reading, too)', () => {
    expect(readsUp({ kind: 'wheel', deltaY: -3 })).toBe(true)
    expect(readsUp({ kind: 'wheel', deltaY: 3 })).toBe(false)
    expect(readsUp({ kind: 'touch', dy: 12 })).toBe(true)
    expect(readsUp({ kind: 'touch', dy: -12 })).toBe(false)
    for (const key of ['ArrowUp', 'PageUp', 'Home']) expect(readsUp({ kind: 'key', key })).toBe(true)
    for (const key of ['ArrowDown', 'End', 'a']) expect(readsUp({ kind: 'key', key })).toBe(false)
  })
  it('the mind chat and the Ask thread both use it, with the pill, and no longer keep their own follow rule', () => {
    for (const src of [chatSource, threadSource]) {
      expect(src).toContain('useStickToBottom(')
      expect(src).toContain('<NewBelow show={logUnseen} onClick={logToEnd}')
      expect(src).toContain('ref={logContent}')
      expect(src).not.toMatch(/scrollHeight - el\.scrollTop - el\.clientHeight < (80|40)/)
    }
    // sending is the person going to the end: their own message is always in view
    expect(chatSource).toMatch(/setText\(''\)\s+logToEnd\(\)/)
  })
})
