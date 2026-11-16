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

/** `members`: the hive reports member_password. `operator`: the person followed the link to the operator's way in. */
export function signinForm(members: boolean, operator: boolean): SigninForm {
  if (members && !operator)
    return {
      label: 'Sign in',
      heading: 'Welcome back',
      line: 'Sign in with your email and the password an admin gave you.',
      email: true,
      passwordPlaceholder: 'Password',
      other: 'Run this hive? Sign in with the hive password',
    }
  return {
    label: 'Operator login',
    heading: 'Welcome back, operator',
    line: 'Enter the hive password to wake the interface.',
    email: false,
    passwordPlaceholder: 'Hive password',
    other: members ? 'Sign in with your email instead' : null,
  }
}
