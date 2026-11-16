import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { gateWords, stepsLine, type SessionStep } from './sessionSteps'

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

// A tester opened a session in Messages and read "(hive-goal-get g_1) gated" as if the mind had said it. A step group
// now says what the mind did in plain words; its commands are inside the fold.

const step = (command: string, gated?: SessionStep['gated']): SessionStep => ({ command, result: 'ok', gated })

describe('a session step group in plain words', () => {
  it('says how many steps the mind took', () => {
    expect(stepsLine('Asha', [step('(hive-goal-get g_1)')])).toEqual({ did: 'Asha took 1 step', marks: [] })
    expect(stepsLine('Asha', [step('(hive-goal-get g_1)'), step('(send "hi")'), step('(remember "x")')]).did).toBe('Asha took 3 steps')
  })

  it('marks steps that waited for approval or were not allowed, never ones that were allowed', () => {
    expect(stepsLine('Asha', [step('(a)', 'allow'), step('(b)', null), step('(c)')]).marks).toEqual([])
    expect(stepsLine('Asha', [step('(a)', 'ask'), step('(b)', 'deny'), step('(c)', 'deny'), step('(d)', 'allow')]).marks)
      .toEqual(['1 waited for approval', '2 not allowed'])
    expect([gateWords('ask'), gateWords('deny'), gateWords('allow'), gateWords(null), gateWords(undefined)])
      .toEqual(['waited for approval', 'not allowed', null, null, null])
  })

  it('closed, the group shows the plain line and none of its commands', async () => {
    const { StepGroup } = await import('./SessionView')
    const html = renderToStaticMarkup(createElement(StepGroup, { mindName: 'Asha', commands: true, steps: [step('(hive-goal-get g_1)', 'allow'), step('(shell "ls")', 'ask')] }))
    expect(html).toContain('Asha took 2 steps')
    expect(html).toContain('1 waited for approval')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('hive-goal-get')
    expect(html).not.toContain('gated')
  })

  it('a member: the plain line only, no fold to open and no command anywhere', async () => {
    const { StepGroup } = await import('./SessionView')
    const html = renderToStaticMarkup(createElement(StepGroup, { mindName: 'Asha', commands: false, steps: [step('(hive-goal-get g_1)', 'deny'), step('(shell "ls")')] }))
    expect(html).toContain('Asha took 2 steps')
    expect(html).toContain('1 not allowed')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('aria-expanded')
    expect(html).not.toContain('hive-goal-get')
    expect(html).not.toContain('g_1')
  })

  it('the session decides who sees commands with the navigation’s admin view (members while /me loads or fails)', () => {
    const src = fs.readFileSync(new URL('./SessionView.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const \{ adminView \} = useAdminView\(\)/)
    expect(src).toMatch(/commands=\{adminView\}/)
  })
})

