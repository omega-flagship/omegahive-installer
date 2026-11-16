import { describe, expect, it } from 'vitest'

/**
 * r1.14d (Design 205400Z): the simulated Studio frame's app.js is a plain JavaScript module served as text (APP_JS is a
 * String.raw template), never transpiled. A TypeScript annotation inside it compiles in the outer .ts file but breaks the
 * frame in the browser. This checks the EMITTED text itself with the same engine's module syntax check.
 */
describe('the simulated Studio frame scripts are valid JavaScript as served', () => {
  it('app.js parses as an ES module (node --check)', async () => {
    const { SIM_STUDIO_FILES } = await import('./studioFrame')
    const req = (m: string) => import(/* @vite-ignore */ 'node:' + m)
    const fs = (await req('fs')) as unknown as { mkdtempSync(p: string): string; writeFileSync(p: string, d: string): void; rmSync(p: string, o: object): void }
    const os = (await req('os')) as unknown as { tmpdir(): string }
    const cp = (await req('child_process')) as unknown as { spawnSync(cmd: string, args: string[], o: object): { status: number | null; stderr: string } }
    const dir = fs.mkdtempSync(`${os.tmpdir()}/sim-frame-`)
    try {
      const file = `${dir}/app.mjs`
      fs.writeFileSync(file, SIM_STUDIO_FILES['app.js'])
      const r = cp.spawnSync((globalThis as unknown as { process: { execPath: string } }).process.execPath, ['--check', file], { encoding: 'utf8' })
      expect(r.stderr, 'app.js must be plain JavaScript').toBe('')
      expect(r.status).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it('the receiver guard is present and takes only a bare 64-hex body hash', async () => {
    const { SIM_STUDIO_FILES } = await import('./studioFrame')
    expect(SIM_STUDIO_FILES['app.js']).toContain("const bareUpload = (u) => !!u && typeof u === 'object' && typeof u.body_sha256 === 'string' && /^[a-f0-9]{64}$/.test(u.body_sha256)")
  })
})
