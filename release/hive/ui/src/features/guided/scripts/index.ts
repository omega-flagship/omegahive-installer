import type { GuideScript } from '../types'
import { APP_SCRIPTS } from './apps'
import { BRAIN_SCRIPTS } from './brain'
import { HIVE_SCRIPTS } from './hive'
import { MODULE_SCRIPTS } from './modules'
import { PEOPLE_SCRIPTS } from './people'
import { STUB_SCRIPTS } from './stubs'

/** Every guided demo, ready ones first. */
export const GUIDE_SCRIPTS: GuideScript[] = [...HIVE_SCRIPTS, ...BRAIN_SCRIPTS, ...APP_SCRIPTS, ...PEOPLE_SCRIPTS, ...MODULE_SCRIPTS, ...STUB_SCRIPTS]

/**
 * Scripts that play only in demo mode (the showreel, features/showreel): registered when it starts on a simulated
 * hive, never listed among the demos, never matched by words, and unknown to a real hive's conductor (not_declared).
 */
const demoOnly = new Map<string, GuideScript>()
/** whether the hive is still the simulator in demo mode (given with the scripts; D4 r2) */
let stillDemo: () => boolean = () => false
export function registerDemoScripts(list: GuideScript[], demo: () => boolean): void {
  stillDemo = demo
  for (const s of list) demoOnly.set(s.id, s)
}
/** Forget the demo-only scripts (the client is no longer the demo simulator, or the showreel went away). */
export function clearDemoScripts(): void {
  demoOnly.clear()
  stillDemo = () => false
}
/** A demo-only script, only while the client is still the demo simulator; the first look after it is not clears them all. */
function demoScript(id: string): GuideScript | undefined {
  if (!demoOnly.size) return undefined
  if (!stillDemo()) {
    clearDemoScripts()
    return undefined
  }
  return demoOnly.get(id)
}

export const scriptById = (id: string): GuideScript | undefined => GUIDE_SCRIPTS.find((s) => s.id === id) ?? demoScript(id)
