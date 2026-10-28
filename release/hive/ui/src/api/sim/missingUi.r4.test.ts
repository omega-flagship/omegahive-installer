import { describe, expect, it } from 'vitest'
import { ApiError } from '../client'
import type { AskEvent, AskTurnState } from '../ask'

/**
 * Missing-UI batch 1 r4: the stand-in's r3 FIX-FIRST (STANDIN_MISSING_UI_B1_r3_VERDICT_20261007). Each test fails on
 * 884e206 and passes after. Modules are imported inside each test so one missing export fails only its own test.
 */
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
const SRC = new URL('../..', import.meta.url).pathname
const read = (p: string) => fs.readFileSync(`${SRC}${p}`, 'utf8')

const PLAIN = 'That code access only lets you look, not change code. Nothing was changed.'

describe('r4 item 1: a read grant only looks; the hive’s 403 grant_scope reads in plain words', () => {
  it('the hive envelope and the bare shape both carry plain words, never the method and path', async () => {
    const { parseErrorBody } = await import('../relayedError')
    const env = parseErrorBody(403, 'Forbidden', { error: { code: 'grant_scope', message: 'your read grant does not allow POST /v1/workspaces' } })
    expect(env).toEqual({ code: 'grant_scope', message: PLAIN })
    expect(parseErrorBody(403, 'Forbidden', { error: 'grant_scope', message: "a read grant does not allow ['write']" })).toEqual({ code: 'grant_scope', message: PLAIN })
    // other refusals keep the hive's words
    expect(parseErrorBody(403, 'Forbidden', { error: { code: 'grant_invalid', message: 'no active grant' } }).message).toBe('no active grant')
  })

  it('errorMessage and the Code failure words say it plainly; the grant is not treated as withdrawn', async () => {
    const { errorMessage } = await import('../../lib/useResource')
    const { describeFailure } = await import('../../features/code/suggestions/model')
    const { grantRefused } = await import('../../features/code/editSessionRules')
    const e = new ApiError(403, 'grant_scope', 'your read grant does not allow POST /v1/workspaces/w/propose')
    expect(errorMessage(e)).toBe(PLAIN)
    expect(describeFailure(e)).toEqual({ kind: 'refused', text: PLAIN })
    expect(grantRefused(e)).toBe(false)
  })

  it('the Read only option stays, and says the hive refuses any change made with it', async () => {
    const { SCOPE_WORDS } = await import('../../features/tasks/CodeAccess')
    expect(SCOPE_WORDS.read).toMatch(/^Read: look, never change\. The hive refuses any change made with it\.$/)
    const src = read('features/tasks/CodeAccess.tsx')
    expect(src).toContain("(['edit', 'read'] as const)")
    expect(src).toContain("'Read only'")
    expect(src).toContain('SCOPE_WORDS[scope]')
  })
})

describe('r4 item 2: only people who can use code access are offered it', () => {
  it('recipients are enabled admins only (the hive opens a task’s code for admins only for now)', async () => {
    const { grantRecipients } = await import('../../features/tasks/CodeAccess')
    const people = [
      { id: 'a', role: 'admin' as const, disabled: false },
      { id: 'm', role: 'member' as const, disabled: false },
      { id: 'x', role: 'admin' as const, disabled: true },
    ]
    expect(grantRecipients(people).map((p) => p.id)).toEqual(['a'])
  })

  it('the dialog lists recipients through that rule and says why members are not listed', () => {
    const src = read('features/tasks/CodeAccess.tsx')
    expect(src).toContain('grantRecipients(people.data?.people ?? [])')
    expect(src).not.toMatch(/\.filter\(\(p\) => !p\.disabled\)/)
    expect(src).toContain('Admins only. The hive opens a task’s code for admins only for now, so a member could not use it.')
    // the success note no longer claims the person "has" access they could not use
    expect(src).not.toMatch(/has \$\{g\.scope\} access/)
  })
})

describe('r4 item 3: Earlier never shows part of an answer as the whole', () => {
  const frame = (seq: number): AskEvent => ({ phase: 'answer', seq, text: `part ${seq}` }) as unknown as AskEvent
  /** A kept answer of `n` one-frame pages. */
  const pages = (n: number, seen: number[] = []) => async (_op: string, after: number): Promise<AskTurnState> => {
    seen.push(after)
    const seq = after + 1
    return { operation_id: 'op', turn_id: 't', events: [frame(seq)], more: seq < n, next_after: seq }
  }

  it('a seven-page answer: the first read stops after five pages, says so, and reading on completes it', async () => {
    const { readAnswer, answerNote, answerText, ANSWER_PAGES } = await import('../../features/ask/Earlier')
    expect(ANSWER_PAGES).toBe(5)
    const seen: number[] = []
    const first = await readAnswer(pages(7, seen), 'op')
    expect(first.next).toBe(5)
    expect(answerNote(first)).toMatch(/Only the first part of this answer is shown/)
    expect(answerText(first.events)).toBe(['part 1', 'part 2', 'part 3', 'part 4', 'part 5'].join('\n'))
    const rest = await readAnswer(pages(7, seen), 'op', first)
    expect(rest.next).toBeNull()
    expect(answerNote(rest)).toBeNull()
    expect(answerText(rest.events).split('\n')).toHaveLength(7)
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('more without a later place to read from is shown as partial, never looped or taken as whole', async () => {
    const { readAnswer, answerNote } = await import('../../features/ask/Earlier')
    const stuck = async (): Promise<AskTurnState> => ({ operation_id: 'op', turn_id: 't', events: [frame(1)], more: true })
    const r = await readAnswer(stuck, 'op')
    expect(r).toMatchObject({ next: null, stalled: true })
    expect(answerNote(r)).toMatch(/Only part of this answer is shown/)
  })

  it('the Earlier card offers to read on and does not cache a fixed five-page read', () => {
    const src = read('features/ask/Earlier.tsx')
    expect(src).toContain('Read more of the answer')
    expect(src).toContain('data-answer-partial')
    expect(src).not.toMatch(/for \(let i = 0; i < 5; i\+\+\)/)
  })
})
