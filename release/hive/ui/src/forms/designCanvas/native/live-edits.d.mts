// Types for Design's pinned native live-edits module (live-edits.mjs, vendored byte-exact; see PIN.json). Tests use it
// to make genuine native maker traces.
export function liveEdits(o: { streamId: string; sceneId: string }): { receive(current: unknown, event: unknown): Promise<{ current: { scene: unknown; revision: number; digest: string }; receipt: unknown }> }
