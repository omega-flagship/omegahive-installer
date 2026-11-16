import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DependencyList, type KeyboardEvent, type TouchEvent, type WheelEvent } from 'react'

/**
 * Chat logs that follow new words only while the reader is at the end (mind-chat r1: "hard to read while the text is
 * moving"). A reader who has scrolled up keeps their place, whatever arrives or streams in below; a "New messages ↓"
 * pill says there is more and takes them to the end. Used by a mind's chat (features/dot/Chat) and the Ask's thread
 * (features/ask/Thread). The decisions are pure and tested (stickToBottom.test.ts); the hook only wires them to a box.
 */

/** How close to the end still counts as "at the end" (px). Small: a reader who scrolls up a line is reading, not following. */
export const AT_END_PX = 24

export interface ScrollBox {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

/** The reader is at the end of the log (within AT_END_PX). */
export const atEnd = (el: ScrollBox, slack = AT_END_PX): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= slack

/**
 * What a change in the log does. At the end: follow it (the view moves with the newest words). Scrolled up: hold the
 * reader's place; when the log grew, mark that there is more below (the pill). Nothing grew: hold.
 */
export function onChange(following: boolean, grew: boolean): 'follow' | 'mark' | 'hold' {
  if (following) return 'follow'
  return grew ? 'mark' : 'hold'
}

/** A reader's own gesture toward earlier rows: the log stops following at once, before any scroll event settles it. */
export function readsUp(e: { kind: 'wheel'; deltaY: number } | { kind: 'key'; key: string } | { kind: 'touch'; dy: number }): boolean {
  if (e.kind === 'wheel') return e.deltaY < 0
  if (e.kind === 'touch') return e.dy > 0 // the finger moves down: the content scrolls toward earlier rows
  return e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home'
}

/**
 * The hook: `box` is the scrolling element, `content` its one inner element (both observed for size, so streamed words
 * and a box that shrinks are seen); `deps` are what the caller knows changed (rows, pending, a typing line).
 */
export function useStickToBottom<B extends HTMLElement = HTMLDivElement, C extends HTMLElement = HTMLDivElement>(deps: DependencyList) {
  const box = useRef<B>(null)
  const content = useRef<C>(null)
  const following = useRef(true)
  const height = useRef(0)
  const touchY = useRef<number | null>(null)
  const [unseen, setUnseen] = useState(false)

  const check = useCallback(() => {
    const el = box.current
    if (!el) return
    const h = el.scrollHeight
    const grew = h > height.current
    height.current = h
    const d = onChange(following.current, grew)
    if (d === 'follow') {
      if (!atEnd(el, 0)) el.scrollTop = el.scrollHeight
    } else if (d === 'mark') setUnseen(true)
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(check, deps)

  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => check())
    ro.observe(el)
    if (content.current) ro.observe(content.current)
    return () => ro.disconnect()
  }, [check])

  const toEnd = useCallback(() => {
    const el = box.current
    following.current = true
    setUnseen(false)
    if (el) {
      el.scrollTop = el.scrollHeight
      height.current = el.scrollHeight
    }
  }, [])

  const stopFollowing = () => {
    following.current = false
  }

  const handlers = {
    onScroll: () => {
      const el = box.current
      if (!el) return
      following.current = atEnd(el)
      if (following.current) setUnseen(false)
    },
    onWheel: (e: WheelEvent) => {
      if (readsUp({ kind: 'wheel', deltaY: e.deltaY })) stopFollowing()
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (readsUp({ kind: 'key', key: e.key })) stopFollowing()
    },
    onTouchStart: (e: TouchEvent) => {
      touchY.current = e.touches[0]?.clientY ?? null
    },
    onTouchMove: (e: TouchEvent) => {
      const y = e.touches[0]?.clientY
      if (touchY.current !== null && y !== undefined && readsUp({ kind: 'touch', dy: y - touchY.current })) stopFollowing()
    },
  }

  return { box, content, handlers, unseen, toEnd, following: () => following.current }
}
