// Types for Design's pinned native scene module (scene.mjs, vendored byte-exact; see PIN.json). Declarations only.
export const clone: <T>(value: T) => T
export function canonical(value: unknown): string
export function digest(value: unknown): Promise<string>
export const validFontFamily: (value: unknown) => boolean
/** Throws Error('Invalid scene' | 'Invalid canvas' | 'Invalid criteria' | 'Invalid elements' | 'Invalid element identity' | 'Element outside canvas' | 'Invalid text' | 'Invalid font family' | 'Invalid fill' | 'Invalid rectangle radius' | 'Image must be an embedded PNG or JPEG'). */
export function validate<S>(scene: S): S
export function initial<S>(scene: S): Promise<{ scene: S; revision: number; digest: string; parent: null; changes: [] }>
export function apply<S>(current: { scene: S; revision: number; digest: string }, expected: string, changes: unknown[]): Promise<{ scene: S; revision: number; digest: string; parent: { scene_id: string; revision: number; digest: string }; changes: unknown[] }>
export function svg(scene: unknown): string
export function wrapText(element: { text?: string; fontSize?: number; width: number; height: number }): { lines: string[]; overflow: boolean }
