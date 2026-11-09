import { expect, it } from 'vitest'
import { readCapabilities } from './ask'

it.each([undefined, null, false, 'true', 1, {}, []])('does not advertise code.test from a missing or malformed value: %j', value => {
  expect(readCapabilities({ conductor: true, memory: false, code_test_intents: value })?.code_test_intents === true).toBe(false)
})
it('preserves only literal true support from the host advertisement', () => {
  expect(readCapabilities({ conductor: false, memory: false, code_test_intents: true })?.code_test_intents).toBe(true)
})
