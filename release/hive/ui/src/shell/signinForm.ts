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

/**
 * acceptance-tests #15: who the hive's own Google sign-in lets in, said on the card. `line`: Google accounts at the
 * listed domains, or any on a public hive, and how anyone else gets in (an admin invites their email). `inviteOnly`:
 * Google lets in only those invited. null where the hive does not say (older hives) or offers no Google sign-in: the
 * card stays as it was.
 */
export interface SigninWho {
  line: string
  inviteOnly: boolean
}

export function signinWho(sso: Pick<AuthMethods['sso'], 'enabled' | 'login_url' | 'domains' | 'open'>): SigninWho | null {
  if (!sso.enabled || !sso.login_url || sso.open === undefined || sso.domains === undefined) return null
  if (sso.open) return { line: 'Any Google account can sign in.', inviteOnly: false }
  const ask = 'Anyone else needs an invitation: ask one of this hive’s admins to invite your email.'
  const d = sso.domains
  if (d.length === 1) return { line: `Anyone with a ${d[0]} Google account can sign in. ${ask}`, inviteOnly: false }
  if (d.length > 1) {
    const listed = `${d.slice(0, -1).join(', ')} or ${d[d.length - 1]}`
    return { line: `Anyone with a Google account at ${listed} can sign in. ${ask}`, inviteOnly: false }
  }
  return { line: 'This hive is invite only: ask one of its admins to invite your email.', inviteOnly: true }
}
