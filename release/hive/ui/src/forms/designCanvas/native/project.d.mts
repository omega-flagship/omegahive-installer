// Types for Design's pinned native project module (project.mjs, vendored byte-exact; see PIN.json).
export function createProject(brief: { id: string; purpose: string; audience: string; criteria: string[] }): Promise<Record<string, unknown>>
export function verifyProject(project: unknown): Promise<unknown>
