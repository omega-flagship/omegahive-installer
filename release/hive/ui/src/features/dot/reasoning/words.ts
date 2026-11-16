import type { UnavailableWhy } from './load'

/** What the viewers say, in plain words (ModuleViewer). */
export const UNAVAILABLE_TEXT: Record<UnavailableWhy, string> = {
  no_reader: 'Unavailable: no reader yet',
  withheld: 'Unavailable: not visible to you, or withheld',
  stale: 'Unavailable: stale, as the host reports',
  unreadable: 'Unavailable: the answer could not be read',
  unspecified: 'Unavailable',
}
export const EMPTY_TEXT = 'Nothing held right now'

/**
 * Every host string a person sees (labels, plain explanations, qualifications) is said through this filter: the
 * retired goal/board names are said as tasks and task lists (Jon's wording rule; the static wordingGuard test covers
 * the UI's own strings, this covers what the host sends). A leading capital is kept.
 */
export function plainWords(text: string): string {
  const cap = (from: string, to: string) => (from[0] === from[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to)
  return text
    .replace(/\b(goals?)[\s_-]+(boards?)\b/gi, (_m, g: string, b: string) => cap(g, b.toLowerCase().endsWith('s') ? 'task lists' : 'task list'))
    .replace(/\bgoals\b/gi, (m) => cap(m, 'tasks'))
    .replace(/\bgoal\b/gi, (m) => cap(m, 'task'))
    .replace(/\bboards\b/gi, (m) => cap(m, 'task lists'))
    .replace(/\bboard\b/gi, (m) => cap(m, 'task list'))
}

/** A host code in plain words (separators as spaces, then the same wording filter). */
export function plainCode(code: string): string {
  return plainWords(code.replace(/[_.:-]+/g, ' ').trim())
}
