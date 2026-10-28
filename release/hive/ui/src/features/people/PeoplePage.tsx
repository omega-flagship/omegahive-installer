import { AnimatePresence, m } from 'framer-motion'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { Invite, Person } from '../../api/client'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { ago } from '../../lib/format'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { actionFailure, has, need, useResource, type ResourceState } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button, Orb, Segmented } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'
import { ConfirmHost } from '../../ui/confirm'
import { clearGoogleSignIn, signInWords } from './clearGoogle'

type PeopleData = { people: Person[]; invites: Invite[]; google_ready: boolean }

const pendingOf = (d: PeopleData) => d.invites.filter((i) => i.status === 'pending')

/** People's loading states: "Admins only" strictly on a 403; any other failure is an error with a retry. */
export function PeopleState({ res, children }: { res: ResourceState<PeopleData> & { reload?: () => void }; children: (data: PeopleData) => ReactNode }) {
  return (
    <ResourceView
      res={res}
      errorTitle="Could not load people"
      forbidden={{ icon: 'shield', title: 'Admins only', body: 'Ask an admin of this hive to invite someone.' }}
      unsupported={{ body: 'This hive or the demo does not list people.' }}
    >
      {children}
    </ResourceView>
  )
}

const hueOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)

/** #/people: who is in this hive, and invitations by email (admins). */
export default function PeoplePage() {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [fresh, setFresh] = useState<(Invite & { link: string }) | null>(null)
  const res = useResource(() => need(client, 'listPeople', 'The people list')(), { isEmpty: () => false })
  const meRes = useResource(() => need(client, 'me')(), { isEmpty: () => false })
  const { admin } = useMe()
  const canClearGoogle = admin && has(client, 'clearGoogleIdentity')
  // bound to the identity it was asked under: no PATCH, toast or reload once the sign-in changes (clearGoogle.ts)
  const clearGoogle = (p: Person) => clearGoogleSignIn(p, { admin, clear: client?.clearGoogleIdentity?.bind(client), show: toast, reload: res.reload })

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

  return (
    <Page title="People" eyebrow="Invite only" label="People" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-3xl space-y-8 px-4 pt-2 pb-12 md:px-6">
        <PeopleState res={res}>
          {(data) => (
          <>
            <InviteForm
              ready={data.google_ready}
              onCreated={(inv) => {
                setFresh(inv)
                res.reload()
              }}
            />
            <AnimatePresence>{fresh && <InviteLink key={fresh.id} invite={fresh} onClose={() => setFresh(null)} />}</AnimatePresence>
            {pendingOf(data).length > 0 && (
              <section aria-labelledby="pending-h">
                <h2 id="pending-h" className="eyebrow mb-2">
                  Waiting to accept
                </h2>
                <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
                  {pendingOf(data).map((i) => (
                    <div key={i.id} className="flex items-center gap-3 px-3 py-2.5">
                      <span className="flex size-8 items-center justify-center rounded-full border border-dashed border-line-2 text-ink-3">
                        <Icon name="send" size={14} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] text-ink">{i.name || i.email}</span>
                        <span className="block truncate text-[11.5px] text-ink-4">
                          {i.email} · {i.role} · expires {new Date(i.expires_at * 1000).toLocaleDateString()}
                        </span>
                      </span>
                      {has(client, 'revokeInvite') && (
                        <Button variant="ghost" className="min-h-9 px-3 text-[12.5px] text-ink-3" onClick={() => act(() => need(client, 'revokeInvite', 'Withdrawing invitations')(i.id), 'Invitation withdrawn')}>
                          Withdraw
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section aria-labelledby="people-h">
              <h2 id="people-h" className="eyebrow mb-2">
                In this hive
              </h2>
              <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
                <Row name="Hive operator" sub="Signs in on this hive's own machine" hue={150} role="admin" />
                {data.people.map((p) => (
                  <Row
                    key={p.id}
                    name={p.name || p.email}
                    sub={`${p.email}${p.last_seen_at ? ` · seen ${ago(p.last_seen_at)}` : ' · not signed in yet'}`}
                    hue={hueOf(p.email)}
                    role={p.role}
                    disabled={p.disabled}
                    google={p.google_bound === true}
                    self={meRes.data?.person?.id === p.id}
                    onClearGoogle={canClearGoogle && p.google_bound === true ? () => void clearGoogle(p) : undefined}
                    onRole={has(client, 'updatePerson') ? (role) => act(() => need(client, 'updatePerson', 'Changing roles')(p.id, { role }), `${p.name || p.email} is now ${role === 'admin' ? 'an admin' : 'a member'}`) : undefined}
                    onToggle={has(client, 'updatePerson') ? () => act(() => need(client, 'updatePerson', 'Removing people')(p.id, { disabled: !p.disabled }), p.disabled ? 'Access restored' : `${p.name || p.email} removed; signed out everywhere`) : undefined}
                  />
                ))}
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-ink-4">
                Members use the hive. Admins also invite people, set spending limits and manage the hive's default keys. Removing someone signs them out everywhere at once.
              </p>
            </section>
          </>
          )}
        </PeopleState>
      </div>
      <ConfirmHost />
    </Page>
  )
}

export function Row({ name, sub, hue, role, disabled, google, self, onRole, onToggle, onClearGoogle }: { name: string; sub: string; hue: number; role: string; disabled?: boolean; google?: boolean; self?: boolean; onRole?: (r: 'admin' | 'member') => void; onToggle?: () => void; onClearGoogle?: () => void }) {
  const signIn = signInWords(google)
  return (
    <div className={cx('flex flex-wrap items-center gap-3 px-3 py-2.5', disabled && 'opacity-55')}>
      <Orb hue={hue} size={30} status={disabled ? 'stopped' : 'awake'} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] text-ink">
          {name}
          {self && <span className="ml-1.5 text-[11px] text-ink-4">you</span>}
        </span>
        <span className="block truncate text-[11.5px] text-ink-4">{sub}</span>
        {signIn && <span className="block truncate text-[11.5px] text-ink-3">{signIn}</span>}
      </span>
      {onRole && !self && !disabled ? (
        <Segmented value={role as 'admin' | 'member'} options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} onChange={onRole} label={`Role of ${name}`} dense />
      ) : (
        <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-3 capitalize">{disabled ? 'removed' : role}</span>
      )}
      {onToggle && !self && (
        <Button variant="ghost" className="min-h-9 px-3 text-[12.5px] text-ink-3" onClick={onToggle}>
          {disabled ? 'Restore' : 'Remove'}
        </Button>
      )}
      {onClearGoogle && !self && (
        <Button variant="ghost" className="min-h-9 px-3 text-[12.5px] text-ink-3" onClick={onClearGoogle}>
          Clear Google sign-in
        </Button>
      )}
    </div>
  )
}

function InviteForm({ ready, onCreated }: { ready: boolean; onCreated: (i: Invite & { link: string }) => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [days, setDays] = useState('7')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim() || busy) return
    setBusy(true)
    try {
      const inv = await need(client, 'invite', 'Inviting people')({ email: email.trim(), name: name.trim() || undefined, role, days: Number(days) || 7 })
      setEmail('')
      setName('')
      onCreated(inv)
    } catch (err) {
      toast(actionFailure(err, 'Could not create the invitation'))
    } finally {
      setBusy(false)
    }
  }
  const canInvite = has(client, 'invite')
  return (
    <form onSubmit={submit} className="rounded-2xl border border-line bg-white/[0.04] p-4" style={{ boxShadow: `0 24px 60px -34px ${hsl(200, 100, 60, 0.6)}` }}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-[17px] font-semibold">Invite a colleague</h2>
        {!ready && <span className="text-[11.5px] text-warn">Google sign-in is not set up yet; the link will not work until it is.</span>}
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <input type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="their Google email" aria-label="Email" className="min-h-11 rounded-xl border border-line bg-black/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name" maxLength={100} className="min-h-11 rounded-xl border border-line bg-black/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Segmented value={role} options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} onChange={setRole} label="Role" dense />
        <label className="flex min-h-10 items-center gap-1.5 rounded-xl border border-line bg-black/25 px-3 text-[12.5px] text-ink-3">
          Link valid for
          <select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Days the link stays valid" className="bg-transparent text-ink outline-none">
            {['1', '3', '7', '14', '30'].map((d) => (
              <option key={d} value={d}>
                {d} day{d === '1' ? '' : 's'}
              </option>
            ))}
          </select>
        </label>
        <div className="flex-1" />
        <Button type="submit" variant="primary" hue={200} icon={busy ? undefined : 'send'} disabled={!canInvite || !email.trim() || busy}>
          {busy ? 'Creating…' : 'Create invitation'}
        </Button>
      </div>
      {!canInvite && <p className="mt-2 text-[11.5px] text-warn">Inviting is not available here (this hive or the demo does not send invitations).</p>}
      <p className="mt-2 text-[11.5px] text-ink-4">Only that Google account can accept, once. You get a link to send; nothing is emailed from the hive.</p>
    </form>
  )
}

function InviteLink({ invite, onClose }: { invite: Invite & { link: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const first = (invite.name || '').split(' ')[0]
  const subject = 'An invitation to OmegaHive'
  const body = `${first ? `Hi ${first},\n\n` : ''}I'd like you to join my OmegaHive, a living hive of AI minds.\n\nAccept here with your Google account (${invite.email}):\n${invite.link}\n\nThe link works once and expires ${new Date(invite.expires_at * 1000).toLocaleDateString()}.\n`
  const mailto = `mailto:${encodeURIComponent(invite.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  return (
    <m.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-2xl border border-good/30 bg-good/[0.06] p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[14px] font-medium text-ink">Invitation ready for {invite.email}</div>
          <div className="text-[12px] text-ink-3">Send this link. It is shown only now; create a new invitation if it is lost.</div>
        </div>
        <button onClick={onClose} aria-label="Dismiss" className="flex size-8 items-center justify-center rounded-lg text-ink-3 hover:bg-white/[0.06]">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="mt-3 truncate rounded-xl border border-line bg-black/30 px-3 py-2 font-mono text-[12px] text-ink-2">{invite.link}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="subtle"
          icon={copied ? 'check' : 'copy'}
          onClick={() => {
            void navigator.clipboard?.writeText(invite.link).then(() => setCopied(true))
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        <a href={mailto} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-white/[0.06] px-4 text-sm font-medium text-ink hover:bg-white/[0.1]">
          <Icon name="send" size={18} /> Email it
        </a>
      </div>
    </m.div>
  )
}
