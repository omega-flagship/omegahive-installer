import { useLayoutEffect, useRef } from 'react'
import { useReducedMotion } from '../sdk'

/**
 * Text that arrives scrambled and resolves left to right. One shared rAF ticker drives every instance and writes
 * straight to the DOM (no React renders per frame); the browser pauses it with the tab.
 */
const SCRAMBLE = '!<>-_\\/[]{}=+*^?#01ｱｶｻﾀﾅ'
const ASCII = '!<>-_\\/[]{}=+*^?#0123456789abcdefxz'
const subs = new Set<(now: number) => boolean>()
let raf = 0
const loop = (now: number) => {
  for (const f of subs) if (!f(now)) subs.delete(f)
  raf = subs.size ? requestAnimationFrame(loop) : 0
}
const add = (f: (now: number) => boolean) => {
  subs.add(f)
  if (!raf) raf = requestAnimationFrame(loop)
}

export function Decode({ text, animate = true, delay = 0, className }: { text: string; animate?: boolean; delay?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!animate || reduced || !text) {
      el.textContent = text
      return
    }
    const n = text.length
    const t0 = performance.now() + delay
    const dur = Math.min(1100, 260 + n * 9)
    let last = 0
    let live = true
    // wide (katakana) glyphs would reflow mono text; only use them where the source is already wide
    const pick = (ch: string) => {
      const set = ch.charCodeAt(0) > 0x2e80 ? SCRAMBLE : ASCII
      return set[(Math.random() * set.length) | 0]
    }
    const paint = (now: number) => {
      const p = (now - t0) / dur
      const lock = Math.max(0, Math.floor(p * n))
      let s = text.slice(0, lock)
      const edge = Math.min(n, lock + 18)
      for (let i = lock; i < edge; i++) {
        const ch = text[i]
        s += ch === ' ' || ch === '\n' ? ch : pick(ch)
      }
      el.textContent = s
    }
    paint(t0)
    add((now) => {
      if (!live) return false
      if (now - t0 >= dur) {
        el.textContent = text
        return false
      }
      if (now - last < 32) return true
      last = now
      paint(now)
      return true
    })
    return () => {
      live = false
      el.textContent = text
    }
  }, [text, animate, reduced, delay])
  return <span ref={ref} className={className} />
}
