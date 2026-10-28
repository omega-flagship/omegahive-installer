import { Fragment, memo, useId, useState } from 'react'
import { cx } from '../lib/cx'
import { asWritten as writtenOf, plainPieces, sayBelief, truthNumbers, truthWords, type Truth } from '../lib/beliefSentence'

/**
 * uifix-r3 (UI review 2026-10-12 S3, a11y-07): beliefs shown to people. Every experience renders beliefs and truth values
 * through these, never the notation itself. Screen readers get the sentence and the sureness in words with its numbers;
 * the notation is only behind "Show as written" (`data-as-written`, the one place the standing guard allows it).
 */

/** "Show as written": a small disclosure that reveals the exact text the mind wrote. Closed by default. */
export function AsWritten({ text, className, label = 'as written' }: { text: string; className?: string; label?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className={cx('belief-as-written', className)}>
      <button
        type="button"
        className="ml-1.5 inline cursor-pointer border-0 bg-transparent p-0 align-baseline text-[0.78em] underline decoration-dotted underline-offset-2 opacity-70 hover:opacity-100 focus-visible:opacity-100"
        style={{ color: 'inherit', fontFamily: 'inherit' }}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        {open ? `Hide ${label}` : `Show ${label}`}
      </button>
      {/* always in the DOM, hidden while closed, so aria-controls always names an element (uifix-r3.1) */}
      <code id={id} hidden={!open} data-as-written="" className={cx('mt-1 font-mono text-[0.85em] opacity-80 [overflow-wrap:anywhere]', open && 'block')}>
        {text}
      </code>
    </span>
  )
}

/** Sureness in words, its numbers on hover and for screen readers: "fairly sure". */
export function Sureness({ tv, className, prefix = '' }: { tv: Truth; className?: string; prefix?: string }) {
  return (
    <span className={className} title={truthNumbers(tv)}>
      {prefix}
      {truthWords(tv)}
      <span className="sr-only"> ({truthNumbers(tv)})</span>
    </span>
  )
}

/**
 * A belief as a sentence: "Vega is a star · fairly sure", with "Show as written" beside it. `adverb` puts the sureness
 * into the sentence instead ("Vega is very likely a star"); `written={false}` leaves the disclosure to the caller (for a
 * sentence inside a button, where a second button cannot go).
 */
export const BeliefSentence = memo(function BeliefSentence({
  statement,
  tv,
  adverb = false,
  sure = true,
  written = true,
  className,
}: {
  statement: string
  tv?: Truth | null
  adverb?: boolean
  sure?: boolean
  written?: boolean
  className?: string
}) {
  const s = sayBelief(statement, adverb ? tv : null)
  return (
    <span className={className} data-belief="">
      <span>{s.text}</span>
      {tv && sure && !adverb && <Sureness tv={tv} prefix=" · " className="opacity-75" />}
      {written && <AsWritten text={writtenOf(statement, tv)} />}
    </span>
  )
})

/**
 * Free text from a mind (chat, activity) with any statements and truth numbers said in English; when there were any,
 * "Show as written" gives back the exact message.
 */
export const PlainText = memo(function PlainText({ text, written = true }: { text: string; written?: boolean }) {
  const pieces = plainPieces(text)
  const changed = pieces.some((p) => p.raw !== undefined)
  return (
    <>
      {pieces.map((p, i) => (p.raw === undefined ? <Fragment key={i}>{p.t}</Fragment> : <span key={i} data-said={p.kind}>{p.t}</span>))}
      {changed && written && <AsWritten text={text} />}
    </>
  )
})
