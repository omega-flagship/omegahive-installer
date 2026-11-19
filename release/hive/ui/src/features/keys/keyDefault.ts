/**
 * What the add-key form sends as `default`, and what it says about it. Only a hive admin may set the hive's default key
 * (POST /api/keys answers a member's `default` with 403 admin_only), and a member's key list holds only their own keys,
 * so it never shows them a default: a member's add sends `default: false` (the server also stores a member's key as never
 * the default) and is told the key is their own. An admin's first key for a provider becomes its default; after that the
 * admin chooses.
 */
export type KeyDefault = { send: boolean; choose: boolean }

export function keyDefault({ admin, hasDefault, makeDefault }: { admin: boolean; hasDefault: boolean; makeDefault: boolean }): KeyDefault {
  if (!admin) return { send: false, choose: false }
  return hasDefault ? { send: makeDefault, choose: true } : { send: true, choose: false }
}
