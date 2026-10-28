/** Production output assertion only: never delete or strip fixture files to make a build pass. */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const output = fileURLToPath(new URL('../dist/', import.meta.url))
async function assertNoFixture(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'p8-memory-browser.html') throw new Error('P8 browser fixture HTML must not ship in production output')
    if (entry.isDirectory()) await assertNoFixture(path.join(directory, entry.name))
  }
}
await assertNoFixture(output)
