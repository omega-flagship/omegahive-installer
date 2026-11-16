// Types for Design's pinned native source verifier (source.mjs, vendored byte-exact; see PIN.json).
export function verifySource<S>(source: S, depth?: number): Promise<S>
