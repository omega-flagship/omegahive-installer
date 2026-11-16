import { describe, expect, it } from 'vitest'
import type { ProgramDescription } from '../../api/types'
import { FORMS, formFor, NATIVE_GRAMMARS } from '../contract'
import { fixtureDescribe } from './fixture'
import { caseGrammar } from './palette'

const roles = (...r: string[]): ProgramDescription => ({ contract: '0.1', kinds: r.map((k) => ({ id: `k-${k}`, label: k, role: k as never })), relations: [], actions: [] })

describe('formFor', () => {
  it('opens OmegaTruth as a case file, whatever it describes', () => {
    expect(formFor('omegatruth', null)).toBe('case-file')
    expect(formFor('omegatruth', fixtureDescribe)).toBe('case-file')
  })
  it('gives the case file to any program arguing about a question (question + claim + evidence roles)', () => {
    expect(formFor('someone-else', roles('question', 'claim', 'evidence'))).toBe('case-file')
    expect(formFor('someone-else', roles('question', 'claim'))).toBeNull()
    expect(formFor('someone-else', null)).toBeNull()
  })
  it('has a component and native grammars for the case file; other grammars fall back to classic', () => {
    expect(FORMS['case-file']).toBeDefined()
    expect(NATIVE_GRAMMARS['case-file']).toEqual(['classic', 'still', 'construct'])
    expect(caseGrammar('still')).toBe('still')
    expect(caseGrammar('construct')).toBe('construct')
    for (const g of ['classic', 'cosmos', 'flux', 'canvas'] as const) expect(caseGrammar(g)).toBe('classic')
  })
})
