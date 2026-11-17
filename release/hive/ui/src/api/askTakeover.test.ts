// Purpose: verify the live client gives the page no way to end an Ask turn when the person touches the page.
import { expect, it } from 'vitest'
import { LiveClient } from './live'
// Jon, 17 Nov: "Ask should exist above UI - stop shouldn't happen". The person's use of the page holds the mind's moves on
// the page alone (store/ask personTookOver); the live client has no takeover call to end the turn on the host.
it('the live client has no takeover call: the person\'s use of the page never reaches the host as an end of the turn', () => {
  const client = new LiveClient('https://example.test/omegahive/')
  expect('askTakeover' in client).toBe(false)
})
