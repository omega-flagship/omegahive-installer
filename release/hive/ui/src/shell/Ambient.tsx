import { AnimatePresence, m } from 'framer-motion'
import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react'
import type { AuthMethods } from '../api/client'
import type { AssertionOutcome } from '../api/types'
import { useIsDesktop } from '../lib/hooks'
import { navigate, useRoute } from '../lib/router'
import { useScene } from '../scene/sceneStore'
import { SetupChecklist } from '../features/setup/SetupChecklist'
import { useHive } from '../store/store'
import { Icon } from '../ui/Icon'
import { beliefText, plainText } from '../lib/beliefSentence'
import { Button, Orb } from '../ui/primitives'
import { cx } from '../lib/cx'
import { Brand } from './Hud'
import type { SigninReach } from './brandStatus'
import { DESKTOP_TICKER_BOTTOM, PHONE_TICKER_BOTTOM } from './tickerPlace'
import { shown } from '../lib/displayName'
import { usePhase } from './phase'
import { clearSigninError, GOOGLE_REQUIRED, readSigninError, signinErrorWords } from './signinError'

// the explainer (copy for every view) loads with the views, not with the shell
const ViewInfo = lazy(() => import('../tour/ViewInfo').then((r) => ({ default: r.ViewInfo })))

const OUTCOME_VERB: Record<AssertionOutcome, string> = {
  adopted: 'introduced',
  revised: 'revised',
  chosen: 'won a choice on',
  kept: 'lost a choice on',
  duplicate: 'repeated',
  quarantined: 'was quarantined on',
  denied: 'was denied on',
}

/** A quiet live feed of what the hive is doing. */
export function ActivityTicker() {
  const phasedHome = usePhase((s) => s.phased && s.phase !== 'pro')
  const activity = useHive((s) => s.activity)
  const agents = useHive((s) => s.agents)
  const desktop = useIsDesktop()
  const route = useRoute()
  if (route.name !== 'hive' || phasedHome) return null
  const items = activity.slice(0, desktop ? 4 : 1)
  return (
    <div
      className={cx('pointer-events-none fixed z-10 flex flex-col gap-1.5', desktop ? 'left-[calc(var(--rail-x,84px)+12px)] w-[420px]' : 'inset-x-3')}
      style={{ bottom: desktop ? DESKTOP_TICKER_BOTTOM : PHONE_TICKER_BOTTOM }}
      aria-live="off"
    >
      <AnimatePresence initial={false}>
        {items.map((a, i) => {
          const agent = a.agent_id ? agents[a.agent_id] : undefined
          return (
            <m.div
              key={a.id}
              initial={{ opacity: 0, y: 14, filter: 'blur(4px)' }}
              animate={{ opacity: 1 - i * 0.22, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              className="flex min-w-0 items-center gap-2 rounded-xl bg-shade/25 px-2.5 py-1.5 text-[12px] text-ink-2 backdrop-blur-sm"
            >
              {agent ? <Orb hue={agent.hue} status={agent.status} size={14} /> : <span className="size-3.5" />}
              <span className="shrink-0 font-medium text-ink">{agent?.name ?? 'Someone'}</span>
              {a.kind === 'belief' && a.statement ? (
                <>
                  <span className={cx('shrink-0', a.outcome === 'quarantined' && 'text-warn', (a.outcome === 'chosen' || a.outcome === 'kept') && 'text-[#f5c06b]')}>
                    {OUTCOME_VERB[a.outcome ?? 'revised']}
                  </span>
                  <span className="min-w-0 truncate">{beliefText(a.statement)}</span>
                </>
              ) : (
                <span className={cx('truncate', a.kind === 'error' && 'text-bad')}>{plainText(a.text)}</span>
              )}
            </m.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}

export function SceneControls() {
  const engine = useScene((s) => s.engine)
  const desktop = useIsDesktop()
  const route = useRoute()
  if (!engine || route.name !== 'hive') return null
  if (!desktop) {
    return (
      <div className="fixed right-3 z-10 flex flex-col gap-2" style={{ top: 'calc(var(--sat) + 132px)' }}>
        <button onClick={() => engine.overview()} className="glass flex size-11 items-center justify-center rounded-2xl text-ink-2" aria-label="Recenter the hive">
          <Icon name="locate" size={19} />
        </button>
        <div className="glass min-h-11 rounded-2xl">
          <Suspense fallback={<span className="block size-11" />}>
            <ViewInfo view="hive" />
          </Suspense>
        </div>
      </div>
    )
  }
  return (
    <div className="glass fixed right-4 bottom-[calc(var(--hud-bottom,0px)+max(20px,var(--os-clock-lift,0px)))] z-10 flex flex-col rounded-2xl p-1" role="group" aria-label="Camera">
      <Suspense fallback={<span className="block size-11" />}>
        <ViewInfo view="hive" />
      </Suspense>
      <button onClick={() => engine.zoomBy(1.3)} className="flex size-11 items-center justify-center rounded-xl text-ink-2 hover:bg-tint/[0.06] hover:text-ink" aria-label="Zoom in">
        <Icon name="zoomIn" size={19} />
      </button>
      <button onClick={() => engine.zoomBy(1 / 1.3)} className="flex size-11 items-center justify-center rounded-xl text-ink-2 hover:bg-tint/[0.06] hover:text-ink" aria-label="Zoom out">
        <Icon name="zoomOut" size={19} />
      </button>
      <button onClick={() => engine.overview()} className="flex size-11 items-center justify-center rounded-xl text-ink-2 hover:bg-tint/[0.06] hover:text-ink" aria-label="Recenter the hive">
        <Icon name="locate" size={19} />
      </button>
    </div>
  )
}

/** Keyboard and screen-reader access to every dot: hidden until focused. */
export function DotDirectory() {
  const agents = useHive((s) => s.agents)
  const list = Object.values(agents).sort((a, b) => a.name.localeCompare(b.name))
  return (
    <nav
      aria-label="Minds"
      className="glass-strong fixed top-24 left-1/2 z-50 max-h-[60vh] w-72 -translate-x-1/2 overflow-auto rounded-2xl p-2 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 pointer-events-none"
    >
      <div className="eyebrow px-2 py-1">Minds</div>
      {list.map((a) => (
        <button key={a.id} onClick={() => navigate({ name: 'dot', id: a.id })} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-left text-sm hover:bg-tint/[0.06]">
          <Orb hue={a.hue} status={a.status} size={16} />
          {shown(a.name)}
          <span className="ml-auto text-xs text-ink-3">{a.status}</span>
        </button>
      ))}
    </nav>
  )
}

export function EmptyHive() {
  const ready = useHive((s) => s.ready)
  const count = useHive((s) => Object.keys(s.agents).length)
  const route = useRoute()
  if (!ready || count > 0 || route.name !== 'hive') return null
  return (
    <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="fixed inset-0 z-10 flex items-center justify-center p-6 pointer-events-none">
      <div className="glass thin-scroll pointer-events-auto max-h-[calc(100dvh-160px)] max-w-sm overflow-y-auto rounded-3xl p-6 text-center">
        <div className="font-display text-xl font-semibold">The hive is quiet</div>
        <p className="mt-2 text-sm text-ink-3">No minds yet. A mind needs a connected provider before it can think; the steps below show what is set up.</p>
        <div className="mt-4">
          <SetupChecklist compact />
        </div>
        <Button variant="primary" icon="sparkles" className="mt-5" onClick={() => navigate({ name: 'new' })}>
          Create the first mind
        </Button>
      </div>
    </m.div>
  )
}

export function BootScreen({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-5 p-6">
      <m.div animate={{ scale: [1, 1.08, 1], opacity: [0.8, 1, 0.8] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}>
        <div className="size-20 rounded-full" style={{ background: 'radial-gradient(circle, #fff 0 8%, #b9a8ff 22%, rgb(124 108 255 / 0.25) 50%, transparent 70%)' }} />
      </m.div>
      {error ? (
        <div className="glass max-w-sm rounded-2xl p-5 text-center" role="alert">
          <div className="font-display font-semibold">Could not reach the hive</div>
          <p className="mt-1 text-sm text-ink-3">{error}</p>
          <Button className="mt-4" onClick={onRetry} icon="sparkles">
            Try again
          </Button>
        </div>
      ) : (
        <div className="eyebrow animate-pulse">Waking the hive…</div>
      )}
    </div>
  )
}

export function Login() {
  const client = useHive((s) => s.client)
  const hydrate = useHive((s) => s.hydrate)
  const [pw, setPw] = useState('')
  // T-101: a member types the email an admin added; the operator leaves it empty
  const [email, setEmail] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(0)
  const [methods, setMethods] = useState<AuthMethods | null>(null)
  // signed out is not offline: the status line says Offline only when the hive could not be asked how to sign in
  const [asked, setReach] = useState<SigninReach>(() => (typeof navigator !== 'undefined' && navigator.onLine === false ? 'unreachable' : 'checking'))
  // a host that cannot be asked: this page is shown because nobody is signed in
  const reach: SigninReach = client && !client.authMethods ? 'reachable' : asked
  // read once from the address, then cleared from it: a reload does not show a stale problem
  const [signinError, setSigninError] = useState(() => readSigninError(window.location))
  useEffect(() => {
    clearSigninError()
    // a later hash-only arrival (no reload) is read and cleared the same way
    const onHash = () => {
      const code = readSigninError(window.location)
      if (!code) return
      setSigninError(code)
      clearSigninError()
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    if (!client?.authMethods) return
    void client.authMethods().then(
      (m) => (setMethods(m), setReach('reachable')),
      () => (setMethods(null), setReach('unreachable')),
    )
  }, [client])

  if (methods && !methods.password) {
    const params = new URLSearchParams(window.location.search)
    const inviteToken = params.get('invite')
    const inviteUrl = methods.sso.invite_login_url ?? methods.sso.login_url
    const url = inviteToken ? (inviteUrl ? `${inviteUrl}?invite=${encodeURIComponent(inviteToken)}` : null) : (methods.sso.login_url ?? null)
    if (inviteToken) return <InviteCard token={inviteToken} url={url} />
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center p-5">
        <m.div initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="glass-strong w-full max-w-sm rounded-[26px] p-6" role="dialog" aria-label="Sign in">
          <Brand signin={reach} />
          <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight">Invite only</h1>
          <p className="mt-1.5 text-sm text-ink-3">Sign in with the Google account your invitation was sent to.</p>
          <SigninNotice code={signinError} />
          {url ? (
            <a href={url} className="mt-6 flex min-h-12 w-full items-center justify-center gap-2.5 rounded-xl bg-white px-4 text-[15px] font-semibold text-[#1f1f1f] shadow-[0_8px_30px_-8px_color-mix(in_oklab,var(--color-ink)_40%,transparent)] transition-transform active:scale-[0.98]">
              <GoogleMark /> Continue with Google
            </a>
          ) : (
            <p className="mt-6 text-sm text-warn">Sign-in is not set up on this hive yet.</p>
          )}
          <p className="mt-4 text-[12px] leading-relaxed text-ink-4">Signed in already but sent back here? Your account has not been invited to this hive yet. Ask the person who runs it.</p>
        </m.div>
      </div>
    )
  }

  const members = methods?.member_password === true
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!client || !pw) return
    setBusy(true)
    setErr(null)
    try {
      await client.login(pw, members && email.trim() ? email.trim() : undefined)
      // a client that reports credential changes is read again by the store's own observer (store init): the one
      // sign-in path, also taken when another tab signs in. Hydrating here as well would read the hive twice.
      if (!client.onAuthChange) await hydrate()
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Login failed')
      setShake((n) => n + 1)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-5">
      <m.form
        key={shake}
        onSubmit={submit}
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={shake ? { x: [0, -10, 9, -6, 4, 0], opacity: 1, y: 0, scale: 1 } : { opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45 }}
        className="glass-strong w-full max-w-sm rounded-[26px] p-6"
        aria-label={members ? 'Sign in' : 'Operator login'}
      >
        <Brand signin={reach} />
        <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight">{members ? 'Welcome back' : 'Welcome back, operator'}</h1>
        <p className="mt-1.5 text-sm text-ink-3">{members ? 'Members: your email and the password an admin gave you. The operator: the hive password, no email.' : 'Enter the hive password to wake the interface.'}</p>
        <SigninNotice code={signinError} googleUrl={methods?.sso.login_url ?? null} />
        {members && (
          <label className="mt-6 block">
            <span className="eyebrow">Email</span>
            <input
              type="email"
              autoComplete="username"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-2 min-h-12 w-full rounded-xl border border-line bg-shade/30 px-4 text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-accent/60"
              placeholder="Members only; empty for the operator"
            />
          </label>
        )}
        <label className={members ? 'mt-4 block' : 'mt-6 block'}>
          <span className="eyebrow">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus={!members}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            className="mt-2 min-h-12 w-full rounded-xl border border-line bg-shade/30 px-4 text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-accent/60"
            placeholder={members ? 'Password' : 'Hive password'}
            aria-invalid={!!err}
            aria-describedby={err ? 'login-err' : undefined}
          />
        </label>
        {err && (
          <p id="login-err" className="mt-2 text-sm text-bad" role="alert">
            {err}
          </p>
        )}
        <Button variant="primary" size="lg" type="submit" className="mt-5 w-full" disabled={busy || !pw}>
          {busy ? 'Waking…' : 'Enter the hive'}
        </Button>
      </m.form>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

/**
 * A sign-in problem in plain words (signinError.ts): fixed words for the code, never the code or anything else from
 * the address. `googleUrl`: for "this account signs in with Google", the Google button (pages that show none).
 */
export function SigninNotice({ code, googleUrl }: { code: string | null; googleUrl?: string | null }) {
  const words = signinErrorWords(code)
  if (!words) return null
  return (
    <>
      <p className="mt-3 rounded-xl border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad" role="alert">
        {words}
      </p>
      {code === GOOGLE_REQUIRED && googleUrl && (
        <a href={googleUrl} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2.5 rounded-xl bg-white px-4 text-[15px] font-semibold text-[#1f1f1f] shadow-[0_8px_30px_-8px_color-mix(in_oklab,var(--color-ink)_40%,transparent)] transition-transform active:scale-[0.98]">
          <GoogleMark /> Continue with Google
        </a>
      )}
    </>
  )
}

function InviteCard({ token, url }: { token: string; url: string | null }) {
  const client = useHive((s) => s.client)
  const [preview, setPreview] = useState<{ email_hint: string; name: string; role: string; expires_at: number } | null>(null)
  const [gone, setGone] = useState(false)
  useEffect(() => {
    void client?.invitePreview?.(token).then(setPreview).catch(() => setGone(true))
  }, [client, token])
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-5">
      <m.div initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="glass-strong w-full max-w-sm rounded-[26px] p-6" role="dialog" aria-label="Invitation">
        <Brand signin="reachable" />
        {gone ? (
          <>
            <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight">This invitation is closed</h1>
            <p className="mt-1.5 text-sm text-ink-3">It expired, was already used, or was withdrawn. Ask the person who invited you for a new one.</p>
          </>
        ) : (
          <>
            <div className="mt-6 eyebrow">You are invited</div>
            <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight">{preview?.name ? `Welcome, ${preview.name.split(' ')[0]}` : 'Join this hive'}</h1>
            <p className="mt-1.5 text-sm text-ink-3">
              A living hive of minds. Accept with the Google account {preview ? <span className="text-ink">{preview.email_hint}</span> : 'this was sent to'}.
            </p>
            {url && (
              <a href={url} className="mt-6 flex min-h-12 w-full items-center justify-center gap-2.5 rounded-xl bg-white px-4 text-[15px] font-semibold text-[#1f1f1f] shadow-[0_8px_30px_-8px_color-mix(in_oklab,var(--color-ink)_40%,transparent)] transition-transform active:scale-[0.98]">
                <GoogleMark /> Accept with Google
              </a>
            )}
            {preview && <p className="mt-3 text-[12px] text-ink-4">The invitation works once and expires {new Date(preview.expires_at * 1000).toLocaleDateString()}.</p>}
          </>
        )}
      </m.div>
    </div>
  )
}
