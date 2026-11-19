import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { approvalLine, repositoryNames } from './sessionWords'

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

// A session page read raw to a person: the Code button named a repository by its id, and a mind's request led with its
// skill and MeTTa. INVENTED minds, paths and repositories.

const ask = (command: string, extra: Partial<{ skill: string; reason: string; risk: string; status: string }> = {}) => ({
  type: 'approval' as const, at: '2026-11-10T10:00:00Z', id: 'ap_invented_1', skill: 'shell', command, reason: 'human-only', risk: 'high', status: 'pending', ...extra,
})

describe('a request in one plain line', () => {
  it('says what the mind wants to do, in everyday words', () => {
    expect(approvalLine('Asha', ask('(shell "ls -la")')).wants).toBe('Asha wants to run a command on the computer')
    expect(approvalLine('Asha', ask('(read-file "notes/plan.md")', { skill: 'read-file' })).wants).toBe('Asha wants to read notes/plan.md')
    expect(approvalLine('Asha', ask('(write-file "out.txt" "hi")', { skill: 'write-file' })).wants).toBe('Asha wants to write a file called out.txt')
  })

  it('why a person is asked, its risk and its answer, in words', () => {
    const l = approvalLine('Asha', ask('(shell "ls")'))
    expect(l).toMatchObject({ why: 'Only a person is allowed to do this.', risk: 'high risk', status: 'Waiting for you' })
    expect(approvalLine('Asha', ask('(shell "ls")', { status: 'denied', risk: 'odd' }))).toMatchObject({ status: 'Not allowed', risk: null })
    expect(approvalLine('Asha', ask('(shell "ls")', { status: 'used' })).status).toBe('Allowed')
    expect(approvalLine('Asha', ask('(match &beliefs (B $x) $x)', { skill: 'metta', risk: 'low', status: 'auto' })).status).toBe('Ran without asking')
  })
})

describe('the request card', () => {
  const card = async (status = 'pending') => {
    const { ApprovalItem } = await import('./SessionView')
    return renderToStaticMarkup(createElement(ApprovalItem, { it: ask('(shell "rm -rf build")', { status }), mindName: 'Asha', onDecide: () => undefined }))
  }

  it('closed: the plain line first; the skill and the command one tap away, not on the card', async () => {
    const html = await card()
    expect(html).toContain('Asha wants to run a command on the computer')
    expect(html).toContain('Only a person is allowed to do this.')
    expect(html).toMatch(/aria-expanded="false"[^>]*>.*Show the command/)
    expect(html).not.toContain('rm -rf build')
    expect(html).not.toContain('human-only')
  })

  it('pending: the same four answers as before', async () => {
    const html = await card()
    for (const b of ['>Once<', '>No<', '>Never<', 'For a time / Always…']) expect(html).toContain(b)
    expect(await card('approved')).not.toContain('>Once<')
  })

  it('the command opens in place: skill and the full command, exactly as sent', () => {
    const src = fs.readFileSync(new URL('./SessionView.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/\{open && \(\s*<div className="mt-1\.5 space-y-1">\s*<p[^>]*>Skill <span className="font-mono text-ink">\{it\.skill\}<\/span><\/p>\s*<pre[^>]*>\{it\.command\}<\/pre>/)
  })
})

describe('a repository by its name, never its id', () => {
  it('names from Code’s targets, the repository’s own entry first; unnamed ones left out', () => {
    const names = repositoryNames([
      { kind: 'program', label: 'Invented app', repository_id: 'repo_invented_a' },
      { kind: 'repository', label: 'Garden notes', repository_id: 'repo_invented_a' },
      { kind: 'repository', label: 'repo_invented_b', repository_id: 'repo_invented_b' },
      { kind: 'repository', label: '  ', repository_id: 'repo_invented_c' },
    ])
    expect([...names]).toEqual([['repo_invented_a', 'Garden notes']])
  })

  it('the Code button shows the name, or no name at all', () => {
    const src = fs.readFileSync(new URL('./SessionView.tsx', import.meta.url), 'utf8')
    expect(src).not.toMatch(/\{w\.repository_id\} · open in Workbench/)
    expect(src).toMatch(/repoNames\.get\(w\.repository_id\) \? `\$\{repoNames\.get\(w\.repository_id\)\} · open in Workbench` : 'Open in Workbench'/)
  })
})
