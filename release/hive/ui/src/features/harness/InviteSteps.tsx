import { useState } from 'react'
import type { HarnessInviteRow, HarnessRefusal } from '../../api/missingUi'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { plural } from '../../lib/plural'
import { Icon } from '../../ui/Icon'
import { Segmented } from '../../ui/primitives'
import { CODE_PLACEHOLDER, HARNESS_TITLE, heldJoining, joinSteps, pageMcpUrl, refusalGroups, refusalWords, starter, TOKEN_PLACEHOLDER, type Harness } from './joinSteps'

/**
 * A waiting invitation's setup, wherever the invitation is shown: what to paste into the agent and what to tell it.
 * The steps carry the join code while this page holds it. Otherwise they show where the code goes, with the URL this
 * page reaches the hive at, and say plainly that the hive cannot show the code again and what to do instead.
 */
export function InviteSteps({ invite }: { invite: Pick<HarnessInviteRow, 'id' | 'harness' | 'harness_label' | 'name'> }) {
  const joining = heldJoining(invite.id)
  const [where, setWhere] = useState<'anywhere' | 'mac'>('anywhere')
  const [copied, setCopied] = useState<string | null>(null)
  const url = (where === 'mac' && joining?.local_url) || joining?.mcp_url || pageMcpUrl()
  const steps: { label: string; text: string; wrap?: boolean }[] = [...joinSteps(invite.harness, url, joining?.code ?? CODE_PLACEHOLDER), { label: 'Then tell it', text: starter(invite.name), wrap: true }]
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600)
    })
  }
  return (
    <div className="space-y-3" data-invite-steps={invite.id}>
      {!joining && (
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          The join code was shown once, when this invitation was made. The hive does not keep a copy, so it cannot show the code again. If you saved it, use it where the steps say {CODE_PLACEHOLDER}. If not, withdraw this invitation and invite {shown(invite.name)} again for a new code.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] text-ink-2">Paste this into {invite.harness_label}:</span>
        {joining?.local_url && <Segmented value={where} onChange={setWhere} label="Where it runs" dense options={[{ value: 'anywhere', label: 'Anywhere' }, { value: 'mac', label: 'On the hive’s Mac' }]} />}
      </div>
      {steps.map((s, i) => (
        <Snippet key={i} label={s.label} text={s.text} copied={copied === `s${i}`} onCopy={() => copy(`s${i}`, s.text)} wrap={s.wrap} />
      ))}
      {joining && (
        <p className="text-[12px] text-ink-4">
          The code is a key: send it only to the agent you are inviting. The hive does not keep a copy, so once this page reloads or you sign out it cannot be shown again. If it leaks before it is used, withdraw it and invite again.
        </p>
      )}
    </div>
  )
}

/**
 * How an outside member connects: the program it runs in (Claude Code, Codex, Hermes or any MCP client) reaches this
 * hive's MCP server with the member's token, and answers as the member from then on. The hive cannot start or wake such
 * a member, and it keeps no copy of the token (shown once, when the member was added), so the steps show where the
 * token goes and say what to do when it is lost. A tester pressed Start on one and got "Could not start".
 */
export function MemberSteps({ name }: { name: string }) {
  const [kind, setKind] = useState<Harness>('claude-code')
  const [copied, setCopied] = useState<string | null>(null)
  const steps: { label: string; text: string; wrap?: boolean }[] = [...joinSteps(kind, pageMcpUrl(), TOKEN_PLACEHOLDER, 'token'), { label: 'Then tell it', text: starter(name), wrap: true }]
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600)
    })
  }
  return (
    <div className="space-y-3" data-member-steps>
      <p className="text-[12.5px] leading-relaxed text-ink-2">
        {shown(name)} runs outside this hive: a program such as Claude Code or Codex answers as {shown(name)} once it connects with {shown(name)}’s token. The hive showed the token once, when {shown(name)} was added, and keeps no copy: use it where the steps say {TOKEN_PLACEHOLDER}. If it is lost, delete {shown(name)} and add the agent again from Add an outside agent, or have this hive run it instead (Model).
      </p>
      <Segmented<Harness> value={kind} onChange={setKind} label="Which program it runs in" dense options={(Object.keys(HARNESS_TITLE) as Harness[]).map((k) => ({ value: k, label: HARNESS_TITLE[k] }))} />
      {steps.map((s, i) => (
        <Snippet key={i} label={s.label} text={s.text} copied={copied === `s${i}`} onCopy={() => copy(`s${i}`, s.text)} wrap={s.wrap} />
      ))}
    </div>
  )
}

function Snippet({ label, text, copied, onCopy, wrap }: { label: string; text: string; copied: boolean; onCopy: () => void; wrap?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-shade/30">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <span className="text-[11.5px] text-ink-3">{label}</span>
        <button onClick={onCopy} className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] text-ink-2 hover:bg-tint/[0.06]">
          <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={cx('thin-scroll overflow-x-auto p-3 font-mono text-[12px] leading-relaxed text-ink', wrap && 'whitespace-pre-wrap')}>{text}</pre>
    </div>
  )
}

/**
 * Connections the hive refused since `since`, said plainly where the person waits for an agent: how many, when the
 * last was, why its code did not work and what to do. Nothing when none were refused.
 */
export function Refusals({ refusals, since }: { refusals: readonly HarnessRefusal[]; since: string }) {
  const groups = refusalGroups(refusals, since)
  if (!groups.length) return null
  return (
    <div role="status" className="space-y-1.5 rounded-xl border border-warn/40 bg-warn/[0.06] px-3 py-2 text-[12.5px] leading-relaxed text-ink-2" data-refusals>
      {groups.map((g) => {
        const words = refusalWords({ why: g.why, invite: g.invite && { ...g.invite, name: shown(g.invite.name) } })
        return (
          <p key={`${g.why} ${g.invite?.id ?? ''}`}>
            <span className="font-medium text-warn">{g.count === 1 ? 'A connection was refused' : `${plural(g.count, 'connection')} were refused`}, the last {ago(g.last)}.</span> {words.what} {words.next}
          </p>
        )
      })}
    </div>
  )
}
