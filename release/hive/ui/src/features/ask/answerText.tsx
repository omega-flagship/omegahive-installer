/**
 * An answer's words, with the little markdown minds write shown as it is meant (Jon, 4 Nov: "- **First attempt:**"
 * appeared literally in the thread): **bold** is bold, lines starting "- ", "* " or "• " form a list, and a leading
 * "#" heading marker is dropped. Nothing else is interpreted; everything stays text (no HTML, no links).
 */
import { Fragment, type ReactNode } from 'react'

const BULLET = /^\s*(?:[-*•])\s+/
/** a line's **bold** runs as <strong>, each piece passed through `mark` (the thread's word highlighting) */
export function inline(text: string, mark: (t: string) => ReactNode): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*|__(.+?)__/)
  const out: ReactNode[] = []
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) out.push(<Fragment key={i}>{mark(parts[i])}</Fragment>)
    const bold = parts[i + 1] ?? parts[i + 2]
    if (bold) out.push(<strong key={i + 1}>{mark(bold)}</strong>)
  }
  return out
}

/** One paragraph: a list when every line is a bullet, else a paragraph (a heading marker dropped). */
export function AnswerParagraph({ text, mark, className }: { text: string; mark: (t: string) => ReactNode; className?: string }) {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length && lines.every((l) => BULLET.test(l))) {
    return <ul className={className} data-answer-list="">{lines.map((l, i) => <li key={i}>{inline(l.replace(BULLET, ''), mark)}</li>)}</ul>
  }
  return <p className={className}>{inline(text.replace(/^\s*#{1,6}\s+/, ''), mark)}</p>
}
