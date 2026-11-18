import type { AuthMethods } from '../api/client'

/**
 * What the password sign-in form shows. A hive that takes member passwords opens on the member's way in, their email
 * and the password an admin gave them, and keeps the operator's way in (the hive password, no email) behind a small
 * link, so a member reads only their own. A hive without member passwords has only the operator's way in.
 */
export interface SigninForm {
  /** The form's accessible name. */
  label: string
  heading: string
  line: string
  /** The form asks for an email: a member signs in with it, the operator never does. */
  email: boolean
  passwordPlaceholder: string
  /** The small link to the other way in, or null where the hive has only one. */
  other: string | null
}

/**
 * The ways in that count where this page was opened, read from the hive's sign-in methods. `google`: Google's address,
 * offered beside the password form only from outside the hive's machine, where people continue with Google and a test
 * account keeps its password. `members`: member passwords count here for someone. `operator`: the hive password
 * counts here, which is never from outside (sso.py), whatever an older hive reports.
 */
export interface SigninWays {
  google: string | null
  members: boolean
  operator: boolean
}

export function signinWays(m: Pick<AuthMethods, 'password' | 'public' | 'member_password' | 'sso'>): SigninWays {
  return {
    google: m.public && m.sso.enabled ? m.sso.login_url : null,
    members: m.member_password === true,
    operator: m.password && !m.public,
  }
}

/** `ways`: what counts here (signinWays). `operator`: the person followed the link to the operator's way in. */
export function signinForm(ways: SigninWays, operator: boolean): SigninForm {
  if (ways.members && !(operator && ways.operator))
    return {
      label: 'Sign in',
      heading: 'Welcome back',
      line: ways.google
        ? 'Or sign in with the email and password an admin gave you.'
        : 'Sign in with your email and the password an admin gave you.',
      email: true,
      passwordPlaceholder: 'Password',
      other: ways.operator ? 'Run this hive? Sign in with the hive password' : null,
    }
  return {
    label: 'Operator login',
    heading: 'Welcome back, operator',
    line: 'Enter the hive password to wake the interface.',
    email: false,
    passwordPlaceholder: 'Hive password',
    other: ways.members ? 'Sign in with your email instead' : null,
  }
}
