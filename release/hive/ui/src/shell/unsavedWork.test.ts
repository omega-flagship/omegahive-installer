import { describe, expect, it } from 'vitest'
import { markUnsaved } from '../features/ask/dirty'
import { useDrafts } from '../experiences/drafts'
import { createChunkRecovery, type UpdateNotice } from '../lib/chunkReload'
import { installEditTracking, markSaved, noteChange, noteClick, noteEdit, noteRoute, routeKeyOf, typedWork, unsavedWork, type EditableLike } from './unsavedWork'

const field = (over: Partial<EditableLike> = {}): EditableLike => ({ tagName: 'INPUT', type: 'text', value: '', isConnected: true, closest: () => null, ...over })

describe('unsaved work (what a chunk-reload must not lose)', () => {
  it('is nothing on a clean page', () => {
    expect(unsavedWork()).toBe(false)
  })
  it('counts a page marked unsaved (useUnsaved / markUnsaved)', () => {
    markUnsaved('t-form', true)
    expect(unsavedWork()).toBe(true)
    markUnsaved('t-form', false)
    expect(unsavedWork()).toBe(false)
  })
  it('counts a kept draft (in memory only), not an empty one', () => {
    useDrafts.setState({ drafts: { 'town:mind:m1': '   ' } })
    expect(unsavedWork()).toBe(false)
    useDrafts.setState({ drafts: { 'town:mind:m1': 'half a thought' } })
    expect(unsavedWork()).toBe(true)
    useDrafts.setState({ drafts: {} })
    expect(unsavedWork()).toBe(false)
  })
})

describe('typed text counts until the page changes, the form is sent, or the person empties it (stand-in r2/r3 P1)', () => {
  const typeInto = (el: EditableLike, text: string) => {
    if (el.isContentEditable) el.textContent = text
    else el.value = text
    noteEdit(el)
  }

  it('the wizard: a field typed into on one step, then Continue unmounts it: still unsaved (disconnecting alone never clears)', () => {
    noteRoute('#/launch')
    const name = field()
    typeInto(name, 'Night shift')
    name.isConnected = false // Continue: the Purpose step's fields leave the page; their words live on in the wizard
    expect(typedWork()).toBe(true)
    expect(unsavedWork()).toBe(true)
    noteRoute('#/swarms') // the person leaves the page
    expect(typedWork()).toBe(false)
  })

  it('a route change clears it; the same page settling its own address does not', () => {
    noteRoute('#/program/omegadesign')
    typeInto(field(), 'a poster')
    noteRoute('#/program/omegadesign/s_forge')
    expect(typedWork()).toBe(true)
    noteRoute('#/program/omegadesign?tab=2')
    expect(typedWork()).toBe(true)
    noteRoute('#/models')
    expect(typedWork()).toBe(false)
    expect(routeKeyOf('#/swarm/s1/tasks')).toBe('swarm/s1')
  })

  it('submitting never clears: a refused, cancelled or failed save keeps the words protected (stand-in r4 P1)', async () => {
    // the real listeners, installed on a stand-in document: input is listened for, submit is not
    const docListeners: Record<string, ((e: { target: unknown }) => void)[]> = {}
    const winListeners: Record<string, (() => void)[]> = {}
    const win = {
      location: { hash: '#/swarm/s1/connections' },
      addEventListener: (t: string, fn: () => void) => void (winListeners[t] ??= []).push(fn),
      document: { addEventListener: (t: string, fn: (e: { target: unknown }) => void) => void (docListeners[t] ??= []).push(fn) },
    }
    installEditTracking(win as never)
    expect(Object.keys(docListeners).sort()).toEqual(['change', 'click', 'input']) // never 'submit'
    const url = field({ closest: () => null })
    url.value = 'https://example.invalid/hook'
    docListeners.input.forEach((fn) => fn({ target: url }))
    // "Review connection": the form submits, then its confirmation is cancelled (or the hive refuses it)
    docListeners.submit?.forEach((fn) => fn({ target: { contains: () => true } }))
    expect(typedWork()).toBe(true)
    const shown: UpdateNotice[] = []
    let reloads = 0
    const r = createChunkRecovery({
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      pageBuild: 'index-A.js',
      fetchBuild: async () => 'index-B.js',
      unsaved: unsavedWork,
      now: () => 0,
      reload: () => void reloads++,
      show: (n) => void shown.push(n),
    })
    expect(await r.handle(new TypeError('Failed to fetch dynamically imported module: https://x/assets/StopAll-1.js'))).toBe('unsaved')
    expect(reloads).toBe(0)
    noteRoute('#/') // leave the page
  })

  it('a form that says its save succeeded (markSaved) releases only what was typed inside its scope, even off the page', () => {
    noteRoute('#/swarms/new')
    const scoped = (name: string) => (sel: string) => (sel === '[data-unsaved-scope]' ? { getAttribute: () => name } : null)
    const purpose = field({ tagName: 'TEXTAREA', type: undefined, closest: scoped('launch-swarm') })
    const elsewhere = field({ closest: scoped('add-key') })
    typeInto(purpose, 'Answer the night queue')
    typeInto(elsewhere, 'work key')
    purpose.isConnected = false // an earlier wizard step
    markSaved('launch-swarm')
    expect(typedWork()).toBe(true) // the other form's words still count
    markSaved('add-key')
    expect(typedWork()).toBe(false)
  })

  it('the person emptying every typed field (on the page) clears it', () => {
    noteRoute('#/new')
    const name = field()
    const note = field({ tagName: 'DIV', type: undefined, value: undefined, isContentEditable: true, textContent: '' })
    typeInto(name, 'Wren')
    typeInto(note, 'notes')
    typeInto(name, '   ')
    expect(typedWork()).toBe(true)
    typeInto(note, '')
    expect(typedWork()).toBe(false)
  })

  it('not a checkbox, a range, a field that opts out, or something that is not a field', () => {
    noteRoute('#/settings')
    noteEdit(field({ type: 'checkbox', value: 'on' }))
    noteEdit(field({ type: 'range', value: '5' }))
    noteEdit(field({ value: 'query', closest: (sel: string) => (sel === '[data-unsaved-ignore]' ? {} : null) }))
    noteEdit({ tagName: 'BUTTON', value: 'x' })
    noteEdit(null)
    expect(typedWork()).toBe(false)
  })

  it('a form typed into, then a new build and a failed overlay: no automatic reload, "Save or copy your work"', async () => {
    const cases: [string, () => void][] = [
      ['a new mind’s name, still on the page', () => typeInto(field(), 'Wren')],
      ['a key’s label', () => typeInto(field(), 'work key')],
      ['a swarm’s purpose, after Continue unmounted it', () => {
        const purpose = field({ tagName: 'TEXTAREA', type: undefined })
        typeInto(purpose, 'Answer the night queue')
        purpose.isConnected = false
      }],
    ]
    for (const [, typeIt] of cases) {
      noteRoute('#/x')
      noteRoute('#/launch') // a fresh page each time
      typeIt()
      const shown: UpdateNotice[] = []
      let reloads = 0
      const r = createChunkRecovery({
        storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        pageBuild: 'index-A.js',
        fetchBuild: async () => 'index-B.js',
        unsaved: unsavedWork,
        now: () => 0,
        reload: () => void reloads++,
        show: (n) => void shown.push(n),
      })
      // the failed load is an overlay (Stop all) over the form, which stays open
      expect(await r.handle(new TypeError('Failed to fetch dynamically imported module: https://x/assets/StopAll-1.js'))).toBe('unsaved')
      expect(shown).toEqual(['unsaved'])
      expect(reloads).toBe(0)
    }
    noteRoute('#/')
  })
})

describe('choices count like typing (stand-in r5 P1: non-text controls)', () => {
  /** an element whose closest() answers the given selectors (substring match on the selector list) */
  const el = (over: Partial<EditableLike> & { scope?: string; ignore?: boolean; role?: boolean } = {}): EditableLike => {
    const self: EditableLike = {
      tagName: 'SELECT', value: '', isConnected: true, ...over,
      closest: (sel: string) => {
        if (sel === '[data-unsaved-ignore]') return over.ignore ? {} : null
        if (sel === '[data-unsaved-scope]') return over.scope ? { getAttribute: () => over.scope } : null
        return over.role ? self : null
      },
    }
    return self
  }

  it('a select, checkbox, radio or range changed by the person counts; a select set back to empty is undone', () => {
    noteRoute('#/code/ws1')
    const resolution = el({ value: 'ours' })
    noteChange(resolution)
    expect(typedWork()).toBe(true)
    resolution.value = ''
    noteChange(resolution)
    expect(typedWork()).toBe(false)
    for (const type of ['checkbox', 'radio', 'range']) {
      noteRoute('#/x')
      noteRoute('#/code/ws1')
      noteChange(el({ tagName: 'INPUT', type, value: 'on' }))
      expect(typedWork()).toBe(true)
    }
    noteRoute('#/x')
    noteChange(el({ tagName: 'INPUT', type: 'text', value: 'words' })) // a text field's change is typing, noted by input
    noteChange(el({ value: 'ours', ignore: true }))
    noteChange(null)
    expect(typedWork()).toBe(false)
  })

  it('a file picked in any file input counts until it is cleared, the page changes, or its form says it stored it (stand-in r6)', async () => {
    noteRoute('#/')
    noteRoute('#/assets')
    const upload = el({ tagName: 'INPUT', type: 'file', value: 'C:\\fakepath\\report.pdf', scope: 'asset-upload' })
    noteChange(upload)
    expect(typedWork()).toBe(true)
    const shown: UpdateNotice[] = []
    let reloads = 0
    const r = createChunkRecovery({
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      pageBuild: 'index-A.js',
      fetchBuild: async () => 'index-B.js',
      unsaved: unsavedWork,
      now: () => 0,
      reload: () => void reloads++,
      show: (n) => void shown.push(n),
    })
    expect(await r.handle(new TypeError('Failed to fetch dynamically imported module: https://x/assets/StopAll-1.js'))).toBe('unsaved')
    expect(reloads).toBe(0)
    upload.value = '' // the person cleared the picker
    noteChange(upload)
    expect(typedWork()).toBe(false)
    noteChange(upload) // a cleared picker changing again with nothing chosen stays clear
    upload.value = 'C:\\fakepath\\report.pdf'
    noteChange(upload)
    markSaved('asset-upload') // "Store it" succeeded
    expect(typedWork()).toBe(false)
    noteChange(el({ tagName: 'INPUT', type: 'file', value: 'C:\\fakepath\\mind.omegamind.tgz' }))
    noteRoute('#/minds')
    expect(typedWork()).toBe(false)
    noteRoute('#/')
  })

  it('a click on a custom choice (role radio/checkbox/switch/option, or data-unsaved-choice) counts; opted-out surfaces do not', () => {
    noteRoute('#/code/ws1')
    noteClick(el({ tagName: 'BUTTON', role: false }))
    expect(typedWork()).toBe(false) // a plain button is not a choice
    noteClick(el({ tagName: 'LI', role: true, ignore: true })) // an Ask suggestion: its listbox opts out
    expect(typedWork()).toBe(false)
    noteClick(el({ tagName: 'BUTTON', role: true })) // data-unsaved-choice, or a role="radio" button
    expect(typedWork()).toBe(true)
    noteRoute('#/') // leave the page
  })

  it('choices clear on a route change, on markSaved for their scope, and on nothing else (not on leaving the page)', () => {
    noteRoute('#/')
    noteRoute('#/code/ws1')
    const picked = el({ value: 'incoming', scope: 'merge-resolution' })
    const other = el({ value: 'drain', scope: 'other-form' })
    noteChange(picked)
    picked.isConnected = false
    expect(typedWork()).toBe(true)
    noteChange(other)
    markSaved('merge-resolution')
    expect(typedWork()).toBe(true)
    markSaved('other-form')
    expect(typedWork()).toBe(false)
    noteChange(el({ value: 'base' }))
    noteRoute('#/models')
    expect(typedWork()).toBe(false)
  })

  it('the merge path: resolutions picked, Apply cancelled, then a new build and a failed overlay: "Save or copy your work", no reload', async () => {
    noteRoute('#/')
    noteRoute('#/code/ws1')
    noteChange(el({ value: 'ours', scope: 'merge-resolution' })) // Resolution for src/a.ts
    noteChange(el({ value: 'delete', scope: 'merge-resolution' })) // Resolution for src/b.ts
    // Apply asks to confirm; the person cancels: nothing calls markSaved
    const shown: UpdateNotice[] = []
    let reloads = 0
    const r = createChunkRecovery({
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      pageBuild: 'index-A.js',
      fetchBuild: async () => 'index-B.js',
      unsaved: unsavedWork,
      now: () => 0,
      reload: () => void reloads++,
      show: (n) => void shown.push(n),
    })
    expect(await r.handle(new TypeError('Failed to fetch dynamically imported module: https://x/assets/StopAll-1.js'))).toBe('unsaved')
    expect(reloads).toBe(0)
    markSaved('merge-resolution') // a successful Apply
    expect(typedWork()).toBe(false)
    noteRoute('#/')
  })
})

describe('an app that reports unsaved edits (app-dirty from its frame) holds back the reload (stand-in r4 P1)', () => {
  it('app-dirty, then a new build and a failed overlay: "Save or copy your work", no reload; clean again releases it', async () => {
    noteRoute('#/program/omegadesign')
    // ProgramPage puts the frame's app-dirty in the shared registry (useUnsaved(unsaved)), which marks it like this
    markUnsaved('program-page-app', true)
    const shown: UpdateNotice[] = []
    let reloads = 0
    const store = new Map<string, string>() // sessionStorage: a reload toward a new build needs a guard it can write
    const env = {
      storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
      pageBuild: 'index-A.js',
      fetchBuild: async () => 'index-B.js',
      unsaved: unsavedWork,
      now: () => 0,
      reload: () => void reloads++,
      show: (n: UpdateNotice) => void shown.push(n),
    }
    expect(await createChunkRecovery(env).handle(new TypeError('Failed to fetch dynamically imported module: https://x/assets/StopAll-1.js'))).toBe('unsaved')
    expect(reloads).toBe(0)
    markUnsaved('program-page-app', false) // the app saved (or its frame was disposed)
    expect(await createChunkRecovery(env).handle(new TypeError('Failed to fetch dynamically imported module: https://x/assets/StopAll-1.js'))).toBe('updating')
    expect(reloads).toBe(1)
    noteRoute('#/')
  })
})

describe('the forms that keep their fields to themselves register explicitly too', () => {
  it('CreateFlow, ProfilePage’s AddKey, LaunchSwarm (every step) and ProgramPage (its app’s edits) mark themselves unsaved', async () => {
    const fsName = 'node:fs'
    const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8')
    expect(read('../features/create/CreateFlow.tsx')).toContain('useUnsaved(!!name.trim() || !!persona.trim() || step > 0)')
    expect(read('../features/keys/ProfilePage.tsx')).toContain('useUnsaved(!!secret.trim() || !!label.trim())')
    expect(read('../features/launch/LaunchSwarm.tsx')).toContain('useUnsaved(!made && (!!name.trim() || !!purpose.trim() || step > 0))')
    expect(read('../features/programs/ProgramPage.tsx')).toContain('useUnsaved(unsaved)')
    const merge = read('../features/code/MergePanel.tsx')
    expect(merge).toContain('useUnsaved(Object.values(drafts).some((d) => !!d.choice || !!d.content))')
    expect(merge).toContain("markSaved('merge-resolution')")
    expect(merge).toContain('data-unsaved-scope="merge-resolution"')
    for (const f of ['GitExportPanel', 'SymbolicPanel', 'DebuggerPanel']) expect(read(`../features/code/${f}.tsx`)).toContain('useUnsaved(!!pending)')
    // a file picked but not yet stored or imported (stand-in r6)
    const assets = read('../features/assets/AssetsPage.tsx')
    expect(assets).toContain('useUnsaved(!!file)')
    expect(assets).toContain("markSaved('asset-upload')")
    expect(assets).toContain('data-unsaved-scope="asset-upload"')
    const move = read('../features/minds/MoveMind.tsx')
    expect(move).toContain('useUnsaved(!!file)')
    expect(move).toContain("markSaved('mind-import')")
    expect(move).toContain('data-unsaved-scope="mind-import"')
    // the search and suggestion surfaces opt out of choice tracking
    for (const f of ['../features/ask/ClassicAsk.tsx', '../features/ask/StillLine.tsx', '../experiences/still/Ask.tsx', '../experiences/professional/Ask.tsx', '../experiences/construct/CommandLine.tsx', '../features/palette/CommandPalette.tsx', '../experiences/canvas/overlays.tsx', '../features/programs/AppPicker.tsx']) {
      expect(read(f)).toMatch(/role="listbox"[^>]*data-unsaved-ignore=""|data-unsaved-ignore=""[^>]*role="listbox"|role="listbox"[\s\S]{0,120}data-unsaved-ignore=""/)
    }
  })
})
