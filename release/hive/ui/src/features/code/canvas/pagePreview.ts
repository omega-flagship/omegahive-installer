// Purpose: show the person's copy of a small web app as the page a visitor would see: its index.html, style.css and
// app.js, read at one generation of the copy, made into one sandboxed document.
import { appDocument, frameNonce } from '../../../lib/appFrame'

/** What a page needs: an index.html that loads ./style.css and ./app.js, the installer's small app (setup-code.sh). */
export const PAGE_FILES = ['index.html', 'style.css', 'app.js'] as const
type PageFile = (typeof PAGE_FILES)[number]

export type PageView =
  | { kind: 'reading' }
  | { kind: 'shown'; html: string; generation: number }
  | { kind: 'failed'; text: string }

type Call = <T>(method: 'GET' | 'POST', p: string, body?: unknown, query?: Record<string, string>) => Promise<T>

export const PAGE_FORMAT = 'This copy’s index.html doesn’t load ./style.css and ./app.js, so it can’t be shown as a page here.'

/** Whether a copy with these files can be shown as a page at all (the button is offered only then). */
export const hasPage = (files: readonly string[]) => PAGE_FILES.every((f) => files.includes(f))

const uuid = () => crypto.randomUUID()
/** this page's origin, as LivePair takes it (appDocument needs an http(s) origin; a test has no location) */
const pageOrigin = () => (typeof location !== 'undefined' && /^https?:/.test(location.origin) ? location.origin : 'http://localhost')

/**
 * The three files as one document, the way Create's plan shows its running page (createPlan/LivePair, through
 * lib/appFrame appDocument): its CSP is the first element, the style and the app script are inlined, and nothing
 * loads by URL, so in a frame sandboxed to scripts only it has no network, no forms and no hive origin.
 * Null when index.html does not load ./style.css and ./app.js as appDocument requires.
 */
export function pageDocument(files: Record<PageFile, string>): string | null {
  try {
    return appDocument(files, pageOrigin(), uuid(), frameNonce()).html
  } catch {
    return null
  }
}

/**
 * The copy's page now: the workspace's current generation, then its three files at exactly that generation, so the
 * page is one state of the copy and never a mix of two.
 * Cost: 1 + 3 GETs through the Code relay, the three files at once.
 */
export async function readPage(call: Call, wsId: string): Promise<PageView> {
  try {
    const head = await call<{ generation: number }>('GET', `/v1/workspaces/${wsId}`)
    const generation = String(head.generation)
    const read = await Promise.all(PAGE_FILES.map((path) => call<{ content: string }>('GET', `/v1/workspaces/${wsId}/files`, undefined, { path, expected_generation: generation })))
    const files = Object.fromEntries(PAGE_FILES.map((f, i) => [f, read[i].content])) as Record<PageFile, string>
    const html = pageDocument(files)
    return html === null ? { kind: 'failed', text: PAGE_FORMAT } : { kind: 'shown', html, generation: head.generation }
  } catch (e) {
    return { kind: 'failed', text: `Your page couldn’t be read: ${e instanceof Error ? e.message : String(e)}` }
  }
}
