import type { AppUpdate, PlatformUpdate, UpdateHistoryRow, UpdateHold, UpdatesOverview } from '../../api/types'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { plural } from '../../lib/plural'
import type { ResourceState } from '../../lib/useResource'
import { withResource } from '../../screens/resourceFacts'
import type { ScreenFacts, ScreenPlan } from '../../screens/screenSpace'
import { holdScopeWords, holdsFor, short } from './updates'

/**
 * What the Updates screens are told (updates.metta): the values they draw (bound by path) and this moment's facts
 * (counts and flags) from which MeTTa composes them. Each hold and each app is composed as its own small screen, and
 * the updates screen stacks them. Pure: composing, the time and what this hive lets the person do are handed in.
 */
export type Compose = (screen: string, facts: ScreenFacts) => ScreenPlan
export interface Composed { data: Record<string, unknown>; facts: ScreenFacts }
/** One row of a stack: its id, the screen MeTTa composed for it, and the values that screen draws. */
export interface StackItem { id: string; plan: ScreenPlan; data: Record<string, unknown> }
/** What this hive offers the person here: placing holds, lifting them, applying updates, asking for one, and having
 *  an installed Mac hive's updater check for a newer release now. */
export interface Can { hold: boolean; release: boolean; apply: boolean; request: boolean; check: boolean }

/** What the hive runs: an installed release by its number and build, a git checkout by its build. */
const running = (p: PlatformUpdate): string => {
  const r = p.running_release
  if (!r) return `Running build ${short(p.running_build)}`
  return r.version ? `Running Omega Hive v${r.version} (build ${short(r.commit)})` : `Running build ${short(r.commit)}`
}
/** How a moment is written out in full (the page passes the browser's own format). */
export type When = (iso: string) => string

const local: When = (iso) => new Date(iso).toLocaleString()

/** What an app is called on this page, from its id (a hold names the app it stops by id). */
export const appNamer = (apps: AppUpdate[]) => (id: string) => shown(apps.find((a) => a.id === id)?.name ?? id)

/** An app needs attention: an update is waiting, or it failed to load. */
export const needsAttention = (a: AppUpdate): boolean => a.update_available || !!a.load_error

export function holdItem(h: UpdateHold, appName: (id: string) => string, can: Can, now: number, when: When, compose: Compose): StackItem {
  return {
    id: h.id,
    plan: compose('updates-hold', { flags: { 'can.release': can.release } }),
    data: {
      'hold.stops': holdScopeWords(h.scope, appName),
      'hold.detail': `${h.reason} · ${h.held_by}, ${ago(h.created_at, now)}${h.until ? ` · until ${when(h.until)}` : ' · until released'}`,
    },
  }
}

export function appItem(a: AppUpdate, holds: UpdateHold[], can: Can, compose: Compose): StackItem {
  const name = shown(a.name)
  return {
    id: a.id,
    plan: compose('updates-app', {
      flags: {
        'app.attention': needsAttention(a),
        'app.broken': !!a.load_error,
        'app.same-version': a.update_available && a.disk_version === a.loaded_version,
        'app.removed': a.removed_on_disk,
        'app.requested': a.request !== null,
        'app.held': holdsFor(holds, a.target).length > 0,
        'can.hold': can.hold,
        'can.apply': can.apply,
      },
    }),
    data: {
      'app.name': name,
      'app.version': `${a.loaded_version ?? 'not loaded'}${a.update_available && a.disk_version ? ` → ${a.disk_version}` : ''}`,
      'app.problem': a.load_error ? `Load error: ${a.load_error}` : '',
      'app.request': a.request ? `From ${a.request.requested_by}: ${a.request.note}` : '',
    },
  }
}

export function historyRow(h: UpdateHistoryRow, now: number) {
  const release = typeof h.after.release === 'string' ? h.after.release : null
  const what = h.target !== 'platform' ? `${h.target.slice(8)} reloaded`
    : h.after.installer === true ? `Update to v${release ?? '?'} started` : 'Platform restart'
  return {
    id: h.id,
    title: `${ago(h.at, now)} · ${what} by ${h.by}`,
    problem: h.ok ? '' : `error: ${h.error ?? 'unknown'}`,
    overrode: h.overrode.length ? 'overrode a hold' : '',
  }
}

/** The updates screen: how the check stands, the holds, the platform, every app and what was applied lately. checking:
 *  this page's own Check now is waiting for its answer (the hive also says so for a check another page started). */
export function updatesScreen(res: ResourceState<UpdatesOverview>, can: Can, compose: Compose, now = Date.now(), when: When = local,
  checking = false): Composed {
  const o = (res.status === 'ready' || res.status === 'empty') && res.data ? res.data : null
  const appName = appNamer(o?.apps ?? [])
  const holds = o ? o.holds.map((h) => holdItem(h, appName, can, now, when, compose)) : []
  const apps = o ? o.apps.map((a) => appItem(a, o.holds, can, compose)) : []
  const waiting = o ? o.apps.filter(needsAttention).length : 0
  const p = o?.platform
  const commits = p?.commits_waiting ?? []
  const history = o ? o.history.map((h) => historyRow(h, now)) : []
  // An installed Mac hive's updater: the release it offers, or its word that the running one is the newest.
  const inst = p?.installer ?? null
  const offer = inst?.offer ?? null
  const checkingNow = checking || !!inst?.checking
  return withResource(res, {
    data: {
      'holds.all': holds,
      'holds.heading': `On hold: don't interrupt (${holds.length})`,
      'platform.running': p ? `${running(p)}, started ${ago(p.started_at, now)}.` : '',
      'platform.waiting': `${plural(commits.length, 'change')} waiting for a restart.`,
      'platform.commits': commits.map((c) => `${c.commit} ${c.subject}`).join('\n'),
      'platform.request': p?.request ? `From ${p.request.requested_by}: ${p.request.note}` : '',
      // the updater's word that the running release is the newest, as current only while its last check worked: a
      // tester's page said "Up to date" from a check 23 hours old while two newer releases were out (16 November)
      'platform.current': !inst?.newest ? ''
        : inst.check_failed
          ? (inst.checked_at ? `Last checked ${ago(inst.checked_at, now)}, when v${inst.newest} was the newest release.`
            : `v${inst.newest} was the newest release when this hive last checked.`)
          : `Up to date: v${inst.newest} is the newest release${inst.checked_at ? ` (checked ${ago(inst.checked_at, now)})` : ''}.`,
      'platform.offer': offer ? `Omega Hive ${offer.label} is ready to install.${offer.notes ? ` ${offer.notes}` : ''}` : '',
      'platform.offer-how': 'Update now downloads it, then a Terminal window installs it and your hive opens again on the new version. Its minds, files and settings stay.',
      'platform.deferred': inst?.deferred_until ? `You chose Not now in the update dialog, which asks again ${when(inst.deferred_until)}.` : '',
      'platform.updating': offer ? `Updating to ${offer.label}: once the download finishes, a Terminal window installs it and the hive opens again.` : '',
      'platform.failed': inst?.failed && offer ? `The last try to install ${offer.label} did not finish: ${inst.failed.error}` : '',
      'platform.check-failed': inst?.check_failed
        ? `${inst.checked_at ? 'Later checks failed' : 'This hive could not check for a newer release'}: ${inst.check_failed.reason}${
          inst.check_failed.at ? ` (${inst.checked_at ? 'last tried' : 'tried'} ${ago(inst.check_failed.at, now)})` : ''}.` : '',
      'apps.all': apps,
      'apps.attention': `${waiting} of ${apps.length} need attention.`,
      'apps.calm': `All ${plural(apps.length, 'app')} are running what is on disk.`,
      'history.all': history,
    },
    facts: {
      counts: {
        'holds.all': holds.length,
        'apps.all': apps.length,
        'apps.waiting': waiting,
        'platform.commits': commits.length,
        'history.all': history.length,
      },
      flags: {
        'updates.loaded': o !== null,
        'can.hold': can.hold,
        'can.apply': can.apply,
        'can.request': can.request,
        'can.check': can.check,
        'platform.update': !!p?.update_available,
        'platform.supervised': !!p?.supervised,
        'platform.held': o ? holdsFor(o.holds, 'platform').length > 0 : false,
        'platform.requested': !!p?.request,
        'platform.release': !!p?.running_release,
        'platform.current': !!inst?.newest && !offer,
        'platform.offer': !!offer,
        'platform.deferred': !!offer && !!inst?.deferred_until,
        'platform.updating': !!offer && !!inst?.updating,
        'platform.failed': !!offer && !!inst?.failed,
        'platform.installer': inst !== null,
        'platform.busy': !!inst?.updating,
        'platform.checking': checkingNow,
        'platform.check-failed': !!inst?.check_failed,
        'apps.one': apps.length === 1,
      },
    },
  })
}
