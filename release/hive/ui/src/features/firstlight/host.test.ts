import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import { useHive } from '../../store/store'
import { bindOperation, OperationStopped, stopped } from '../../lib/boundOperation'
import { ASK_HOW_MAX, DEFAULT_ASK_PURPOSE, asRefusal, askPurposeValue, askToSave, cleanWords, liveHost, personaEditable, readPersonApp, startApp, type BoundWrite, type FlClient } from './host'

const open: BoundWrite = (send) => send()

const app = (over: Record<string, unknown> = {}) => ({ id: 'talk', name: 'Your assistant', enabled: true, placement: 'person', ui: true, error: null, app: { tagline: 'Talk every day' }, ...over })

describe('U1 exact personal-mind profile reader', () => {
  it('requires the requested ID and whole persona, returns actual model or unknown, and never uses a different agent', async () => {
    const sent: string[] = []
    const persona = 'Whole\n' + 'x'.repeat(900)
    let body: unknown = { id: 'a_m', name: 'Wren', persona, model: 'host/model' }
    const h = liveHost({ getAgent: async (id) => { sent.push(id); return body } }, () => 0)
    expect(await h.profile!('a_m')).toEqual({ id: 'a_m', name: 'Wren', persona, model: 'host/model' })
    body = { id: 'a_m', name: 'Wren', persona: '', model: null }
    expect(await h.profile!('a_m')).toEqual({ id: 'a_m', name: 'Wren', persona: '', model: null })
    for (const bad of [{ id: 'a_other', name: 'Wren', persona: '', model: 'x' }, { id: 'a_m', name: 'Wren', persona: null, model: 'x' }, { id: 'a_m', name: '', persona: '', model: 'x' }]) {
      body = bad
      await expect(h.profile!('a_m')).rejects.toBeInstanceOf(Error)
    }
    expect(sent).toEqual(Array(5).fill('a_m'))
  })
})

describe('typed client stops survive ordinary host error conversion', () => {
  for (const [at, expected] of [
    ['rename', ['rename']],
    ['persona', ['rename', 'persona']],
    ['prefs', ['rename', 'persona', 'prefs']],
  ] as const) {
    it(`rejects the actual ApiError(identity_changed) at ${at}, sending no later step`, async () => {
      const error = new ApiError(0, 'identity_changed', 'Earlier sign-in answer')
      const sent: string[] = []
      const c: FlClient = {
        renameMyMind: async (name) => {
          sent.push('rename')
          if (at === 'rename') throw error
          return { mind: { id: 'a_m', name, status: 'asleep' } }
        },
        patchAgent: async () => {
          sent.push('persona')
          if (at === 'persona') throw error
          return { id: 'a_m' }
        },
        setAskSettings: async () => {
          sent.push('prefs')
          if (at === 'prefs') throw error
          return {}
        },
      }
      const op = bindOperation()
      await expect(liveHost(c, () => 0).saveAsk('a_m', { name: 'Wren', how: 'Kind.' }, (send) => op.write(send))).rejects.toBe(error)
      expect(stopped(error)).toBe(true)
      expect(sent).toEqual(expected)
    })
  }

  it('conversion rethrows the identical typed stop while ordinary errors remain refusals', () => {
    for (const error of [new ApiError(0, 'identity_changed', 'Earlier sign-in answer'), new OperationStopped()]) {
      let caught: unknown
      try { asRefusal(error) } catch (e) { caught = e }
      expect(caught).toBe(error)
      expect(stopped(caught)).toBe(true)
    }
    const ordinary = asRefusal(new ApiError(403, 'person_required', 'No'))
    expect(ordinary).toMatchObject({ status: 403, code: 'person_required' })
    expect(stopped(ordinary)).toBe(false)
  })
})

describe('R3 host: apps ready for the person, and their Ask', () => {
  it('keeps only usable person apps from the list (enabled, person placement, own interface, no error)', () => {
    expect(readPersonApp(app())).toEqual({ id: 'talk', name: 'Your assistant', tagline: 'Talk every day' })
    for (const bad of [app({ enabled: false }), app({ placement: 'swarm' }), app({ ui: false }), app({ error: 'refused' }), app({ id: 'bad id' }), app({ name: '' }), null, 'x'])
      expect(readPersonApp(bad)).toBeNull()
  })

  it('an app is ready only when the host says it is installed for this person; the host’s order is kept', async () => {
    const calls: string[] = []
    const c: FlClient = {
      programs: async () => [app({ id: 'notes', name: 'Notes', app: {} }), app({ id: 'studio', name: 'Studio' }), app()],
      programInstall: async (id) => {
        calls.push(id)
        if (id === 'studio') throw Object.assign(new Error('no'), { status: 403, code: 'not_available_to_you' })
        return { program: id, placement: 'person', installed: true }
      },
    }
    const apps = await liveHost(c, () => 0).apps()
    expect(apps.map((a) => a.id)).toEqual(['notes', 'talk'])
    expect(calls.sort()).toEqual(['notes', 'studio', 'talk'])
    // the app to talk in is the first ready one: hive code names no app
    expect(startApp(apps)?.id).toBe('notes')
    expect(startApp([])).toBeNull()
  })

  it('an app not installed for this person is left out', async () => {
    const c: FlClient = { programs: async () => [app()], programInstall: async () => ({ program: 'talk', placement: 'person', installed: false }) }
    expect(await liveHost(c, () => 0).apps()).toEqual([])
  })

  it('saving the Ask: the name on the person’s own mind, then the persona, then the Ask prefs as they stand', async () => {
    const calls: string[] = []
    const c: FlClient = {
      renameMyMind: async (name) => (calls.push(`rename:${name}`), { mind: { id: 'a_m', name, status: 'asleep' } }),
      patchAgent: async (id, body) => (calls.push(`patch:${id}:${JSON.stringify(body)}`), { id }),
      setAskSettings: async (body) => (calls.push(`ask:${JSON.stringify(body)}`), {}),
    }
    const host = liveHost(c, () => 0)
    expect(await host.saveAsk('a_m', { name: 'Wren', how: 'Warm.' }, open)).toEqual({ id: 'a_m', name: 'Wren', status: 'asleep' })
    expect(calls).toEqual(['rename:Wren', 'patch:a_m:{"persona":"Warm."}', 'ask:{}'])
    calls.length = 0
    await host.saveAsk('a_m', { name: 'Wren', how: null }, open)
    expect(calls).toEqual(['rename:Wren', 'ask:{}'])
  })

  it('a different mind answering the rename is refused, and nothing more is written', async () => {
    const calls: string[] = []
    const c: FlClient = {
      renameMyMind: async (name) => ({ mind: { id: 'a_other', name, status: 'asleep' } }),
      patchAgent: async () => (calls.push('patch'), {}),
    }
    await expect(liveHost(c, () => 0).saveAsk('a_m', { name: 'Wren', how: 'Warm.' }, open)).rejects.toMatchObject({ code: 'mind_changed' })
    expect(calls).toEqual([])
  })

  it('the person’s words are plain text: control characters out, spaces folded, cut to length', () => {
    expect(cleanWords('  Wren\u0000\n  the\tkind ', 40)).toBe('Wren the kind')
    expect(cleanWords('   ', 40)).toBeNull()
    expect(cleanWords('a'.repeat(50), 40)).toHaveLength(40)
  })

  it('each write is bound on its own: a sign-in change after any step sends nothing more (stand-in R3.1 P1)', async () => {
    const bump = () => useHive.setState((st) => ({ inits: st.inits + 1 }))
    for (const [after, how, expected] of [['rename', 'Warm.', ['rename']], ['rename', null, ['rename']], ['persona', 'Warm.', ['rename', 'persona']]] as const) {
      const sent: string[] = []
      const c: FlClient = {
        renameMyMind: async (name) => (sent.push('rename'), after === 'rename' && bump(), { mind: { id: 'a_m', name, status: 'asleep' } }),
        patchAgent: async () => (sent.push('persona'), after === 'persona' && bump(), {}),
        setAskSettings: async () => (sent.push('ask'), {}),
      }
      const op = bindOperation()
      const e = await liveHost(c, () => 0).saveAsk('a_m', { name: 'Wren', how }, (send) => op.write(send)).catch((x: unknown) => x)
      expect(stopped(e), `${after}/${how}`).toBe(true)
      expect(sent, `${after}/${how}`).toEqual(expected)
    }
  })

  it('a refused Ask-prefs record does not fail the save, but a stop is never swallowed', async () => {
    const c: FlClient = {
      renameMyMind: async (name) => ({ mind: { id: 'a_m', name, status: 'asleep' } }),
      setAskSettings: async () => { throw Object.assign(new Error('no'), { status: 403, code: 'person_required' }) },
    }
    expect((await liveHost(c, () => 0).saveAsk('a_m', { name: 'Wren', how: null }, open)).name).toBe('Wren')
  })

  it('the persona is offered for editing only when it fits whole on one line; how is saved only when edited', () => {
    expect(personaEditable('Kind.')).toBe(true)
    expect(personaEditable('')).toBe(true)
    expect(personaEditable(null)).toBe(false)
    expect(personaEditable('a'.repeat(ASK_HOW_MAX + 1))).toBe(false)
    expect(personaEditable('two\nlines')).toBe(false)
    expect(askToSave('Wren', null, 'Kind.')).toEqual({ name: 'Wren', how: null }) // not edited: left alone
    expect(askToSave('Wren', 'Kind.', 'Kind.')).toEqual({ name: 'Wren', how: 'Kind.' }) // edited (even back to the same)
    expect(askToSave('Wren', 'Short.', 'two\nlines')).toEqual({ name: 'Wren', how: null }) // never over a persona it could not show whole
  })

  it('the persona is read whole, never cut', async () => {
    const long = 'x'.repeat(900)
    expect(await liveHost({ getAgent: async () => ({ id: 'a_m', persona: long }) }, () => 0).askHow('a_m')).toBe(long)
  })

  it('offers the exact editable purpose only for known empty words, and explicit Save adopts it', () => {
    expect(DEFAULT_ASK_PURPOSE).toBe('Help me and my family improve our lives.')
    expect(askPurposeValue('')).toBe(DEFAULT_ASK_PURPOSE)
    expect(askToSave('Wren', null, '')).toEqual({ name: 'Wren', how: DEFAULT_ASK_PURPOSE })
    expect(askPurposeValue(null)).toBe('')
    expect(askToSave('Wren', null, null)).toEqual({ name: 'Wren', how: null })
    expect(askToSave('Wren', 'A proposed edit', null).how).toBeNull()
  })

  it('keeps an intentional edit or clear instead of restoring the default', () => {
    expect(askToSave('Wren', 'Help with our garden.', '').how).toBe('Help with our garden.')
    expect(askToSave('Wren', '', '').how).toBe('')
    expect(askToSave('Wren', '', 'Kind.').how).toBe('')
  })

  it('preserves every existing persona whole on name-only Save, including long and multiline words', () => {
    for (const current of ['Existing purpose.', 'x'.repeat(900), 'two\nlines']) {
      expect(askPurposeValue(current)).toBe(current)
      expect(askToSave('Wren', null, current)).toEqual({ name: 'Wren', how: null })
    }
  })

  it('distinguishes a known empty read from missing, malformed, foreign or failed answers', async () => {
    expect(await liveHost({ getAgent: async () => ({ id: 'a_m', persona: '' }) }, () => 0).askHow('a_m')).toBe('')
    for (const answer of [{ id: 'a_other', persona: '' }, { id: 'a_m' }, { id: 'a_m', persona: null }, {}]) {
      await expect(liveHost({ getAgent: async () => answer }, () => 0).askHow('a_m')).rejects.toMatchObject({ code: 'unreadable' })
    }
    await expect(liveHost({ getAgent: async () => { throw new Error('offline') } }, () => 0).askHow('a_m')).rejects.toMatchObject({ code: 'network' })
  })
})
