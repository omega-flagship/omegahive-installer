import { describe, expect, it } from 'vitest'
import { followViewLink, oneQuestion } from './viewLink'
import programPage from './ProgramPage.tsx?raw'

/** Stand-in r1 P1: `?view=graph` on an open app switched the view directly and discarded unsaved Canvas edits. */
function run(unsaved: boolean, answer: boolean) {
  const did: string[] = []
  const done = followViewLink({
    isDirty: () => unsaved,
    confirm: async () => { did.push('asked'); return answer },
    apply: () => did.push('graph'),
    restore: () => did.push('route restored'),
  })
  return { did, done }
}

describe('a link to the graph view on an open app', () => {
  it('unsaved edits, the person keeps them: nothing switches (the edits stay) and the route goes back', async () => {
    const { did, done } = run(true, false)
    expect(await done).toBe(false)
    expect(did).toEqual(['asked', 'route restored'])
  })
  it('unsaved edits, the person discards them: then it switches', async () => {
    const { did, done } = run(true, true)
    expect(await done).toBe(true)
    expect(did).toEqual(['asked', 'graph'])
  })
  it('nothing unsaved: it switches at once, without asking', async () => {
    const { did, done } = run(false, false)
    expect(await done).toBe(true)
    expect(did).toEqual(['graph'])
  })
  it('reads the edits when the link is followed, not a value captured when the page rendered (followups-r5)', async () => {
    const dirty = { current: false }
    const did: string[] = []
    const o = {
      isDirty: () => dirty.current,
      confirm: async () => { did.push('asked'); return false },
      apply: () => did.push('graph'),
      restore: () => did.push('route restored'),
    }
    dirty.current = true   // edits made after the options were built
    expect(await followViewLink(o)).toBe(false)
    expect(did).toEqual(['asked', 'route restored'])
    did.length = 0
    dirty.current = false  // saved before the link is followed
    expect(await followViewLink(o)).toBe(true)
    expect(did).toEqual(['graph'])
  })
})

// ProgramPage's own guards (one dialog, worded for both; declined, the canvas unchanged and the route back; settled
// safely on an unmount or an identity change) are proven on the MOUNTED page: programPage.r6.test.ts (followups-r6).
describe('ProgramPage passes the guard the edits as they are when the link is followed', () => {
  it('isDirty reads dirty.current (a value the page cannot show a difference for once mounted, so it is pinned here)', () => {
    expect(programPage).toMatch(/followViewLink\(\{\n\s+isDirty: \(\) => dirty\.current,\n\s+confirm: /)
  })
})

describe('one unsaved-edits question at a time (followups-r5)', () => {
  it('two asks while one is open: one dialog, both get its answer', async () => {
    const one = oneQuestion()
    let asked = 0
    let answer!: (ok: boolean) => void
    const ask = () => { asked++; return new Promise<boolean>((r) => { answer = r }) }
    const a = one(ask)
    const b = one(ask)
    expect(asked).toBe(1)
    answer(true)
    expect(await a).toBe(true)
    expect(await b).toBe(true)
  })
  it('a declined question declines both asks', async () => {
    const one = oneQuestion()
    let asked = 0
    const ask = async () => { asked++; return false }
    const [a, b] = [one(ask), one(ask)]
    expect([await a, await b]).toEqual([false, false])
    expect(asked).toBe(1)
  })
  it('once answered, the next ask asks again', async () => {
    const one = oneQuestion()
    let asked = 0
    const ask = async () => { asked++; return asked === 2 }
    expect(await one(ask)).toBe(false)
    expect(await one(ask)).toBe(true)
    expect(asked).toBe(2)
  })
  it('both route guards through it: one dialog for a source change and a graph link together', async () => {
    const one = oneQuestion()
    const shown: string[] = []
    let answer!: (ok: boolean) => void
    const dialog = (m: string) => () => { shown.push(m); return new Promise<boolean>((r) => { answer = r }) }
    const did: string[] = []
    const opened = one(dialog('open another')).then((ok) => did.push(ok ? 'opened' : 'source kept'))
    const viewed = followViewLink({ isDirty: () => true, confirm: () => one(dialog('switch view')), apply: () => did.push('graph'), restore: () => did.push('route restored') })
    answer(false)
    await opened
    await viewed
    expect(shown).toEqual(['open another'])
    expect(did.sort()).toEqual(['route restored', 'source kept'])
  })
})
