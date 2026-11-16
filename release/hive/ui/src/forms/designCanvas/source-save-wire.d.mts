// Types for Design's byte-exact JSON confirmation wire helper; see SOURCE_SAVE_WIRE_PIN.json.
export function sourceSaveParams<R>(source: unknown, reference: R, options?: { limit?: number }): { editable_source_json: string; source: R }
