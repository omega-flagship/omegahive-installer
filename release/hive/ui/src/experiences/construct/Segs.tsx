import { hsl } from '../sdk'
import type { Seg } from './state'

/** One line of styled terminal output. Segments with a width are padded so columns line up. */
export function Segs({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((s, i) => {
        const room = s.w ? s.w - (s.hue != null ? 2 : 0) : 0
        const text = s.w ? (s.t.length > room ? s.t.slice(0, Math.max(1, room - 1)) + '…' : s.t.padEnd(room)) : s.t
        return (
          <span key={i} className={`cx-c-${s.c ?? 'txt'}`}>
            {s.hue != null && (
              <span aria-hidden style={{ color: hsl(s.hue, 90, 64) }}>
                ■{' '}
              </span>
            )}
            {text}
          </span>
        )
      })}
    </>
  )
}
