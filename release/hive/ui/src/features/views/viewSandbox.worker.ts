/**
 * Purpose: the thread one open view's MeTTa runs on. Its first import bares the scope (viewSandbox.enter.ts) before
 * MeTTaScript or the view runtime is even evaluated; then it tells the page what it found and answers the page's
 * requests one by one (viewProtocol.ts). The hive serves this script with no network and no code generation
 * (hive/core/views.py VIEW_WORKER_CSP), so the browser holds it to the same.
 */
import './viewSandbox.enter'
import { sandboxReport } from './viewSandbox'
import { viewAnswerer, type ViewReply, type ViewRequest } from './viewProtocol'

// the worker's own scope (the app's tsconfig has DOM types, not WebWorker ones)
const scope = self as unknown as { postMessage(m: ViewReply): void; onmessage: ((e: MessageEvent<ViewRequest>) => void) | null }
const report = sandboxReport(self as unknown as Record<string, unknown>)
const answer = viewAnswerer(report)

scope.onmessage = ({ data }) => scope.postMessage(answer(data))
scope.postMessage({ id: 0, ready: report })
