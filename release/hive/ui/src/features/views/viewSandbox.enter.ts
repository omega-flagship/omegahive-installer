/**
 * Purpose: bares the scope it is evaluated in (viewSandbox.ts harden). Only the view worker imports it, first, so the
 * worker's scope is bare before MeTTaScript and the view runtime are evaluated; nothing else may import it.
 */
import { harden } from './viewSandbox'

harden(globalThis as unknown as Record<string, unknown>)
