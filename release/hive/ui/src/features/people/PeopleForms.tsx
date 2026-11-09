import { useState, type FormEvent } from 'react'
import type { Invite } from '../../api/client'
import { hsl } from '../../lib/color'
import { actionFailure, has, need } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Button, Segmented } from '../../ui/primitives'
import { passwordAct, shownFrom, type ShownPassword } from './memberPassword'

/**
 * The People page's islands (people.metta places each one and decides whether it shows): the invitation form and the
 * form that adds a member with a password. Each holds its own typed fields, a busy state and a submit, which the blocks
 * don't express (the link an invitation makes, and a member's password, are drawn by the reveal block).
 */

export function InviteForm({ onCreated }: { onCreated: (i: Invite & { link: string }) => void }) {
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
    <form onSubmit={submit} className="rounded-2xl border border-line bg-tint/[0.04] p-4" style={{ boxShadow: `0 24px 60px -34px ${hsl(200, 100, 60, 0.6)}` }}>
      <h2 className="font-display text-[17px] font-semibold">Invite a colleague</h2>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <input type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="their Google email" aria-label="Email" className="min-h-11 rounded-xl border border-line bg-shade/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name" maxLength={100} className="min-h-11 rounded-xl border border-line bg-shade/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Segmented value={role} options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} onChange={setRole} label="Role" dense />
        <label className="flex min-h-10 items-center gap-1.5 rounded-xl border border-line bg-shade/25 px-3 text-[12.5px] text-ink-3">
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
      <p className="mt-2 text-[11.5px] text-ink-4">Only that Google account can accept, once. You get a link to send; nothing is emailed from the hive.</p>
    </form>
  )
}

/** Add a member who signs in with a password the hive makes (T-101): until Google sign-in is set up. */
export function MemberForm({ onCreated }: { onCreated: (s: ShownPassword) => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim() || busy) return
    setBusy(true)
    try {
      await passwordAct(() => need(client, 'addMember', 'Adding members')({ email: email.trim(), name: name.trim() || undefined }), {
        onDone: (r) => {
          setEmail('')
          setName('')
          onCreated(shownFrom(r, 'added'))
        },
        onFail: (err) => toast(actionFailure(err, 'Could not add the member')),
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} aria-label="Add a member" className="rounded-2xl border border-line bg-white/[0.04] p-4">
      <h2 className="font-display text-[17px] font-semibold">Add a member with a password</h2>
      <p className="mt-1 text-[11.5px] text-ink-4">Until Google sign-in is set up, a member can sign in with their email and a password the hive makes. You see it once, here.</p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <input type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="their email" aria-label="Member email" className="min-h-11 rounded-xl border border-line bg-black/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Member name" maxLength={100} className="min-h-11 rounded-xl border border-line bg-black/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
      </div>
      <div className="mt-3 flex justify-end">
        <Button type="submit" variant="primary" hue={150} icon={busy ? undefined : 'plus'} disabled={!email.trim() || busy}>
          {busy ? 'Adding…' : 'Add member'}
        </Button>
      </div>
    </form>
  )
}
