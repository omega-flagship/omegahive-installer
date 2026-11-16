import type { ScreenPlan } from './screenSpace'

/**
 * Blocks the screens asked for that nothing draws yet (each fell back to its role's block): one entry per screen and
 * block, with when it was first seen. This is the queue a coding mind takes them from; filing them as hive tasks is the
 * next step (the hive side is a small interface of its own). Nothing about a person is kept here.
 */
export interface MissingBlock { screen: string; wanted: string; drawnAs: string | null; firstSeen: number }

const seen = new Map<string, MissingBlock>()
const listeners = new Set<() => void>()

export function noteMissing(plan: ScreenPlan, now: number = Date.now()): void {
  let added = false
  for (const m of plan.missing) {
    const key = `${m.screen}\n${m.wanted}`
    if (seen.has(key)) continue
    seen.set(key, { screen: m.screen, wanted: m.wanted, drawnAs: m.drawnAs, firstSeen: now })
    added = true
  }
  if (added) for (const l of listeners) l()
}

export function missingBlocks(): MissingBlock[] {
  return [...seen.values()].sort((a, b) => a.firstSeen - b.firstSeen || a.screen.localeCompare(b.screen))
}

export function onMissingBlock(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Tests only: start from an empty queue. */
export function clearMissingBlocks(): void {
  seen.clear()
  reported.clear()
}

// ---- reporting to the hive: each block once per page session, batched, best-effort (a failure is silent: the next
// session reports it again, and the hive dedupes on (ui_release, screen, wanted))
export type Report = { ui_release: string; screen: string; wanted: string; drawn_as: string | null }
type Send = (items: Report[]) => Promise<unknown>
const reported = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null

/** A short digest of the screens the page runs: the same screens give the same release name. */
export function screensRelease(sources: readonly (readonly [string, string])[]): string {
  let h = 0x811c9dc5
  for (const [, src] of sources) for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 0x01000193)
  return `scr-${(h >>> 0).toString(16).padStart(8, '0')}`
}

/** Send what has not been reported yet, after `delayMs`, in batches the hive accepts (up to 20). */
export function reportMissing(send: Send | undefined, release: string, delayMs = 2000): void {
  if (!send || timer) return
  timer = setTimeout(() => {
    timer = null
    const fresh = missingBlocks().filter((m) => !reported.has(`${m.screen}\n${m.wanted}`))
    for (let i = 0; i < fresh.length; i += 20) {
      const batch = fresh.slice(i, i + 20)
      for (const m of batch) reported.add(`${m.screen}\n${m.wanted}`)
      send(batch.map((m) => ({ ui_release: release, screen: m.screen, wanted: m.wanted, drawn_as: m.drawnAs }))).catch(() => {
        for (const m of batch) reported.delete(`${m.screen}\n${m.wanted}`)   // let a later page report it
      })
    }
  }, delayMs)
}
