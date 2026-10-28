import { useEffect, useRef, useState, type FormEvent } from 'react'
import { bindGoogleView, googleRevocationWords, googleTopLevelWindow, isGoogleConnectorReturn, ownGoogleMinds, readGoogleConnectorStatus, readGoogleRevocation, startGoogleAuthorization, type GoogleConnectorStatus } from '../../api/googleConnector'
import { useIdentityEpoch } from '../../lib/epochBound'
import { bindEpoch } from '../../lib/identityEpoch'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { has, need } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Button } from '../../ui/primitives'

const inputClass = 'mt-1 min-h-11 w-full rounded-xl border border-line bg-black/30 px-3 text-[13px] text-ink outline-none focus:border-line-2'

/** An answer belongs to both this mounted view and the identity it was opened under. */
function useGoogleBinding() {
  const identity = useRef(bindEpoch()).current
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])
  return useRef(bindGoogleView(identity, () => live.current)).current
}

/** Mounted only in the authenticated host. Strip safe callback hints and reread on the person's own page. */
export function GoogleConnectorReturn() {
  const client = useHive((s) => s.client)
  useEffect(() => {
    if (client?.mode !== 'live' || !googleTopLevelWindow(window) || !isGoogleConnectorReturn(window.location.search)) return
    const u = new URL(window.location.href)
    u.searchParams.delete('google_connector')
    u.searchParams.delete('google_connector_error')
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash)
    navigate({ name: 'me' })
  }, [client])
  return null
}

/** This connection belongs to the current principal. There is no person selector or admin bypass. */
export function GoogleConnectorSettings() {
  const { me, loaded } = useMe()
  const epoch = useIdentityEpoch()
  if (!loaded || !me?.principal) return null
  return <PersonalGoogle key={`${epoch}:${me.principal}`} principal={me.principal} />
}

function PersonalGoogle({ principal }: { principal: string }) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const [status, setStatus] = useState<GoogleConnectorStatus | null>(null)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  // This lifetime binding also refuses a click from an old component before React has repainted a new sign-in.
  const binding = useGoogleBinding()
  const reads = useRef(0)
  const supported = has(client, 'googleConnector')
  const minds = ownGoogleMinds(Object.values(agents), principal)
  const read = async () => {
    const sequence = ++reads.current
    const value = readGoogleConnectorStatus(await need(client, 'googleConnector', 'Google connector')())
    if (!value) throw new Error('Unavailable Google connector status')
    binding.commit(() => { if (sequence === reads.current) { setStatus(value); setProblem('') } })
    return value
  }
  useEffect(() => {
    if (!supported || !binding.current()) return
    let live = true
    const pending = read(), sequence = reads.current
    void pending.catch(() => binding.commit(() => live && sequence === reads.current && (setStatus(null), setProblem('Your Google connection could not be read. Try again.'))))
    return () => { live = false }
    // A new client/identity remounts this section; its lifetime binding owns every response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])
  const run = async (work: () => Promise<unknown>) => {
    if (working.current || !binding.current()) return
    reads.current++ // a click supersedes any status read already in flight
    working.current = true; setBusy(true); setProblem(''); setNotice('')
    try { await work() }
    catch { binding.commit(() => { setStatus(null); setProblem('The change could not be confirmed. Refresh your connection status before trying again.') }) }
    finally { working.current = false; binding.commit(() => setBusy(false)) }
  }
  const connect = () => run(async () => {
    await startGoogleAuthorization(() => need(client, 'startGoogleConnector', 'Google connection')(), binding,
      () => googleTopLevelWindow(window), (url) => window.location.assign(url))
  })
  const disconnect = () => run(async () => {
    const answer = await need(client, 'disconnectGoogleConnector', 'Google disconnection')()
    if (!binding.current()) return
    const current = await read()
    if (current.connected) throw new Error('Disconnection is not confirmed')
    binding.commit(() => setNotice(googleRevocationWords(readGoogleRevocation(answer))))
  })
  const allow = (id: string, allowed: boolean) => run(async () => {
    const liveOwned = ownGoogleMinds(Object.values(useHive.getState().agents), principal).some((a) => a.id === id)
    if (!liveOwned || (allowed && (!status?.ready || !status.connected))) throw new Error('Current own mind and connected account required')
    await need(client, 'setGoogleConnectorMind', 'Google mind permission')(id, allowed)
    if (!binding.current()) return
    await read()
  })
  return (
    <section className="rounded-2xl border border-line bg-white/[0.02] p-4" aria-labelledby="google-connection-h">
      <h2 id="google-connection-h" className="eyebrow">Your Google connection</h2>
      <p className="mt-2 text-[13px] text-ink-3">Calendar read-only: a permitted mind can read bounded event titles, times and busy/free information. It cannot create or change events. This is separate from signing in to this hive with Google.</p>
      {!supported ? <p className="mt-3 text-[13px] text-ink-3">This hive does not offer the Google connector yet.</p> : <>
        <p className="mt-3 text-[13px]" role="status">{status ? status.connected ? 'Connected to your Google account.' : status.ready ? 'Not connected.' : 'Not connected. A hive admin must configure the Google client first.' : 'Connection status is unavailable.'}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {!status?.connected && <Button type="button" variant="primary" disabled={busy || !status?.ready || !has(client, 'startGoogleConnector')} onClick={() => void connect()}>Connect your Google account</Button>}
          {status?.connected && <Button type="button" variant="danger" disabled={busy || !has(client, 'disconnectGoogleConnector')} onClick={() => void disconnect()}>Disconnect Google</Button>}
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(read)}>Refresh status</Button>
        </div>
        <fieldset className="mt-4 space-y-2" disabled={busy || !status || !has(client, 'setGoogleConnectorMind')}>
          <legend className="text-[13px] font-medium">Which of your minds may read Calendar?</legend>
          <p className="text-[12.5px] text-ink-3">Off until you choose each mind. A hive admin or a general approval rule cannot give a mind access to your account.</p>
          {minds.length === 0 && <p className="text-[12.5px] text-ink-4">You have no owned minds available for a Calendar permission.</p>}
          {minds.map((mind) => {
            const checked = status?.allowed_minds.includes(mind.id) ?? false
            return <label key={mind.id} className="flex min-h-11 items-center gap-3 rounded-lg border border-line px-3 py-2 text-[13px]">
              <input type="checkbox" checked={checked} disabled={!checked && (!status?.ready || !status.connected)} onChange={(e) => void allow(mind.id, e.target.checked)} />
              <span>Allow {mind.name} to read your Calendar</span>
            </label>
          })}
        </fieldset>
      </>}
      {problem && <p role="alert" className="mt-3 text-[12.5px] text-bad">{problem}</p>}
      {notice && <p role="status" className="mt-3 text-[12.5px] text-ink-3">{notice}</p>}
    </section>
  )
}

/** App registration credentials are accepted only on the host's separate admin settings surface. */
export function GoogleConnectorAdminSettings() {
  const { admin, loaded } = useMe()
  const epoch = useIdentityEpoch()
  if (!loaded || !admin) return null
  return <GoogleClientForm key={epoch} />
}

function GoogleClientForm() {
  const client = useHive((s) => s.client)
  const binding = useGoogleBinding()
  const working = useRef(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [words, setWords] = useState('')
  if (!has(client, 'configureGoogleConnector')) return null
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (working.current || !binding.current() || !clientId.trim() || !clientSecret.trim()) return
    working.current = true; setBusy(true); setWords('')
    const id = clientId.trim(), secret = clientSecret
    setClientSecret('') // transient form input only; never retain it in a status, toast, URL or storage
    try {
      await need(client, 'configureGoogleConnector', 'Google client configuration')(id, secret)
      binding.commit(() => { setClientId(''); setWords('Google client configuration saved. Each person must still connect their own account and allow each mind.') })
    } catch { binding.commit(() => setWords('Google client configuration could not be confirmed. No credentials are shown in the response.')) }
    finally { working.current = false; binding.commit(() => setBusy(false)) }
  }
  return <section className="rounded-2xl border border-line bg-white/[0.02] p-4" aria-labelledby="google-client-h">
    <h2 id="google-client-h" className="eyebrow">Google connector app configuration · admins</h2>
    <p className="mt-2 text-[13px] text-ink-3">Register a Google Web OAuth client for this hive’s public callback ending in /api/connectors/google/callback. Calendar is read-only. This configures the app; it does not connect anyone’s Google account or grant a mind access.</p>
    <form className="mt-3 space-y-3" onSubmit={(e) => void save(e)}>
      <label className="block text-[12.5px] text-ink-3">Client ID<input className={inputClass} value={clientId} maxLength={2048} autoComplete="off" onChange={(e) => setClientId(e.target.value)} disabled={busy} /></label>
      <label className="block text-[12.5px] text-ink-3">Client secret<input className={inputClass} type="password" value={clientSecret} maxLength={4096} autoComplete="new-password" onChange={(e) => setClientSecret(e.target.value)} disabled={busy} /></label>
      <Button type="submit" disabled={busy || !clientId.trim() || !clientSecret.trim()}>Save Google client</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={() => { setClientId(''); setClientSecret(''); setWords('') }}>Clear fields</Button>
    </form>
    {words && <p role="status" className="mt-3 text-[12.5px] text-ink-3">{words}</p>}
  </section>
}
