import { describe, expect, it } from 'vitest'
import { parse } from '../../lib/router'
import { codeView, type CodeRoute } from './codeView'
import { readWorkspace, saveSession, saveWorkspaceFor, workspaceKey, type SessionStore } from './savedSession'

/** Surface S (workbench load): the Code page decides from its own route; a late workspace create is remembered safely. */

const mem = (): SessionStore & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    get length() { return data.size },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}
const code = (hash: string) => {
  const r = parse(hash)
  if (r.name !== 'code') throw new Error(`not a code route: ${hash}`)
  return r as CodeRoute
}
async function source(rel: string): Promise<string> {
  const fsName = 'node:fs'
  const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string | URL, e: string) => string }
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
}
const ME = 'user:p_invented'
const T = 'repo:sim-suggestions'
const session = { task_id: 'g_new', grant_id: 'grant_new', repository_id: 'sim-suggestions' }

describe('codeView: the view comes from the route the page was opened for', () => {
  it('maps every #/code shape exactly as before', () => {
    expect(codeView(code('#/code'))).toEqual({ kind: 'list' })
    expect(codeView(code('#/code/repo%3Asim-suggestions'))).toEqual({ kind: 'target', target: T })
    expect(codeView(code('#/code?task=g_1'))).toEqual({ kind: 'choose', task: 'g_1' })
    expect(codeView(code('#/code?task=g_1&repository=r'))).toEqual({ kind: 'select', task: 'g_1', repository: 'r' })
    expect(codeView(code('#/code?task=g_1&workspace=ws_1&repository=r'))).toEqual({ kind: 'attach', task: 'g_1', workspace: 'ws_1', repository: 'r' })
    // a workspace without its task is not an attachment
    expect(codeView(code('#/code/repo%3Ax?workspace=ws_1'))).toEqual({ kind: 'target', target: 'repo:x' })
  })

  it('the Code page never reads the live hash (a leaving copy would render the next route)', async () => {
    const page = await source('./CodePage.tsx')
    expect(page).not.toMatch(/useRoute\s*\(/)
    expect(page).toMatch(/export default function CodePage\(\{ route \}: \{ route: CodeRoute \}\)/)
    const app = await source('../../App.tsx')
    expect(app).toMatch(/<CodePage route=\{route\} \/>/)
  })
})

describe('saveWorkspaceFor: a workspace is filed only under the session it was made for', () => {
  it('files it while the same task and grant are saved (also after the page left)', () => {
    const s = mem()
    saveSession(ME, T, session, true, s)
    expect(saveWorkspaceFor(ME, T, session, 'ws_made', s)).toBe(true)
    expect(readWorkspace(ME, T, s)).toBe('ws_made')
  })

  it('never files it under a newer session (another task, or the same task with another grant)', () => {
    const s = mem()
    saveSession(ME, T, { ...session, task_id: 'g_newer', grant_id: 'grant_newer' }, true, s)
    expect(saveWorkspaceFor(ME, T, session, 'ws_late', s)).toBe(false)
    saveSession(ME, T, { ...session, grant_id: 'grant_other' }, true, s)
    expect(saveWorkspaceFor(ME, T, session, 'ws_late', s)).toBe(false)
    expect(s.data.has(workspaceKey(ME, T))).toBe(false)
  })

  it('files nothing with no saved session, no principal or no storage', () => {
    const s = mem()
    expect(saveWorkspaceFor(ME, T, session, 'ws_x', s)).toBe(false)
    saveSession(ME, T, session, true, s)
    expect(saveWorkspaceFor(null, T, session, 'ws_x', s)).toBe(false)
    expect(saveWorkspaceFor(undefined, T, session, 'ws_x', s)).toBe(false)
    expect(saveWorkspaceFor(ME, T, session, 'ws_x', null)).toBe(false)
    expect(readWorkspace(ME, T, s)).toBeNull()
  })

  it('the workbench files the workspace before it checks whether it was left', async () => {
    const page = await source('./CodePage.tsx')
    const i = page.indexOf('if (!saved) saveWorkspaceFor(who, keyId, opened, w.id)')
    expect(i).toBeGreaterThan(0)
    expect(page.indexOf('if (cancelled) return', i)).toBeGreaterThan(i)
    expect(page).not.toMatch(/\bsaveWorkspace\(/)
  })

  it('Kimi K1/K2: the effect reads and files under the principal it started with, and files only what it created', async () => {
    const page = await source('./CodePage.tsx')
    const start = page.indexOf('const who = principal')
    expect(start).toBeGreaterThan(0)
    const body = page.slice(start, page.indexOf('}, [opened, call, keyId, principal, sharedWorkspace])', start))
    // no later principal reaches the read, the save or the drop
    expect(body).not.toMatch(/readWorkspace\(principal|saveWorkspaceFor\(principal|dropSessionIf\(principal/)
    expect(body).toContain('readWorkspace(who, keyId)')
    expect(body).toContain('dropSessionIf(who, keyId, opened)')
  })

  it('Kimi K1: a create that lands after the principal changed is filed for the earlier principal only', () => {
    const s = mem()
    const A = 'user:a'
    const B = 'user:b'
    saveSession(A, T, session, true, s)
    saveSession(B, T, { ...session, task_id: 'g_b', grant_id: 'grant_b' }, true, s)
    // A's run, started under A, files under A (who); B's entries are untouched
    expect(saveWorkspaceFor(A, T, session, 'ws_a', s)).toBe(true)
    expect(readWorkspace(A, T, s)).toBe('ws_a')
    expect(readWorkspace(B, T, s)).toBeNull()
    // had it used the newer principal with A's session, nothing would be filed (B holds another task and grant)
    expect(saveWorkspaceFor(B, T, session, 'ws_a', s)).toBe(false)
  })
})
