/**
 * Vocabulary, not engines (UNIVERSAL_ASK_DESIGN §2.1): an experience or form adds words and places for its own scope;
 * it never forks the engine. Registered once at module load by the experience (e.g. experiences/still/vocab.ts).
 */
export interface Vocabulary {
  /** Feature ids this scope does in place, so they need no mind or swarm first (Still's sheets and passages). */
  inPlace?: string[]
  /** Extra phrases for features, in this scope only. */
  phrases?: Record<string, string[]>
  /** Words for the scope's own place in the thread ("on the paper"). */
  where?: string
}

const packs = new Map<string, Vocabulary>()

/** Add (or replace) a scope's vocabulary. Returns a function that removes it. */
export function registerVocabulary(scope: string, v: Vocabulary): () => void {
  packs.set(scope, v)
  return () => {
    if (packs.get(scope) === v) packs.delete(scope)
  }
}

export const vocabularyFor = (scope: string): Vocabulary => packs.get(scope) ?? {}
