import { memo } from 'react'
import { cx } from '../lib/cx'

type Tok = { t: 'paren' | 'copula' | 'var' | 'num' | 'str' | 'head' | 'sym' | 'ws'; v: string; depth?: number }

const COPULAS = ['-->', '==>', '<->', '<=>', '=/>', '=\\>', '=|>', '{--', '--]', '{-]', '&&', '||', '×', '--', '&/', '&|']
const SINGLE_OPS = new Set(['&', '|', '*', '~', '=', ':', '-', '\\', '/'])

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  let depth = 0
  let afterOpen = false
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      let j = i
      while (j < src.length && /\s/.test(src[j])) j++
      out.push({ t: 'ws', v: src.slice(i, j) })
      i = j
      continue
    }
    if (ch === '(' || ch === ')') {
      if (ch === ')') depth = Math.max(0, depth - 1)
      out.push({ t: 'paren', v: ch, depth })
      if (ch === '(') depth++
      afterOpen = ch === '('
      i++
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      out.push({ t: 'str', v: src.slice(i, j + 1) })
      i = j + 1
      afterOpen = false
      continue
    }
    const cop = COPULAS.find((c) => src.startsWith(c, i))
    if (cop) {
      out.push({ t: 'copula', v: cop })
      i += cop.length
      afterOpen = false
      continue
    }
    let j = i
    while (j < src.length && !/[\s()]/.test(src[j])) j++
    const word = src.slice(i, j)
    if (/^[$?#]/.test(word)) out.push({ t: 'var', v: word })
    else if (/^-?\d+(\.\d+)?$/.test(word)) out.push({ t: 'num', v: word })
    else if (word.length === 1 && SINGLE_OPS.has(word)) out.push({ t: 'copula', v: word })
    else out.push({ t: afterOpen ? 'head' : 'sym', v: word })
    afterOpen = false
    i = j
  }
  return out
}

/** Syntax colours are CSS variables (index.css "MeTTa syntax"): the classic pastels, inked darker on a light chrome. */
const PAREN_COLORS = ['var(--metta-p0)', 'var(--metta-p1)', 'var(--metta-p2)', 'var(--metta-p3)']

/** MeTTa statement with quiet syntax colouring: parens by depth, copulas bright, variables italic. */
export const MeTTa = memo(function MeTTa({ src, className, wrap = true }: { src: string; className?: string; wrap?: boolean }) {
  const toks = tokenize(src)
  return (
    <code className={cx('font-mono text-[0.92em] leading-relaxed', wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-nowrap', className)} aria-label={src}>
      {toks.map((k, i) => {
        switch (k.t) {
          case 'ws':
            return <span key={i}>{k.v}</span>
          case 'paren':
            return (
              <span key={i} style={{ color: PAREN_COLORS[(k.depth ?? 0) % PAREN_COLORS.length], opacity: 0.85 }} aria-hidden="true">
                {k.v}
              </span>
            )
          case 'copula':
            return (
              <span key={i} className="font-semibold" style={{ color: 'var(--metta-copula)' }}>
                {k.v}
              </span>
            )
          case 'var':
            return (
              <span key={i} className="italic" style={{ color: 'var(--metta-var)' }}>
                {k.v}
              </span>
            )
          case 'num':
            return (
              <span key={i} style={{ color: 'var(--metta-num)' }}>
                {k.v}
              </span>
            )
          case 'str':
            return (
              <span key={i} style={{ color: 'var(--metta-str)' }}>
                {k.v}
              </span>
            )
          case 'head':
            return (
              <span key={i} style={{ color: 'var(--metta-head)' }}>
                {k.v}
              </span>
            )
          default:
            return (
              <span key={i} style={{ color: 'var(--metta-sym)' }}>
                {k.v}
              </span>
            )
        }
      })}
    </code>
  )
})
