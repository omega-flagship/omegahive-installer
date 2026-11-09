import { describe, expect, it } from 'vitest'
import { nativeWords } from './nativeWords'
import { partsSpace } from '../experiences/parts/space'

describe('released native wording uses the authored MeTTa intent space', () => {
  it('reads each native voice through the same real engine query as the candidate inspector', () => {
    const words = nativeWords(), parts = partsSpace()
    for (const look of ['professional', 'still', 'construct']) {
      for (const intent of ['shell.omega', 'shell.question', 'ask.field', 'apps.open', 'apps.more', 'shell.pro', 'shell.power', 'shell.back']) {
        expect(words.say(look, intent), `${look}/${intent}`).toBe(parts.say(look, intent))
        expect(words.say(look, intent)).not.toBeNull()
      }
    }
    expect(words.say('construct', 'apps.open')).toBe('apps')
    expect(words.say('still', 'shell.pro')).toBe('Show everything')
    expect(nativeWords()).toBe(words)
    expect(Object.isFrozen(words)).toBe(true)
  })
  it('keeps retired and unknown intent inputs inert, including source-looking strings', () => {
    for (const intent of ['experience.omegatown', 'hive.changeui', 'invented.intent', '(+ 1 2)']) {
      expect(nativeWords().say('construct', intent)).toBeNull()
      expect(partsSpace().say('construct', intent)).toBeNull()
    }
  })
})
