/**
 * The frame-ops wire names and the read route, in one place (PROGRAMS.md §9c). No imports, so the live client can use
 * it without pulling in the bridge. Platform's final shapes are a change here (and the parse/reply functions in
 * lib/frameOps.ts).
 */
export const FRAME_WIRE = {
  appSetup: { request: 'app-setup', result: 'app-setup-result' },
  appOpen: { request: 'app-open', result: 'app-open-result' },
  read: { request: 'read', result: 'read-result', refused: 'read-refused', route: (id: string) => `/api/programs/${encodeURIComponent(id)}/read` },
  openUrl: { request: 'open-url', opened: 'url-opened', refused: 'url-refused' },
  showFile: { request: 'show-file', shown: 'file-shown', closed: 'file-closed', refused: 'file-refused' },
  back: { request: 'back-request', escape: 'escape' },
  layout: { request: 'layout', set: 'layout-set' },
  goal: { subscribe: 'subscribe', unsubscribe: 'unsubscribe', subscribed: 'goal.subscribed', unsubscribed: 'goal.unsubscribed', refused: 'goal.refused', status: 'goal.status' },
} as const
