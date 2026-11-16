import { describe, expect, it, vi } from 'vitest'
import { askHasWords, emitAskDispatch, focusAskField, noteAskWords, onAskDispatch, onAskWords, ASK_FIELD } from './askField'

vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
const { useHive } = await import('../../store/store')
const { createAskPort } = await import('./askPort')
const signInChange = () => useHive.setState({ inits: useHive.getState().inits + 1 })

/**
 * The Ask port (Ask-and-apps contract R1 §5): a look reaches the one Ask through it, never a selector of its own. Focus
 * finds any skin's field by `data-ask-input` (the old `.ask-root .ask-input` matched Classic's only), skips a disabled
 * field, and sends reach every listener even when one throws. No DOM: a stand-in document.
 */
function fakeDoc(fields: { disabled?: boolean; name: string }[]) {
  const doc = {
    activeElement: null as unknown,
    asked: '' as string,
    querySelectorAll(sel: string) {
      doc.asked = sel
      return fields.map((f) => ({ ...f, focus() { doc.activeElement = this } }))
    },
  }
  return doc
}

describe('focusAskField', () => {
  it('asks for every skin by data-ask-input and focuses the last enabled field', () => {
    const doc = fakeDoc([{ name: 'classic' }, { name: 'command-line' }, { name: 'off', disabled: true }])
    expect(focusAskField(doc as never)).toBe(true)
    expect(doc.asked).toBe(ASK_FIELD)
    expect((doc.activeElement as { name: string }).name).toBe('command-line')
  })
  it('a collapsed Ask: its hidden field is never focused, and asking for the field opens the Ask (askSize.ts)', async () => {
    const { setAskOpener } = await import('./askField')
    // the floating Ask hidden behind its mark: its field sits inside a [hidden] dock
    const hidden = (name: string) => ({ name, closest: (sel: string) => (sel === '[hidden]' ? {} : null) })
    const doc = fakeDoc([hidden('classic') as never])
    expect(focusAskField(doc as never)).toBe(false)
    expect(doc.activeElement).toBeNull()
    const open = vi.fn(() => true)
    setAskOpener(open)
    try {
      expect(focusAskField(doc as never)).toBe(true)
      expect(open).toHaveBeenCalledTimes(1)
      expect(doc.activeElement).toBeNull()
      // a field that is shown wins over opening: an experience's own field (Construct's prompt) is the Ask then
      const both = fakeDoc([hidden('classic') as never, { name: 'command-line' }])
      expect(focusAskField(both as never)).toBe(true)
      expect((both.activeElement as { name: string }).name).toBe('command-line')
      expect(open).toHaveBeenCalledTimes(1)
    } finally {
      setAskOpener(null)
    }
  })
  it('says false with no enabled field, or no document', () => {
    expect(focusAskField(fakeDoc([{ name: 'off', disabled: true }]) as never)).toBe(false)
    expect(focusAskField(fakeDoc([]) as never)).toBe(false)
    expect(focusAskField(null)).toBe(false)
  })
})

describe('onAskDispatch', () => {
  it('every listener hears each send; one that throws stops nothing; unsubscribe works', () => {
    const heard: string[] = []
    const offA = onAskDispatch((d) => heard.push('a:' + d.you))
    const offBad = onAskDispatch(() => { throw new Error('a look failed') })
    const offB = onAskDispatch((d) => heard.push('b:' + d.you + (d.steering ? '+' : '')))
    emitAskDispatch({ you: 'hello', steering: false })
    offA()
    emitAskDispatch({ you: 'again', steering: true })
    offBad(); offB()
    emitAskDispatch({ you: 'nobody', steering: false })
    expect(heard).toEqual(['a:hello', 'b:hello', 'b:again+'])
  })
})

describe('the Ask port belongs to one identity (contract R1.1 #2)', () => {
  it('A→B→A: a kept port is dead after a change; its listeners are dropped in the change; a new port works', () => {
    const doc = fakeDoc([{ name: 'field' }])
    const portA = createAskPort('classic', doc as never)
    const heard: string[] = []
    portA.onDispatch((d) => heard.push('A:' + d.you))
    expect(portA.alive()).toBe(true)
    emitAskDispatch({ you: 'one', steering: false })
    // B
    signInChange()
    expect(portA.alive()).toBe(false)
    expect(portA.focus()).toBe(false)
    // never fills the next person's field
    expect(portA.type('words for A')).toBe('none')
    expect(portA.hasWords()).toBe(false)
    emitAskDispatch({ you: 'B speaks', steering: false })
    expect(portA.onDispatch(() => heard.push('late'))).toBeTypeOf('function')
    // A again: a new sign-in, the old port stays dead
    signInChange()
    emitAskDispatch({ you: 'A again', steering: false })
    expect(portA.alive()).toBe(false)
    expect(heard).toEqual(['A:one'])
    const portA2 = createAskPort('classic', doc as never)
    expect(portA2.focus()).toBe(true)
  })
})

describe('the Ask holds words, as a signal (listening, contract R1.1 §6)', () => {
  it('notifies on a change only, and reads back', () => {
    let n = 0
    const off = onAskWords(() => n++)
    noteAskWords(false)
    noteAskWords(true)
    noteAskWords(true)
    expect(askHasWords()).toBe(true)
    noteAskWords(false)
    off()
    noteAskWords(true)
    expect(n).toBe(2)
    noteAskWords(false)
  })
})
