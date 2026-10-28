/**
 * M1 bookkeeping: whether what the person's mind remembers has changed since they last saved it to a file (the nudge),
 * and the download itself. Kept per person and hive in this browser (localStorage; the nudge's dismissal for this
 * session only). Keys carry a fingerprint, never the principal. Storage that refuses is treated as "never saved".
 */
import { dbName, sha256, type MemoryOwner, type MemoryView } from '../../lib/askMemory'

const SAVED = 'omegahive-mind-memory-saved:'
const DISMISSED = 'omegahive-mind-memory-nudge:'

/** a memory that never forgot anything */
const forgetsNone = '0|'

const keyOf = (o: MemoryOwner) => sha256(`mind-memory-key:v1\n${dbName(o)}`).slice(0, 32)

/**
 * A fingerprint of what is remembered now (ids and when each last changed) and of what was forgotten (the forget
 * markers and the forget-everything time, r1.1): equal marks, nothing new to save.
 */
export function memoryMark(v: Pick<MemoryView, 'beliefs' | 'talks' | 'forgets'>): string {
  const parts = [...v.beliefs.map((b) => `b:${b.id}:${b.updated_at}`), ...v.talks.map((t) => `t:${t.id}`), `f:${v.forgets}`].sort()
  return sha256(parts.join('\n'))
}

const read = (store: () => Storage, key: string): string | null => {
  try {
    return store().getItem(key)
  } catch {
    return null
  }
}
const write = (store: () => Storage, key: string, value: string) => {
  try {
    store().setItem(key, value)
  } catch {
    /* storage refused: the nudge simply shows again */
  }
}

/** Remember that this is what was saved to a file (after the download was handed to the browser). */
export function markSaved(o: MemoryOwner, mark: string): void {
  write(() => localStorage, SAVED + keyOf(o), mark)
}

/** There is something remembered that is not in the last file saved (and the nudge was not put away this session). */
export function needsSaving(o: MemoryOwner | null, v: Pick<MemoryView, 'beliefs' | 'talks' | 'forgets' | 'ready'>): boolean {
  // something remembered, or something forgotten (a marker or a forget everything) not yet in a saved file
  if (!o || !v.ready || (!v.beliefs.length && !v.talks.length && v.forgets === forgetsNone)) return false
  const mark = memoryMark(v)
  if (read(() => localStorage, SAVED + keyOf(o)) === mark) return false
  return read(() => sessionStorage, DISMISSED + keyOf(o)) !== mark
}

/** Put the nudge away for this session, until something changes again. */
export function dismissNudge(o: MemoryOwner, v: Pick<MemoryView, 'beliefs' | 'talks' | 'forgets'>): void {
  write(() => sessionStorage, DISMISSED + keyOf(o), memoryMark(v))
}

/** The file's name: plain, dated to the second (two saves in a day never collide), nothing about who. */
export function fileName(now: number): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `omegahive-mind-memory-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`
}

/** Hand the file to the browser's own download (nothing leaves this machine). */
export function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

const LOST = 'omegahive-mind-lost:'
/** counts already shown in this page's life (the line stays for the session it first appeared in) */
const shownNow = new Map<string, string>()

/**
 * The hive's dropped / expired counts are running totals per person (r1.1 ruling): the line about conversations not
 * collected in time shows only when either has RISEN since it was last shown here (kept per person and hive, in this
 * browser), and stays for the rest of this page's life once shown.
 */
export function lostRose(o: MemoryOwner, dropped: number, expired: number): boolean {
  const key = LOST + keyOf(o)
  const now = `${dropped},${expired}`
  if (shownNow.get(key) === now) return true
  const [d, e] = (read(() => localStorage, key) ?? '0,0').split(',').map((x) => Number(x) || 0)
  if (dropped <= d && expired <= e) return false
  write(() => localStorage, key, now)
  shownNow.set(key, now)
  return true
}
