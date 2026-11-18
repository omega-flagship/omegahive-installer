// Purpose: the one way a look draws words said in the hive (a mind's reply, a mind's answer in the Ask, a person's message, the hive's own note, a room's talk, a goal's detail) and a statement as written: the parts MeTTa composes for them in every look (features/views/words.metta), drawn by ComposedWords.tsx once the screen engine has loaded; until then the same words in plain text, every artifact id a word in its place, never the id.
import { Suspense, useState, type ReactNode } from 'react'
import { plainText } from '../../lib/beliefSentence'
import { lazyRoute } from '../../lib/lazyRoute'
import { loadedWords, loadWords } from './wordsLoader'

export interface WordsProps {
  /** the words, exactly as they were said or written */
  text: string
  /** draw the words themselves; false where only "as written" is wanted */
  said?: boolean
  /** offer the words as written: by default, when they held notation that is said in English */
  written?: boolean
  /** the place's own class for the as-written disclosure, set on its span (the commons style it) */
  className?: string
  /** how the place marks plain words, as the Ask lights up what was asked about; chips and the words as written are
   *  never marked */
  mark?: (words: string) => ReactNode
}

const plain = (words: string): ReactNode => words

const Lazy = lazyRoute(loadWords)

/**
 * Words said in the hive, as every look draws them: an artifact id they name reads as the artifact's title in a chip
 * that opens it, a statement or truth value is said in English, and the exact words are a press away. A look draws
 * this where it draws such words, inside its own line or bubble, and never draws the words' chips or statements itself.
 */
export function Words(props: WordsProps) {
  // Each instance keeps the shape it mounted with, as loadable components do: mounted once the composed words have
  // loaded, it draws them at once (static rendering after wordsLoader's loadWords() too); mounted before, it stays on
  // the lazy path, which draws them in the same place once loaded, so its chips and disclosure never mount again.
  const [Composed] = useState(() => loadedWords())
  if (Composed) return <Composed {...props} />
  return (
    <Suspense fallback={props.said === false ? null : (props.mark ?? plain)(plainText(props.text))}>
      <Lazy {...props} />
    </Suspense>
  )
}
