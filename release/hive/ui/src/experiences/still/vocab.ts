/**
 * Still's vocabulary for the shared fast path (lib/intent): the features it does on its own paper need no mind or
 * swarm first; they open their sheet or passage. Vocabulary only; the engine is shared (Surface universal Ask).
 */
import { registerVocabulary } from '../../lib/intent'
import { STILL_PLACE } from './features'

export const STILL_VOCABULARY = { inPlace: Object.keys(STILL_PLACE), where: 'on the paper' }
registerVocabulary('still', STILL_VOCABULARY)
