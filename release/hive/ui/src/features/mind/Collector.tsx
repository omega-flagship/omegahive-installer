/**
 * Collects the person's swarm talk into this browser's memory: when their memory is ready (on load, and after each
 * sign-in), every few minutes while the page is open and showing, and when it is shown again. Renders nothing.
 */
import { useEffect } from 'react'
import { askMemory, useAskMemory } from '../../lib/askMemory'
import { useHive } from '../../store/store'
import { useMind } from './store'
import { folderLink, startMirror } from './folder'

export const COLLECT_EVERY_MS = 3 * 60_000

export function MindInboxCollector() {
  const mem = useAskMemory()
  const client = useHive((s) => s.client)
  // SIM ONLY: the browser checks read how many copies the invented hive still holds (acknowledged ones are gone)
  useEffect(() => {
    if (client?.mode !== 'sim') return
    const w = window as unknown as { __hiveMind?: unknown }
    const host = (client as unknown as { mindHost?: { items(after: null, limit: number): { items: unknown[] } } }).mindHost
    w.__hiveMind = { held: () => host?.items(null, 50).items.length ?? null, collect: () => useMind.getState().collectNow() }
    return () => {
      delete w.__hiveMind
    }
  }, [client])
  const who = mem.owner && mem.ready ? `${mem.owner.hive}\n${mem.owner.principal}` : null
  useEffect(() => {
    if (!who) return
    // the person's mind itself (name and presence for the Ask chip and You), read once per person
    void useMind.getState().load()
    // M2: their linked folder, if any, and its mirror (Chromium; nothing elsewhere)
    void folderLink.attach(askMemory.getView().owner)
    const stopMirror = startMirror()
    const collect = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void useMind.getState().collectNow()
    }
    collect()
    const timer = setInterval(collect, COLLECT_EVERY_MS)
    const onShow = () => {
      if (document.visibilityState === 'visible') collect()
    }
    document.addEventListener('visibilitychange', onShow)
    return () => {
      stopMirror()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [who])
  return null
}
