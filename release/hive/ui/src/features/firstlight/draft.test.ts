/**
 * What a person typed on First Light's card and did not save is shown again when the card reopens (the Finish setup
 * nudge, Meet your mind), for their own sign-in only: a sign-in is the client instance and its session (readContext),
 * so another client reads nothing, and nothing is kept once nothing is left unsaved.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { useHive } from '../../store/store'
import { flDraft, keepFlDraft } from './store'

const before = useHive.getState()
afterEach(() => {
  keepFlDraft(null)
  useHive.setState(before, true)
})

describe('what a person typed and did not save', () => {
  it('is kept for their sign-in and read by no other', () => {
    useHive.setState({ client: {} as never })
    keepFlDraft({ name: 'Wren', purpose: null, month: '20' })
    expect(flDraft()).toEqual({ name: 'Wren', purpose: null, month: '20' })
    useHive.setState({ client: {} as never })
    expect(flDraft()).toBeNull()
  })

  it('is dropped once nothing is left unsaved', () => {
    useHive.setState({ client: {} as never })
    keepFlDraft({ name: 'Wren', purpose: 'Plan the garden.', month: null })
    keepFlDraft({ name: null, purpose: null, month: null })
    expect(flDraft()).toBeNull()
  })
})
