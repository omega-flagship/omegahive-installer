import { WORK_WORDS, type Feature } from './sdk'

/** Display only. Native API kinds, routes and exact IDs keep their owner spelling. */
const words: Record<string, string> = { board: 'task view', boards: 'task views', goal: WORK_WORDS.task.toLowerCase(), goals: WORK_WORDS.tasks.toLowerCase() }
export function publicWords(text: string): string {
  return text.replace(/\b(boards?|goals?)\b/gi, (word) => {
    const replacement = words[word.toLowerCase()]
    return /^[A-Z]/.test(word) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement
  })
}
export const publicLabel = (f: Feature): string => publicWords(f.label)
export const publicBlurb = (f: Feature): string => publicWords(f.blurb)
export const publicActivityKind = (kind: string): string => publicWords(kind.replace(/[._:-]+/g, ' '))
