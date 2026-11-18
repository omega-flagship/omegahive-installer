import { memo } from 'react'
import { asWritten as writtenOf, sayBelief, truthNumbers, truthWords, type Truth } from '../lib/beliefSentence'
import { Words } from '../features/views/Words'

/**
 * uifix-r3 (UI review 2026-10-12 S3, a11y-07): beliefs shown to people. Every experience renders beliefs and truth values
 * through these, never the notation itself. Screen readers get the sentence and the sureness in words with its numbers;
 * the notation is only behind "Show as written" (`data-as-written`, the one place the standing guard allows it). Words
 * said in the hive, and "as written" itself, are the part MeTTa composes for every look (features/views/Words.tsx), so
 * an artifact id in them is shown as the artifact's title everywhere.
 */

/** "Show as written": a small disclosure that reveals the exact text the mind wrote. Closed by default. It is the
 *  as-written part of the composed words (features/views/words.metta), drawn the same way in every look. */
export function AsWritten({ text, className }: { text: string; className?: string }) {
  return <Words text={text} said={false} written className={className} />
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
