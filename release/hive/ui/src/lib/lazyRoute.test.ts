import { describe, expect, it } from 'vitest'
import { retryLoad } from './lazyRoute'

/** A stand-in document head that records the stylesheets added to it. */
function fakeDoc() {
  const added: { rel: string; href: string }[] = []
  const doc = {
    createElement: () => ({ rel: '', href: '' }),
    head: { appendChild: (l: { rel: string; href: string }) => void added.push(l) },
  } as unknown as Pick<Document, 'createElement' | 'head'>
  return { doc, added }
}

describe('Retry runs the view’s own loader (stand-in r2 P2)', () => {
  it('a failure naming a dependency (ProgramHost under ProgramPage) still yields the view’s own module', async () => {
    const programPage = { default: function ProgramPage() { return null } }
    let calls = 0
    const factory = () => {
      calls++
      return Promise.resolve(programPage)
    }
    const depErr = new TypeError('Failed to fetch dynamically imported module: https://x/omegahive/assets/ProgramHost-a4b3p1kD.js')
    const { doc, added } = fakeDoc()
    const mod = await retryLoad(depErr, factory, doc)
    expect(mod).toBe(programPage) // never the dependency's namespace
    expect(calls).toBe(1)
    expect(added).toEqual([]) // a script is never fetched by the address the error names
  })

  it('a failed stylesheet is added again under a new address, then the view’s own loader runs', async () => {
    const view = { default: function CodePage() { return null } }
    const { doc, added } = fakeDoc()
    const mod = await retryLoad(new Error('Unable to preload CSS for https://x/assets/CodePage-DRugEDNw.css'), () => Promise.resolve(view), doc)
    expect(mod).toBe(view)
    expect(added).toHaveLength(1)
    expect(added[0].rel).toBe('stylesheet')
    expect(added[0].href).toMatch(/^https:\/\/x\/assets\/CodePage-DRugEDNw\.css\?retry=\d+$/)
  })

  it('when the loader fails the same way again, that failure is what comes back (the recovery then says Reload)', async () => {
    const err = new TypeError('Failed to fetch dynamically imported module: https://x/a/ProgramPage-1.js')
    await expect(retryLoad(err, () => Promise.reject(err), fakeDoc().doc)).rejects.toBe(err)
  })
})
