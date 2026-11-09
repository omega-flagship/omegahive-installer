import type { ComponentType } from 'react'
import { chromeFromSwatch, type ChromeModule, type ExperienceChrome } from './chrome'
import type { ShellPhase } from '../shell/phase'
import type { AskPort } from '../features/ask/askPort'
import type { AwakeApps } from '../shell/awakeApps'
import type { AskMarkSignal } from '../brand/askMark'

/** What an experience's rest or awake renderer is given (shell/phase.ts owns the state; the experience draws it). */
export interface PhaseRendererProps {
  /** A native placement supplied by the experience, when its phases live on the same paper as its Ask. */
  anchor?: HTMLElement | null
  /** The shell's state now (the renderer stays mounted through every state, so it can play its own way in and out). */
  phase: ShellPhase
  /** The state before the last move (null: none yet). */
  from: ShellPhase | null
  reduced: boolean
  /** The shell's one Ask (Ask-and-apps contract R1 §5): a look focuses, fills and listens through this, never the DOM. */
  ask: AskPort
  /** The apps this person can open (contract R1.1 §3): at most 8 shown, the rest behind "more" (shell/awakeApps.ts). */
  apps: AwakeApps
  /**
   * What the one Ask is doing, read-only (contract R1.1 §6): the same signal the Ask's own mark follows (brand/askMark:
   * listening while it holds words, speaking while an answer streams, plus pulse and hold). Hand it to LiveOmega.
   */
  presence: AskMarkSignal
  /** Notices waiting while the shell rests (0 otherwise; shell/restNotices): the rest shows one quiet count, never the
   * toasts; on wake they all appear. */
  waiting: number
}

/**
 * One experience from rest to Pro (PLAN_ONE_EXPERIENCE_REST_TO_PRO_R1). Each experience draws rest and awake in its own
 * engine, materials and motion; Pro is the experience itself, as already built. Everything is optional: an experience
 * without a renderer for a state goes straight to its home, which is today's behaviour. No shared skinned component.
 */
export interface ExperiencePhases {
  /** Drawn in the rest state: the Ω alone and the faint question. */
  rest?: ComponentType<PhaseRendererProps>
  /** Drawn in the awake state: the Ω named, the shell's one field, a few apps, the Pro control and power. */
  awake?: ComponentType<PhaseRendererProps>
  /** Awake → Pro is starting (the experience flies out to its full self). */
  toPro?: (from: ShellPhase) => void | Promise<void>
  /** Pro → awake is starting (the experience flies back in to its Ω). */
  fromPro?: () => void | Promise<void>
}

/**
 * Experiences: whole alternative front ends over the same hive. Unlike a look (tokens on the classic UI), an
 * experience owns layout, navigation, interaction and motion. Experiences are host code, reviewed and shipped like
 * any other UI; a person only chooses one. Classic pages (`navigate(route)`) still open over any experience, so
 * nothing the hive can do is ever out of reach.
 */
export interface ExperienceDef {
  id: string
  name: string
  /** One line in the gallery. */
  tagline: string
  /** How it works, in plain words. */
  blurb: string
  /** A look applied with it, so classic pages opened from it match (a seed variant id). */
  companionLook?: string
  /** Gallery card colours. `accent` is the experience's own chrome accent (chrome.ts; registry.test.ts pins it). */
  swatch: { bg: string; fg: string; accent: string }
  load?: () => Promise<{ default: ComponentType }>
  /**
   * Set only when OmegaReview has SHIPped this experience as a whole (not merely a later delta to it). A production
   * build offers, mounts and restores only reviewed experiences; the rest need a dev server or the surface-preview
   * build (`UNREVIEWED_ALLOWED`). Never set this without a whole-experience verdict to cite.
   */
  reviewed?: true
  /**
   * CANDIDATE (one-experience r1): this experience's rest and awake renderers and its toPro/fromPro hooks, loaded with it.
   * Set only behind UNREVIEWED_ALLOWED, so a production build compiles them out; at run time they are used only when
   * the person opted in (shell/phase phasesOptedIn). A whole-experience verdict for these is separate from `reviewed`.
   */
  phases?: () => Promise<ExperiencePhases>
  /**
   * Released (Ask-and-apps contract R1.1): this experience's rest and awake are on for everyone, in every build, unless
   * the tab turned them off with `?phases=0`. Set only with a paired review of that look's rest and awake to cite.
   */
  phasesReviewed?: true
}

export const CLASSIC: ExperienceDef = {
  id: 'classic',
  name: 'Classic hive',
  tagline: 'The original: a living star map with a side rail.',
  blurb: 'Navigation rail, glass panels and the hive scene.',
  swatch: { bg: '#04040f', fg: '#eceaff', accent: '#a493ff' },
  reviewed: true, // the platform's own UI
  phases: (import.meta.env.PROD ? import.meta.env.MODE === 'surface-preview' : true) ? () => import('./classic/phases') : undefined,
}

/**
 * The Surface preview build (`vite build --mode surface-preview`) for live testing before review closes: experiences
 * with open approval-safety findings are held back (Review R2–R4: Still, Canvas). It shows a visible "Preview build"
 * marker (shell/PreviewBuildMarker) so it is never mistaken for a release.
 */
export const SURFACE_PREVIEW = import.meta.env.MODE === 'surface-preview'
const HELD_IN_PREVIEW = ['still', 'canvas']

/**
 * The one gate for unreviewed experiences (stand-in OMEGATOWN_PROFESSIONAL R1 finding 4). A production build
 * (`import.meta.env.PROD`) allows them only in the surface-preview mode, whatever else the build environment says:
 * `VITE_UNREVIEWED_EXPERIENCES=1` or an inherited variable cannot open them in a release. Outside production builds
 * (the dev server, tests) they are allowed. Written as one constant expression so a production build folds it to
 * `false` and compiles the candidates' entries, chromes and Ask skins out entirely.
 */
export const UNREVIEWED_ALLOWED: boolean = import.meta.env.PROD ? import.meta.env.MODE === 'surface-preview' : true

/** The same rule as a pure function, for tests of builds this run is not (env as Vite exposes it). */
export function unreviewedAllowed(env: { PROD: boolean; MODE: string }): boolean {
  return env.PROD ? env.MODE === 'surface-preview' : true
}

/** Candidate experiences awaiting a whole-experience verdict. Only reachable through UNREVIEWED_ALLOWED. None at present. */
function CANDIDATES(): ExperienceDef[] {
  return []
}

/** Every experience this build carries (production: reviewed only; dev, tests, surface-preview: candidates too). Use `EXPERIENCES` for anything a person can reach. */
export const ALL_EXPERIENCES: ExperienceDef[] = [
  CLASSIC,
  // Unreviewed candidates: compiled out of every production build except surface-preview (UNREVIEWED_ALLOWED).
  ...(UNREVIEWED_ALLOWED ? CANDIDATES() : []),
  {
    id: 'professional',
    name: 'Professional',
    tagline: 'A clear workspace for your minds and work.',
    blurb: 'Plain navigation, conversations, swarm purposes and tasks.',
    swatch: { bg: '#f6f7f9', fg: '#17212f', accent: '#315ed4' },
    load: () => import('./professional'),
    phases: () => import('./professional/phases'),
    phasesReviewed: true, // Jon visual go, JON_GO_LOOKS_PRO_STILL_CONSTRUCT_20261104T100053Z.
    // Whole-experience review professional-release r1, r1.1, r1.2 (SURFACE_PROFESSIONAL_RELEASE_R1{,_1,_2}_REVIEW_REQUEST):
    // r1 and r1.1 verdicts FIX-FIRST (stand-in) and SHIP (Kimi); ships only on SHIP in
    // SURFACE_PROFESSIONAL_RELEASE_R1_2_STANDIN_VERDICT.md and SURFACE_PROFESSIONAL_RELEASE_R1_2_KIMI_VERDICT.md.
    // An extra look beside Classic, not its replacement (Jon 2026-10-08).
    reviewed: true,
  },
  // OmegaTown is removed everywhere (Jon 2026-11-02: the town lives in Little World); a saved 'omegatown' resolves to
  // Classic (resolveExperience: an id this build doesn't offer opens the Classic hive)
  {
    id: 'cosmos',
    name: 'Cosmos',
    tagline: 'Fly through your hive: swarms are star systems, minds are worlds.',
    blurb: 'A 3D galaxy you navigate by flight. Transmissions, beacons and a navigator ring.',
    companionLook: 'deep-sea',
    swatch: { bg: '#02030b', fg: '#e6f0ff', accent: '#7cc4ff' },
    load: () => import('./cosmos'),
    reviewed: true, // OmegaReview SURFACE_O_Q_27B9992_REVIEW_VERDICT_20261006 (O + Q source SHIP; Kimi SHIP)
    // CANDIDATE, unreviewed (cosmos-rest-r1): rest → awake → Pro drawn by Cosmos itself. Compiled out of production.
    // Ask-and-apps contract R1.1: Cosmos's rest and awake are released (paired review of the contract, its seams and this
    // switch-on); the person lands per their `landing` pref and `?phases=0` stays the way out for this tab
    phases: () => import('./cosmos/phases').then((m) => m.phases),
    phasesReviewed: true,
  },
  {
    id: 'construct',
    name: 'Construct',
    tagline: 'Jack in: a living terminal where everything is a command.',
    blurb: 'Digital rain, tiled panes and a command language with autocomplete. Keyboard first.',
    companionLook: 'phosphor',
    swatch: { bg: '#000800', fg: '#b6ffb0', accent: '#39ff7a' },
    load: () => import('./construct'),
    phases: () => import('./construct/phases'),
    phasesReviewed: true, // Jon visual go, JON_GO_LOOKS_PRO_STILL_CONSTRUCT_20261104T100053Z.
    reviewed: true, // OmegaReview SURFACE_O_Q_27B9992_REVIEW_VERDICT_20261006 (O + Q source SHIP; Kimi SHIP)
  },
  {
    id: 'still',
    name: 'Still',
    tagline: 'Calm and intuitive: just ask, and only what needs you.',
    blurb: 'No navigation. One question box, one decision at a time, the hive in plain sentences.',
    swatch: { bg: '#f4efe6', fg: '#1b1712', accent: '#a3221b' },
    load: () => import('./still'),
    phases: () => import('./still/phases'),
    phasesReviewed: true, // Jon visual go, JON_GO_LOOKS_PRO_STILL_CONSTRUCT_20261104T100053Z.
    reviewed: true, // OmegaReview SURFACE_78fe891_BROWSER_VERDICT_20261005 (R1–R4 closed)
  },
  {
    id: 'flux',
    name: 'Flux',
    tagline: 'Liquid: swarms are living fluid that morphs into whatever you touch.',
    blurb: 'A fluid simulation you stir; blobs pour into glass panels and back.',
    companionLook: 'sakura-night',
    swatch: { bg: '#0d0618', fg: '#ffeaf6', accent: '#ff9fdc' },
    load: () => import('./flux'),
    reviewed: true, // OmegaReview SURFACE_O_Q_27B9992_REVIEW_VERDICT_20261006 (O + Q source SHIP; Kimi SHIP)
  },
  {
    id: 'canvas',
    name: 'Canvas',
    tagline: 'One infinite canvas: zoom out for the hive, zoom in to talk.',
    blurb: 'Pan and pinch a spatial canvas with semantic zoom, a minimap and sticky decisions.',
    swatch: { bg: '#f6f6f3', fg: '#16161a', accent: '#2b48e0' },
    load: () => import('./canvas'),
    reviewed: true, // OmegaReview SURFACE_78fe891_BROWSER_VERDICT_20261005 (R1–R4 closed)
  },
]

/** What a build offers, as a pure function (tested): reviewed experiences, plus the rest only when allowed. */
export function offeredExperiences(all: ExperienceDef[], opts: { allowUnreviewed: boolean; preview: boolean }): ExperienceDef[] {
  return all.filter((e) => (e.reviewed === true || opts.allowUnreviewed) && !(opts.preview && HELD_IN_PREVIEW.includes(e.id)))
}

/** The experiences this build offers: the gallery lists these, and only these mount or restore from a saved look. */
export const EXPERIENCES: ExperienceDef[] = offeredExperiences(ALL_EXPERIENCES, { allowUnreviewed: UNREVIEWED_ALLOWED, preview: SURFACE_PREVIEW })

/**
 * UI review 2026-10-12 TF-03: a saved choice of an experience this preview build holds back (Still, Canvas) showed
 * Classic with no word. The held experience, when `id` is one (surface-preview only; a release never holds), so the
 * shell can say so (shell/HeldExperienceNotice); null otherwise.
 */
export function heldInPreview(id: string | null | undefined, preview: boolean = SURFACE_PREVIEW): ExperienceDef | null {
  if (!preview || !id || !HELD_IN_PREVIEW.includes(id)) return null
  return ALL_EXPERIENCES.find((e) => e.id === id) ?? null
}
/** The notice's words. */
export const heldWords = (name: string): string => `${name} isn't in this preview build; showing Classic.`

/** An id this build does not offer (unknown, unreviewed, held) resolves to classic, so a saved choice can never strand anyone. */
export const resolveExperience = (offered: ExperienceDef[], id: string | null | undefined): ExperienceDef => offered.find((e) => e.id === id) ?? CLASSIC
export const experienceById = (id: string | null | undefined): ExperienceDef => resolveExperience(EXPERIENCES, id)

/**
 * Each experience's window chrome (`experiences/<id>/chrome.ts`, exporting `chrome`), loaded lazily: a few hundred
 * bytes per experience, fetched with the experience. Classic answers null (the classic chrome). An experience
 * without its own chrome.ts yet is dressed from its gallery swatch, never left in the classic glass.
 */
const CHROMES: Record<string, () => Promise<ChromeModule>> = {
  ...import.meta.glob<ChromeModule>('./*/chrome.ts'),
  // a future candidate's chrome is excluded here and globbed behind UNREVIEWED_ALLOWED, compiled out with its entry
}
export const hasOwnChrome = (id: string): boolean => `./${id}/chrome.ts` in CHROMES
export async function chromeFor(id: string): Promise<ExperienceChrome | null> {
  const def = experienceById(id)
  if (def.id === 'classic') return null
  const load = CHROMES[`./${def.id}/chrome.ts`]
  if (!load) return chromeFromSwatch(def.swatch)
  try {
    const m = await load()
    return m.currentChrome?.() ?? m.chrome
  } catch {
    return chromeFromSwatch(def.swatch)
  }
}
