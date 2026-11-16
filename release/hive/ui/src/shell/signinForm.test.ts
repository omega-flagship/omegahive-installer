import { describe, expect, it } from 'vitest'
import { signinForm } from './signinForm'

/** The sign-in form's two ways in: a member reads only their own, the operator's is one small link away. */

const words = (f: ReturnType<typeof signinForm>) => [f.label, f.heading, f.line, f.passwordPlaceholder].join(' ')

describe('sign-in form on a hive that takes member passwords', () => {
  it('opens on the member’s way in: email and password, and no word of the operator’s', () => {
    const f = signinForm(true, false)
    expect(f.email).toBe(true)
    expect(f.line).toBe('Sign in with your email and the password an admin gave you.')
    expect(words(f)).not.toMatch(/operator|hive password|no email/i)
  })

  it('keeps the operator’s way in behind one small link', () => {
    expect(signinForm(true, false).other).toBe('Run this hive? Sign in with the hive password')
  })

  it('the link opens the operator’s form: the hive password, no email field, and a link back', () => {
    const f = signinForm(true, true)
    expect(f.email).toBe(false)
    expect(f.label).toBe('Operator login')
    expect(f.line).toBe('Enter the hive password to wake the interface.')
    expect(f.passwordPlaceholder).toBe('Hive password')
    expect(f.other).toBe('Sign in with your email instead')
  })
})

describe('sign-in form on a hive without member passwords', () => {
  it('is the operator’s form, with no link to a way in the hive does not have', () => {
    for (const operator of [false, true]) {
      const f = signinForm(false, operator)
      expect(f).toEqual({ ...signinForm(true, true), other: null })
    }
  })
})
