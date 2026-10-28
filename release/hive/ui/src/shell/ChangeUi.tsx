import { useEffect, useState } from 'react'
import { useHive } from '../store/store'
import { cx } from '../lib/cx'
import { Sheet } from '../ui/Sheet'
import { Icon } from '../ui/Icon'
import { Button, Segmented } from '../ui/primitives'
import { appVars, DESIGNED_APPS, TYPE_FONTS } from './appLook'
import { EXPERIENCES, experienceById, type ExperienceDef } from '../experiences/registry'
import { setFpsMeter, useFpsMeterOn } from './fpsMeterState'
import { galleryKeep, galleryReset } from './lookActions'
import { RequestExperience } from '../features/requestExperience/RequestPanel'
import { markSeen, removeMyLook, undoPreview, useMyLooks, useRequest, type MyLook } from '../features/requestExperience/store'
import {
  asOwnChoice,
  blockedReason,
  DEFAULT_VARIANT,
  LAYOUTS,
  lookName,
  openGallery,
  ownVariant,
  previewLook,
  SEED_VARIANTS,
  useLook,
  withExperience,
  type Layout,
  type UiPrefs,
  type UiVariant,
} from './uiVariant'

/** "Change UI": every look this hive offers, previewed live; nothing is saved until the person keeps it. */
export default function ChangeUi() {
  const client = useHive((s) => s.client)
  const programs = useHive((s) => s.programs)
  // the designed app identities are shown for the apps this hive lists for the person, so read that list once
  useEffect(() => { if (programs === null) void useHive.getState().loadPrograms() }, [programs])
  const toast = useHive((s) => s.toast)
  const look = useLook()
  const [busy, setBusy] = useState(false)
  const fps = useFpsMeterOn()
  const mine = useMyLooks()
  const req = useRequest()
  const shown = look.current
  // the person's own look; while an experience wears its companion instead, no look card is "Previewing" (F1)
  const companionWorn = !ownVariant(shown) && !!look.worn
  const shownId = ownVariant(shown)?.id ?? (companionWorn ? null : 'default')
  const savedId = ownVariant(look.saved)?.id ?? 'default'
  const layoutChoice: Layout | 'auto' = shown?.layout ?? 'auto'
  const dirty = look.preview !== null

  const apps = shown?.apps ?? 'owner'
  const offered = experienceById(shown?.experience).id   // a saved experience this build does not offer reads as classic
  const exp = offered === 'classic' ? null : offered
  const own = withExperience(shown, exp) // the person's own look, layout and app identities, in the shown experience
  const pick = (v: UiVariant) => previewLook({ ...own, variant: v.id === 'default' ? null : asOwnChoice(v, exp) })
  const setLayout = (l: Layout | 'auto') => previewLook({ ...own, layout: l === 'auto' ? null : l })
  const setApps = (a: 'owner' | 'designed') => previewLook({ ...own, apps: a === 'owner' ? null : a })
  // the same choice the Ask and the guided demo make (uiVariant.withExperience): only the experience changes
  const pickExperience = (e: ExperienceDef) => previewLook(withExperience(shown, e.id))
  const pickMine = (l: MyLook) => {
    markSeen(l.variant.id)
    previewLook({ ...own, variant: l.variant, layout: l.layout ?? own.layout })
  }
  // the look on screen came from the request's words: keeping or undoing it here is the same as in the request
  const fromWords = !!req.previewing && req.previewing.prefs === look.preview
  const lookForApps = look.worn && !blockedReason(look.worn) ? look.worn : DEFAULT_VARIANT
  // Keep and Reset say what happened only to the person who pressed them (shell/lookActions binds each before its
  // await). `busy` is this sheet's own button state, not the person's: it is always released.
  const keep = async (p: UiPrefs) => {
    setBusy(true)
    try {
      await galleryKeep(client, p, toast)
    } finally {
      setBusy(false)
    }
  }
  const reset = async () => {
    setBusy(true)
    try {
      await galleryReset(client, toast)
    } finally {
      setBusy(false)
    }
  }
  const close = () => openGallery(false)

  return (
    <Sheet label="Change UI" onClose={close} width={520} header={<GalleryHeader onClose={close} />}>
      {/* the gallery body is the sheet's scroller (as every Sheet body is), so its sticky footer sticks to the scroller's
          bottom, which ends above the universal Ask (ui/Sheet), not to the sheet's own edge under it */}
      <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-6 md:px-5" data-tour="change-ui">
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          Try a different experience or look. Previews apply straight away, so you can keep using the hive to see how it feels; nothing is saved until you keep it.
        </p>

        <section aria-label="Experiences" className="flex flex-col gap-2">
          <h3 className="text-[12px] font-medium text-ink-3">Experiences: a whole different hive</h3>
          <ExperienceList experiences={EXPERIENCES} showing={exp ?? 'classic'} saved={look.saved?.experience ?? 'classic'} onPick={pickExperience} request={<RequestExperience />} />
        </section>

        <label className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2.5 text-[13px] text-ink-2">
          <span>
            Show frame rate
            <span className="block text-[12px] text-ink-4">A small live meter in the corner, for testing how smooth each experience is on this device.</span>
          </span>
          <input type="checkbox" checked={fps} onChange={(e) => setFpsMeter(e.target.checked)} className="size-5 accent-[var(--color-accent)]" data-tour="change-ui-fps" />
        </label>

        <section aria-label="Layout" className="flex flex-col gap-2">
          <h3 className="text-[12px] font-medium text-ink-3">Navigation</h3>
          <Segmented
            label="Navigation layout"
            value={layoutChoice}
            onChange={setLayout}
            options={[{ value: 'auto' as const, label: 'As designed' }, ...LAYOUTS.map((l) => ({ value: l.id, label: l.label }))]}
            dense
          />
          <p className="text-[12px] text-ink-4">Phones always use the bottom tab bar.</p>
        </section>

        {mine.length > 0 && (
          <section aria-label="Your looks" className="flex flex-col gap-2" data-tour="my-looks">
            <h3 className="text-meta font-medium text-ink-3">Your looks</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {mine.map((l) => (
                <div key={l.variant.id} className="flex flex-col gap-1">
                  <VariantCard v={l.variant} showing={shownId === l.variant.id} saved={savedId === l.variant.id} isNew={l.isNew} onPick={() => pickMine(l)} />
                  <div className="flex items-center justify-end gap-2">
                    {/* r1o P1: held for this session only, because this device could not save it */}
                    {l.unsaved && (
                      <span className="text-meta text-ink-3" data-tour="my-look-unsaved">
                        Not saved on this device
                      </span>
                    )}
                    <button type="button" onClick={() => removeMyLook(l.variant.id)} className="min-h-11 rounded-lg px-3 text-meta text-ink-3 hover:text-ink" aria-label={`Remove ${l.variant.name}`}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section aria-label="Looks" className="flex flex-col gap-2">
          <h3 className="text-[12px] font-medium text-ink-3">Looks</h3>
          {companionWorn && exp && <p className="text-[12px] text-ink-4">{experienceById(exp).name} brings its own look. Pick one here to use yours instead.</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[DEFAULT_VARIANT, ...SEED_VARIANTS].map((v) => (
              <VariantCard key={v.id} v={v} showing={shownId === v.id} saved={savedId === v.id} onPick={() => pick(v)} />
            ))}
          </div>
        </section>

        <section aria-label="Inside apps" className="flex flex-col gap-2">
          <h3 className="text-[12px] font-medium text-ink-3">Inside apps</h3>
          <Segmented
            label="App identities"
            value={apps}
            onChange={setApps}
            options={[
              { value: 'owner' as const, label: "Each app's own" },
              { value: 'designed' as const, label: 'Designed set' },
            ]}
          />
          <p className="text-[12px] text-ink-4">Every app keeps its own colours, heading type and texture, worn inside your chosen look. The designed set gives each app a fuller identity.</p>
          {apps === 'designed' && (
            <div className="grid grid-cols-2 gap-2" data-tour="change-ui-apps">
              {/* only the apps the hive lists for this person, by the name it gives them: copy never names an app itself */}
              {(programs ?? []).filter((p) => DESIGNED_APPS[p.id]).map((p) => [p, DESIGNED_APPS[p.id]] as const).map(([p, ident]) => (
                <AppSwatch key={p.id} name={p.name} title={ident.title} vars={appVars(ident.theme, lookForApps)} motif={ident.theme.motif} font={TYPE_FONTS[ident.theme.type]} />
              ))}
            </div>
          )}
        </section>

        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-2 border-t border-line px-4 pt-3 pb-1 md:-mx-5 md:px-5" style={{ background: 'var(--look-strong, rgb(11 11 33 / 0.94))' }}>
          <Button variant="primary" icon="check" disabled={!dirty || busy} onClick={() => shown && void keep(shown)}>
            Keep {!shown ? 'this look' : fromWords ? shown.variant?.name ?? lookName(shown) : lookName(shown)}
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => (fromWords ? undoPreview() : previewLook(null))} disabled={busy}>
              Undo preview
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="subtle" icon="reset" onClick={() => void reset()} disabled={busy || (savedId === 'default' && !look.saved?.layout && !look.saved?.experience && !dirty)} data-tour="change-ui-reset">
            Reset to {DEFAULT_VARIANT.name}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

function GalleryHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-4 pb-2 md:px-5">
      <Icon name="sparkles" size={18} className="text-accent" />
      <h2 className="flex-1 font-display text-[18px] font-semibold tracking-tight">Change UI</h2>
      <button onClick={onClose} className="flex size-11 items-center justify-center rounded-xl text-ink-3 hover:bg-white/[0.06] hover:text-ink" aria-label="Close">
        <Icon name="x" size={18} />
      </button>
    </div>
  )
}

/**
 * The experiences this build offers, then the "Request an experience" tile: one list for every experience's gallery,
 * so the tile is always there whichever experience the person is in.
 */
export function ExperienceList({ experiences, showing, saved, onPick, request }: { experiences: ExperienceDef[]; showing: string; saved: string; onPick: (e: ExperienceDef) => void; request: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3">
      {experiences.map((e) => (
        <ExperienceCard key={e.id} e={e} showing={showing === e.id} saved={saved === e.id} onPick={() => onPick(e)} />
      ))}
      {request}
    </div>
  )
}

/** A miniature of the variant drawn in its own colours, type and shape, so looks can be compared at a glance. */
function VariantCard({ v, showing, saved, isNew, onPick }: { v: UiVariant; showing: boolean; saved: boolean; isNew?: boolean; onPick: () => void }) {
  const blocked = blockedReason(v)
  const c = v.colors
  const r = v.radius === 'square' ? 2 : v.radius === 'pill' ? 14 : v.radius === 'round' ? 10 : 7
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={!!blocked}
      aria-pressed={showing}
      data-tour={`look-${v.id}`}
      className={cx(
        'group flex flex-col overflow-hidden rounded-2xl border text-left transition-[border-color,transform] duration-150',
        showing ? 'border-accent' : 'border-line hover:border-line-2',
        blocked ? 'cursor-not-allowed opacity-60' : 'active:scale-[0.98]',
      )}
    >
      <div className="relative h-[104px] w-full" style={{ background: `linear-gradient(180deg, ${c.abyss}, ${c.void})`, fontFamily: v.fonts?.sans }} aria-hidden="true">
        <MiniNav v={v} r={r} />
        <div className="absolute flex flex-col gap-1.5 p-2" style={miniPage(v)}>
          <div style={{ color: c.ink, fontFamily: v.fonts?.display, fontSize: 13, fontWeight: 650, lineHeight: 1.1 }}>{v.name}</div>
          <div style={{ color: c['ink-3'], fontSize: 10 }}>3 minds awake</div>
          <div className="flex gap-1.5">
            <span style={{ background: `linear-gradient(180deg, ${c['primary-top']}, ${c.accent})`, color: c['primary-ink'], borderRadius: r, fontSize: 10, fontWeight: 600, padding: '2px 8px' }}>Start</span>
            <span style={{ color: c.good, border: `1px solid ${c.line}`, borderRadius: r, fontSize: 10, padding: '2px 6px' }}>● ok</span>
            <span style={{ color: c['accent-2'], border: `1px solid ${c.line}`, borderRadius: r, fontSize: 10, padding: '2px 6px' }}>link</span>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-0.5 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate text-[14px] font-medium text-ink">{v.name}</span>
          {isNew && <span className="rounded-full border border-accent px-1.5 text-caption font-semibold text-accent">New</span>}
          {saved && <span className="text-[11px] font-medium text-good">Yours</span>}
          {showing && !saved && <span className="text-[11px] font-medium text-accent">Previewing</span>}
        </div>
        <span className="text-[12px] leading-snug text-ink-3">{blocked ?? v.blurb}</span>
      </div>
    </button>
  )
}

/** An experience: its own colours and a line of what it is like to use. */
function ExperienceCard({ e, showing, saved, onPick }: { e: ExperienceDef; showing: boolean; saved: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={showing}
      data-tour={`experience-${e.id}`}
      className={cx('relative flex min-h-[92px] flex-col justify-end overflow-hidden rounded-2xl border p-4 text-left transition-transform active:scale-[0.99]', showing ? 'border-accent' : 'border-line hover:border-line-2')}
      style={{ background: `radial-gradient(120% 140% at 100% 0%, ${e.swatch.accent}55, transparent 55%), ${e.swatch.bg}`, color: e.swatch.fg }}
    >
      <span className="flex items-center gap-2">
        <span className="text-[17px] font-semibold tracking-tight">{e.name}</span>
        {saved && <span className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold" style={{ background: e.swatch.accent, color: e.swatch.bg }}>Yours</span>}
        {showing && !saved && <span className="text-[11px] font-medium opacity-80">Previewing</span>}
      </span>
      <span className="mt-0.5 text-[12.5px] opacity-80">{e.tagline}</span>
    </button>
  )
}

/** One app's identity as it will look inside the chosen look. */
function AppSwatch({ name, title, vars, motif, font }: { name: string; title: string; vars: Record<string, string>; motif: string; font: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-line px-3 py-2.5" style={{ ...(vars as React.CSSProperties), background: 'linear-gradient(180deg, var(--look-page-a), var(--look-page-b))' }}>
      {motif !== 'none' && <div className="app-motif" data-motif={motif} aria-hidden="true" />}
      <div className="relative text-[10.5px] font-semibold tracking-[0.12em] text-ink-3 uppercase">{name}</div>
      <div className="relative mt-0.5 text-[14px] font-semibold text-accent" style={{ fontFamily: font }}>
        {title}
      </div>
      <div className="relative mt-1.5 flex gap-1.5">
        <span className="h-1.5 w-8 rounded-full" style={{ background: 'var(--color-accent)' }} />
        <span className="h-1.5 w-4 rounded-full" style={{ background: 'var(--color-accent-2)' }} />
      </div>
    </div>
  )
}


function miniPage(v: UiVariant): React.CSSProperties {
  if (v.layout === 'topbar') return { left: 6, right: 6, top: 22, bottom: 6 }
  if (v.layout === 'dock') return { left: 6, right: 6, top: 6, bottom: 24 }
  return { left: 26, right: 6, top: 6, bottom: 6 }
}

function MiniNav({ v, r }: { v: UiVariant; r: number }) {
  const c = v.colors
  const bar = { background: c.glass, border: `1px solid ${c.line}`, borderRadius: r, position: 'absolute' } as const
  const dots = (n: number, vertical: boolean) => (
    <div className={cx('flex items-center justify-center gap-1', vertical ? 'h-full flex-col' : 'h-full w-full')}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} style={{ width: 5, height: 5, borderRadius: 99, background: i === 1 ? c.accent : c['ink-4'] }} />
      ))}
    </div>
  )
  if (v.layout === 'topbar') return <div style={{ ...bar, left: 30, right: 30, top: 4, height: 14 }}>{dots(8, false)}</div>
  if (v.layout === 'dock') return <div style={{ ...bar, left: '25%', right: '25%', bottom: 4, height: 16 }}>{dots(7, false)}</div>
  return <div style={{ ...bar, left: 4, top: 6, bottom: 6, width: 16 }}>{dots(6, true)}</div>
}
