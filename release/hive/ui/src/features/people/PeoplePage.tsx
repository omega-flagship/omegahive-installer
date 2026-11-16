import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Invite, Person } from '../../api/client'
import { experienceById } from '../../experiences/registry'
import { currentEpoch, onIdentityChange } from '../../lib/identityEpoch'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { actionFailure, has, need, useResource } from '../../lib/useResource'
import { Screen, type ScreenHost, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { ConfirmHost } from '../../ui/confirm'
import { Page } from '../../ui/Page'
import { clearGoogleSignIn } from './clearGoogle'
import { peopleScreen, type Can, type FreshInvite } from './data'
import { passwordAct, removeQuestion, resetQuestion, shownFrom, type ShownPassword } from './memberPassword'
import { InviteForm, MemberForm } from './PeopleForms'

const scopeOf = (item: ScreenItem): string[] => (Array.isArray(item.scope) ? item.scope.map(String) : [])

/**
 * #/people: who is in this hive, and invitations by email (admins). The page, each person and the hive operator are
 * atoms (people.metta) that MeTTa composes for the look being worn; this page loads the people, states the facts, and
 * carries out a press. Its islands (the two forms) are in PeopleForms.tsx.
 */
export default function PeoplePage() {
  const epoch = useSyncExternalStore(onIdentityChange, currentEpoch, currentEpoch)
  return <PeoplePageBody key={epoch} />
}

function PeoplePageBody() {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const look = experienceById(useLook().current?.experience).id
  const [fresh, setFresh] = useState<FreshInvite | null>(null)
  const [shown, setShown] = useState<(ShownPassword & { instance: number; copied: boolean }) | null>(null)
  const passwordInstance = useRef(0)
  const showPassword = (value: ShownPassword) => setShown({ ...value, instance: ++passwordInstance.current, copied: false })
  const res = useResource(() => need(client, 'listPeople', 'The people list')(), { isEmpty: () => false })
  const meRes = useResource(() => need(client, 'me')(), { isEmpty: () => false })
  const { admin } = useMe()
  const selfId = meRes.data?.person?.id ?? null
  const can = useMemo<Can>(() => ({
    invite: has(client, 'invite'),
    addMember: has(client, 'addMember'),
    revokeInvite: has(client, 'revokeInvite'),
    updatePerson: has(client, 'updatePerson'),
    clearGoogle: has(client, 'clearGoogleIdentity'),
    resetPassword: has(client, 'resetMemberPassword'),
    removePassword: has(client, 'removeMemberPassword'),
  }), [client])

  const compose = useCompose(look)
  const { plan, data } = useMemo(() => {
    const { data, facts } = peopleScreen(res, { admin, selfId }, can, { invite: fresh, password: shown }, {}, compose)
    return { plan: compose('people', facts), data }
  }, [res, admin, selfId, can, fresh, shown, compose])

  const personOf = (item: ScreenItem): Person | undefined => {
    const [id] = scopeOf(item)
    return res.data?.people.find((p) => p.id === id)
  }

  /** Every change goes through here: a missing method says so, and only a confirmed change toasts success. */
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn()
      if (ok) toast({ tone: 'success', title: ok })
      res.reload()
    } catch (e) {
      toast(actionFailure(e, 'That did not work'))
    }
  }
  // bound to the identity it was asked under: no PATCH, toast or reload once the sign-in changes (clearGoogle.ts)
  const clearGoogle = (p: Person) => clearGoogleSignIn(p, { admin, clear: client?.clearGoogleIdentity?.bind(client), show: toast, reload: res.reload })
  /** Reset or remove a member's password: asked first, then shown (reset) or toasted, under the identity that asked. */
  const resetPassword = (p: Person) =>
    void passwordAct(() => need(client, 'resetMemberPassword', 'Member passwords')(p.id), {
      question: { text: resetQuestion(p), label: p.password_set ? 'Make a new password' : 'Make a password' },
      onDone: (r) => (showPassword(shownFrom(r, 'reset')), res.reload()),
      onFail: (e) => toast(actionFailure(e, 'Could not make a password')),
    })
  const removePassword = (p: Person) =>
    void passwordAct(() => need(client, 'removeMemberPassword', 'Member passwords')(p.id), {
      question: { text: removeQuestion(p), label: 'Remove password' },
      onDone: () => (toast({ tone: 'success', title: `${p.name || p.email} no longer has a password` }), res.reload()),
      onFail: (e) => toast(actionFailure(e, 'Could not remove the password')),
    })

  const host: ScreenHost = {
    data,
    framed: true,
    islands: {
      'invite-form': <InviteForm onCreated={(inv: Invite & { link: string }) => (setFresh({ ...inv, copied: false }), res.reload())} />,
      'member-form': <MemberForm onCreated={(r) => (showPassword(r), res.reload())} />,
    },
    onOpen: (target, item) => {
      if (target === 'withdraw') void act(() => need(client, 'revokeInvite', 'Withdrawing invitations')(String(item.id)), 'Invitation withdrawn')
    },
    onAction: (action, item) => {
      if (action === 'retry') return res.reload()
      if (action === 'copy-password') {
        const pw = shown
        if (pw) void navigator.clipboard?.writeText(pw.password).then(() => setShown((s) => (s && s.instance === pw.instance ? { ...s, copied: true } : s)))
        return
      }
      if (action === 'hide-password') return setShown(null)
      if (action === 'copy-link') {
        const inv = fresh
        if (inv) void navigator.clipboard?.writeText(inv.link).then(() => setFresh((f) => (f && f.id === inv.id ? { ...f, copied: true } : f)))
        return
      }
      if (action === 'dismiss-link') return setFresh(null)
      if (action === 'email-invite') {
        const mail = data['invite.mail']
        if (typeof mail === 'string') window.location.href = mail
        return
      }
      const p = personOf(item)
      if (!p) return
      const whom = p.name || p.email
      if (action === 'set-role' && (item.value === 'admin' || item.value === 'member')) {
        const role = item.value
        void act(() => need(client, 'updatePerson', 'Changing roles')(p.id, { role }), `${whom} is now ${role === 'admin' ? 'an admin' : 'a member'}`)
      } else if (action === 'toggle-access') {
        void act(() => need(client, 'updatePerson', 'Removing people')(p.id, { disabled: !p.disabled }), p.disabled ? 'Access restored' : `${whom} removed; signed out everywhere`)
      } else if (action === 'clear-google') void clearGoogle(p)
      else if (action === 'reset-password') resetPassword(p)
      else if (action === 'remove-password') removePassword(p)
    },
  }

  return (
    <Page title="People" eyebrow="Invite only" label="People" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-3xl px-4 pt-2 pb-12 md:px-6">
        <Screen plan={plan} host={host} />
      </div>
      <ConfirmHost />
    </Page>
  )
}
