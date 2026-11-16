import { useEffect, useMemo } from 'react'
import { appTheme, type AppIdentitySource } from './appLook'
import { useLook } from './uiVariant'
import { hslToRgb } from '../lib/color'
import { appMarkUrl, themeFromColour } from '../brand/appMark'
import type { Program } from '../api/types'
import { navigate } from '../lib/router'
import { onIdentityChange } from '../lib/identityEpoch'
import { useHive } from '../store/store'
import { awakeSlice, loadMyApps, useMyApps, type MyApp, type MyAppRow } from '../features/apps/myApps'

/**
 * The apps the shell hands every look's rest and awake states (Ask-and-apps contract R1.1 §3): the host's list
 * (GET /api/me/apps, or the simulator's), loaded once per identity while a look is phased, at most 8 shown and the rest
 * behind "more" (the full Apps page: nothing hidden). Opening goes to the app's own page, which opens a person app's
 * context or the swarm app where it works.
 */
/** An app as a look draws it: the host's row, plus its identity colour (a CSS colour the shell resolved). */
export type AwakeApp = MyApp & {
  /** the app's own accent in the identity set this person chose (shell/appLook appTheme, as Cosmos's orbit uses),
   * else a stable colour from its id; always a CSS colour, never an id the look would have to resolve */
  identityColour: string
  /** the app's own mark, from its identity (brand/appMark: its motif in its colours under a monogram in its own type),
   * as a data URL; square and full bleed, so each look clips it to its own tile */
  identityIcon: string
}
export interface AwakeApps {
  shown: AwakeApp[]
  more: number
  loaded: boolean
  error: string | null
  /** the full list (the "more") */
  openAll(): void
}

export function openAwakeRow(row: MyAppRow): void {
  navigate(row.open.kind === 'swarm' ? { name: 'program', id: row.id, swarm: row.open.swarm_id } : { name: 'program', id: row.id })
}
export const openAllApps = (): void => navigate({ name: 'programs' })

type AppsClient = { myApps?: () => Promise<{ apps: MyAppRow[] }> } | null | undefined

/**
 * Load through `client` now, and again on each identity change while `client` is still the hive's client. A change that
 * comes with a different client never loads through the old one (Codex 3 Nov): the new client's own start loads it.
 * Returns the stop. Pure of React, so the two-client case is tested directly.
 */
export function startAwakeApps(client: AppsClient, currentClient: () => AppsClient = () => useHive.getState().client): () => void {
  if (!client?.myApps) return () => undefined
  const load = () => {
    if (currentClient() !== client) return
    void loadMyApps(() => client.myApps!(), openAwakeRow).catch(() => undefined)
  }
  load()
  return onIdentityChange(load)
}

/** Load for this identity while `enabled` (a phased look); again after an identity change on the same client. */
export function useAwakeApps(enabled: boolean): AwakeApps {
  const client = useHive((s) => s.client)
  const programs = useHive((s) => s.programs)
  const source = useLook().current?.apps ?? 'owner'
  const { apps, loaded, error } = useMyApps()
  useEffect(() => (enabled ? startAwakeApps(client) : undefined), [enabled, client])
  const { shown, more } = awakeSlice(apps)
  const coloured = useMemo(() => shown.map((a) => { const identityColour = identityColourOf(a.id, programs, source); return { ...a, identityColour, identityIcon: identityIconOf(a, programs, source, identityColour) } }), [shown, programs, source])
  return { shown: coloured, more, loaded, error, openAll: openAllApps }
}

/** The app's mark from its identity in the chosen set, else from its identity colour (pure, tested). */
export function identityIconOf(app: { id: string; name: string }, programs: Pick<Program, 'id' | 'app'>[] | null | undefined, source: AppIdentitySource, colour: string): string {
  const theme = appTheme(programs?.find((p) => p.id === app.id), source) ?? themeFromColour(app.id, colour)
  return appMarkUrl(app, theme)
}

/** The app's accent in the chosen identity set, else a stable hue from its id (pure, tested). */
export function identityColourOf(id: string, programs: Pick<Program, 'id' | 'app'>[] | null | undefined, source: AppIdentitySource): string {
  const accent = appTheme(programs?.find((p) => p.id === id), source)?.accent
  if (accent) return accent
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  // hex, never modern hsl(): three.js's colour parser reads only the comma form, and a look may draw it there (the
  // Cosmos crystals came out white from 'hsl(76 80% 66%)', 3 Nov)
  return '#' + hslToRgb(h % 360, 80, 66).map((v) => v.toString(16).padStart(2, '0')).join('')
}
