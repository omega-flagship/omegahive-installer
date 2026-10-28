import { useState, type ReactNode } from 'react'
import { shown } from '../../lib/displayName'
import { navigate, type Route } from '../../lib/router'
import { need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import type { IconName } from '../../ui/iconPaths'
import { Page } from '../../ui/Page'
import { Button } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'
import { HivePlacement } from '../minds/MoveMind'
import { AskAudit } from './AskAudit'
import { RegisteredServices } from './RegisteredServices'
import { GoogleConnectorAdminSettings } from './GoogleConnectorSettings'

/** One place for how this hive is set up. Reads are a no-secrets summary; the one action here is password rotation,
 *  which the admin triggers and sees once. Everything else links to the page that owns it. */

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white/[0.02] p-4">
      <h2 className="eyebrow pb-3">{title}</h2>
      <div className="space-y-2.5 text-[13.5px]">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="w-40 shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 text-ink">{children}</span>
    </div>
  )
}

const LINKS: { label: string; body: string; icon: IconName; route: Route }[] = [
  { label: 'Models and keys', body: 'Providers, API keys, which model each mind uses', icon: 'cpu', route: { name: 'models' } },
  { label: 'Spending limits', body: 'Hive, swarm and mind budgets', icon: 'chart', route: { name: 'usage' } },
  { label: 'People and invites', body: 'Who can use this hive, and their roles', icon: 'people', route: { name: 'people' } },
  { label: 'Updates', body: 'App and platform updates, holds and history', icon: 'replay', route: { name: 'updates' } },
  { label: 'Roles', body: 'Job descriptions and skill rules for minds', icon: 'roles', route: { name: 'roles' } },
  { label: 'Approval rules', body: 'What minds may do without asking', icon: 'rules', route: { name: 'approvals', tab: 'rules' } },
  { label: 'Files and storage', body: 'Files minds and people stored, where they are kept', icon: 'database', route: { name: 'assets' } },
  { label: 'Artifacts and findings', body: 'What minds and apps produced, across the hive', icon: 'layers', route: { name: 'artifacts' } },
]

export default function SettingsPage() {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const programs = useHive((s) => s.programs)
  const appName = (id: string) => shown(programs?.find((p) => p.id === id)?.name ?? id)
  const toast = useHive((s) => s.toast)
  const res = useResource(() => need(client, 'settings', 'Settings')(), {})
  const [confirming, setConfirming] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)
  const swarmName = (id: string) => shown(swarms[id]?.name) || id

  const rotate = async () => {
    try {
      const r = await client!.rotatePassword!()
      setFresh(r.password)
      setConfirming(false)
    } catch (e) {
      toast({ tone: 'error', title: 'Password not changed', body: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Page title="Settings" eyebrow="This hive" label="Settings">
      <div className="mx-auto max-w-3xl space-y-4 px-3 pb-8 md:px-6">
        <ResourceView res={res} errorTitle="Could not load settings" unsupported={{ body: 'This hive does not report its settings yet.' }}
          forbidden={{ title: 'Admins only', body: 'Only a hive admin can see how the hive is set up.' }}>
          {(s) => (
            <>
              <Section title="Hive">
                <Row label="Name">{s.hive.name}</Row>
                <Row label="Running build"><span className="font-mono">{s.hive.build?.slice(0, 10) ?? 'unknown'}</span></Row>
                <Row label="Started">{new Date(s.hive.started_at).toLocaleString()}</Row>
                <Row label="Restarts itself on update">{s.hive.supervised ? 'Yes (supervised)' : 'No: restart it from its host'}</Row>
                {s.hive.base_paths.length > 0 && <Row label="Public paths">{s.hive.base_paths.map((b) => `${b}/`).join(', ')}</Row>}
              </Section>

              <Section title="Sign-in">
                <Row label="Webhost Google sign-in">{s.signin.family_google ? 'On: the everyday way in' : 'Off'}</Row>
                <Row label="Hive's own Google sign-in">
                  {s.signin.hive_google.configured ? 'Google client set' : 'Not configured'}
                  <span className="block text-[12px] text-ink-4">
                    Used by invite links. Register <span className="font-mono">{s.signin.hive_google.callback_path}</span> as an authorised
                    redirect in Google Cloud, or invitations cannot sign anyone in.
                  </span>
                </Row>
                <Row label="Operator password">
                  {s.signin.password_from_env ? (
                    'Set by HIVE_ADMIN_PASSWORD on the host; change it there.'
                  ) : fresh ? (
                    <span className="block space-y-1.5">
                      <span className="block text-[12.5px] text-warn">New password. Shown once: copy it now.</span>
                      <span className="flex items-center gap-2">
                        <code className="rounded-lg bg-black/40 px-2 py-1 font-mono text-[13px]">{fresh}</code>
                        <Button variant="subtle" icon="copy" className="min-h-8 px-2.5 text-[12px]"
                          onClick={() => void navigator.clipboard?.writeText(fresh).then(() => toast({ tone: 'success', title: 'Copied' }))}>Copy</Button>
                        <Button variant="ghost" className="min-h-8 px-2.5 text-[12px]" onClick={() => setFresh(null)}>Hide</Button>
                      </span>
                      <span className="block text-[12px] text-ink-4">Every password sign-in has ended. Webhost and Google sign-ins are unaffected.</span>
                    </span>
                  ) : confirming ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[12.5px] text-ink-2">Make a new password and sign out every password session?</span>
                      <Button variant="danger" className="min-h-8 px-3 text-[12.5px]" onClick={() => void rotate()}>Rotate now</Button>
                      <Button variant="ghost" className="min-h-8 px-3 text-[12.5px]" onClick={() => setConfirming(false)}>Cancel</Button>
                    </span>
                  ) : (
                    <Button variant="subtle" className="min-h-8 px-3 text-[12.5px]" onClick={() => setConfirming(true)}>Rotate password…</Button>
                  )}
                </Row>
              </Section>

              <Section title="Disk">
                <Row label="Free on this Mac">
                  {gb(s.disk.free_bytes)} of {gb(s.disk.total_bytes)}
                  {s.disk.free_bytes < 3e9 && <span className="ml-2 text-warn">low</span>}
                </Row>
                <Row label="Hive data">{gb(s.disk.hive_data_bytes)}</Row>
              </Section>

              <Section title="Apps and isolation">
                <Row label="Where apps open">
                  {Object.keys(s.apps.homes).length ? (
                    <span className="block space-y-0.5">
                      {Object.entries(s.apps.homes).map(([app, ids]) => (
                        <span key={app} className="block">{appName(app)}: {ids.map(swarmName).join(', ')}</span>
                      ))}
                    </span>
                  ) : 'Each app opens where it was last used'}
                </Row>
                <Row label="Sandboxed tool apps">{s.apps.sandbox_apps.length ? s.apps.sandbox_apps.map(appName).join(', ') : 'None'}</Row>
                <Row label="Sandbox runtimes">{s.apps.sandbox_runtimes.length ? s.apps.sandbox_runtimes.join(', ') : 'None'}</Row>
                <Row label="Local-only swarms">
                  {s.apps.local_only_swarms.length ? s.apps.local_only_swarms.map(swarmName).join(', ') : 'None'}
                  <span className="block text-[12px] text-ink-4">Their minds' model calls never leave this machine.</span>
                </Row>
                <p className="text-[12px] text-ink-4">These are set on the host (hive-local/env). Changing them takes a restart.</p>
              </Section>
            </>
          )}
        </ResourceView>

        <HivePlacement />
        <GoogleConnectorAdminSettings />

        <RegisteredServices />

        <AskAudit />

        <section className="grid gap-2 sm:grid-cols-2">
          {LINKS.map((l) => (
            <button key={l.label} onClick={() => navigate(l.route)}
              className="flex items-start gap-3 rounded-2xl border border-line bg-white/[0.02] p-3.5 text-left hover:bg-white/[0.05]">
              <Icon name={l.icon} size={18} className="mt-0.5 text-ink-3" />
              <span>
                <span className="block text-[14px] font-medium text-ink">{l.label}</span>
                <span className="block text-[12px] text-ink-3">{l.body}</span>
              </span>
            </button>
          ))}
        </section>
      </div>
    </Page>
  )
}
