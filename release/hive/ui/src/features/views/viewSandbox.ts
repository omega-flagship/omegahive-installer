/**
 * Purpose: takes every way out of a view's worker away before a view's MeTTa runs there, and says whether it did.
 *
 * A view's MeTTa reaches JavaScript only through operations registered on its runner (mettaView.ts registers three
 * pure ones) and through MeTTaScript's compiler, which turns MeTTa rules into JavaScript with `new Function` and falls
 * back to its interpreter when that throws. So the worker's scope loses the global Function and eval (the compiler then
 * never compiles a view's rules), and every name that reaches the network, storage or another context. The hive also
 * serves the worker's script with a CSP of no network and no code generation (hive/core/views.py VIEW_WORKER_CSP), so
 * the browser enforces the same thing; the report lets the page refuse to draw in a worker where either failed.
 */

/** Names in a worker's scope that reach the network, storage, another context or a new thread. */
export const WAYS_OUT = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts',
  'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'RTCPeerConnection',
] as const

export interface SandboxReport {
  ok: boolean
  /** what is still there that should not be: a name from WAYS_OUT, or Function when code can still be generated */
  open: string[]
}

type Scope = Record<string, unknown>

/** Remove each way out from `scope` and every prototype it inherits from, and replace Function and eval with ones that
 *  refuse (Function keeps its prototype, so `instanceof Function` still answers as before).
 *  Time: O(|WAYS_OUT| x prototype chain length). */
export function harden(scope: Scope): void {
  for (const name of WAYS_OUT) {
    for (let o: object | null = scope; o; o = Object.getPrototypeOf(o)) {
      const own = Object.getOwnPropertyDescriptor(o, name)
      if (!own) continue
      if (own.configurable) delete (o as Scope)[name]
      else if ('value' in own && own.writable) (o as Scope)[name] = undefined
    }
  }
  const real = scope.Function as { prototype: unknown }
  const refuse = function NoCodeGeneration() { throw new EvalError('a view does not generate code') }
  refuse.prototype = real.prototype
  scope.Function = refuse
  scope.eval = function NoEval() { throw new EvalError('a view does not evaluate code') }
}

/** What is still reachable in `scope` that harden should have taken away. */
export function sandboxReport(scope: Scope): SandboxReport {
  const open: string[] = WAYS_OUT.filter((name) => typeof scope[name] !== 'undefined')
  let generates = true
  try {
    new (scope.Function as new (body: string) => unknown)('return 1')
  } catch {
    generates = false
  }
  if (generates) open.push('Function')
  return { ok: open.length === 0, open }
}
