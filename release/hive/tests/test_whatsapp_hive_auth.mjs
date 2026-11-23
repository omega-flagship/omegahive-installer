// Purpose: Test both Baileys auth adapters and bridge identity guards with a loopback Hive route.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const copies = ['channels/whatsapp_bridge', 'modules/channel_whatsapp/src/whatsapp_bridge']
const entriesRoute = '/api/agent/connectors/whatsapp/entries'

async function standInHive(t) {
  const requests = []
  const files = new Map()
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    const authorization = req.headers.authorization
    requests.push({ method: req.method, url: req.url, authorization, body })
    res.setHeader('Content-Type', 'application/json')
    if (req.method !== 'POST' || req.url !== entriesRoute || authorization !== 'Bearer mind-token') {
      res.statusCode = 403
      res.end(JSON.stringify({ error: { code: 'connector_not_installed', message: 'Install WhatsApp' } }))
      return
    }
    for (const name of body.delete ?? []) files.delete(name)
    for (const [name, value] of Object.entries(body.set ?? {})) files.set(name, value)
    const values = Object.fromEntries((body.get ?? []).map(name => [name, files.get(name) ?? null]))
    res.end(JSON.stringify({ values }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const env = { HIVE_API_URL: `http://127.0.0.1:${server.address().port}/`, HIVE_WS_TOKEN: 'mind-token' }
  return { env, files, requests }
}

async function startBridge(t, folder, env) {
  // Keep socket startup suspended at Baileys' version lookup while the bridge serves loopback HTTP.
  const preload = `
    const realFetch = globalThis.fetch
    globalThis.fetch = (...args) => new URL(args[0]).hostname === '127.0.0.1'
      ? realFetch(...args)
      : new Promise(() => {})
  `
  const processArgs = ['--import', 'data:text/javascript,' + encodeURIComponent(preload), 'bridge.mjs']
  const child = spawn(process.execPath, processArgs, {
    cwd: fileURLToPath(folder),
    env: { ...process.env, ...env, OMEGACLAW_WA_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const finished = once(child, 'close')
  t.after(async () => {
    child.kill()
    await finished
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  for await (const line of lines) {
    const result = /Bridge listening on 127\.0\.0\.1:(\d+)/.exec(line)
    if (result) return `http://127.0.0.1:${result[1]}`
  }
  await finished
  throw new Error(`Test bridge exited without listening: ${stderr}`)
}

for (const copy of copies) {
  const folder = new URL(`../../${copy}/`, import.meta.url)

  test(`${copy} transports Baileys credentials and keys through the Hive`, async t => {
    const hive = await standInHive(t)
    for (const [key, value] of Object.entries(hive.env)) {
      const original = process.env[key]
      process.env[key] = value
      t.after(() => {
        if (original === undefined) delete process.env[key]
        else process.env[key] = original
      })
    }
    const { useHiveAuthState } = await import(new URL('hive-auth.mjs', folder))
    const { BufferJSON, proto } = await import(new URL('node_modules/@whiskeysockets/baileys/lib/index.js', folder))
    const auth = await useHiveAuthState()
    assert.equal(auth.state.creds.registered, false)
    assert.equal(hive.files.has('creds.json'), false)
    auth.state.creds.me = { name: 'Example', id: '100@s.whatsapp.net' }
    await auth.saveCreds()

    let seenIdentity
    const reopened = await useHiveAuthState(creds => { seenIdentity = creds.me })
    assert.deepEqual(seenIdentity, auth.state.creds.me)
    assert.equal(JSON.stringify(reopened.state.creds, BufferJSON.replacer),
      JSON.stringify(auth.state.creds, BufferJSON.replacer))
    assert.ok(reopened.state.creds.noiseKey.private instanceof Uint8Array)

    const key = proto.Message.AppStateSyncKeyData.fromObject({
      keyData: Buffer.from([17, 23]), fingerprint: { rawId: 4, currentIndex: 5, deviceIndexes: [2] },
    })
    const start = hive.requests.length
    await auth.state.keys.set({
      'pre-key': { '1': { private: Buffer.from([41]) } },
      'app-state-sync-key': { 'A/B:2=': key },
    })
    assert.equal(hive.requests.length, start + 1)
    assert.deepEqual(Object.keys(hive.requests.at(-1).body.set).sort(),
      ['app-state-sync-key-A__B-2=.json', 'pre-key-1.json'])
    assert.deepEqual(await reopened.state.keys.get('pre-key', ['1', 'missing']),
      { '1': { private: Buffer.from([41]) }, missing: null })
    const keys = await reopened.state.keys.get('app-state-sync-key', ['A/B:2='])
    assert.ok(keys['A/B:2='] instanceof proto.Message.AppStateSyncKeyData)
    assert.deepEqual(keys['A/B:2='], key)

    await auth.state.keys.set({ 'pre-key': { '1': null, '2': { private: Buffer.from([42]) } } })
    assert.deepEqual(hive.requests.at(-1).body.delete, ['pre-key-1.json'])
    assert.deepEqual(await auth.state.keys.get('pre-key', ['1', '2']),
      { '1': null, '2': { private: Buffer.from([42]) } })
    assert.ok(hive.requests.every(({ authorization, method, url }) =>
      authorization === 'Bearer mind-token' && method === 'POST' && url === entriesRoute))
  })

  test(`${copy} checks the selected credential source before starting`, async t => {
    const hive = await standInHive(t)
    const scratch = await mkdtemp(path.join(tmpdir(), 'whatsapp-client-'))
    t.after(() => rm(scratch, { recursive: true, force: true }))
    const checkout = path.join(scratch, 'checkout')
    await mkdir(checkout)
    for (const name of ['bridge.mjs', 'hive-auth.mjs']) await cp(new URL(name, folder), path.join(checkout, name))
    await symlink(fileURLToPath(new URL('node_modules', folder)), path.join(checkout, 'node_modules'), 'dir')
    const initialFiles = (await readdir(checkout)).sort()
    const mind = path.join(scratch, 'mind')
    const creds = JSON.stringify({ me: { name: 'Example account' } })
    const env = {
      ...process.env,
      ...hive.env,
      OMEGACLAW_MEMORY_DIR: mind,
      OMEGACLAW_WA_EXPECT_SELF_NAME: 'Different account',
      OMEGACLAW_WA_FORBID_SELF_NAMES: '',
      OMEGACLAW_WA_AUTH: 'hive',
      OMEGACLAW_WA_AUTH_DIR: path.join(checkout, 'ignored-auth'),
    }
    hive.files.set('creds.json', creds)
    await assert.rejects(exec(process.execPath, ['bridge.mjs'], { cwd: checkout, env }), {
      code: 78, stderr: /expected identity Different account but found name=Example account/,
    })
    assert.deepEqual(hive.requests, [{
      method: 'POST', url: entriesRoute, authorization: 'Bearer mind-token', body: { get: ['creds.json'] },
    }])
    assert.deepEqual((await readdir(checkout)).sort(), initialFiles)
    assert.deepEqual(await readdir(mind), ['inbox'])
    await assert.rejects(exec(process.execPath, ['bridge.mjs'], {
      cwd: checkout, env: { ...env, HIVE_WS_TOKEN: 'uninstalled' },
    }), { code: 78, stderr: /Hive HTTP 403: connector_not_installed: Install WhatsApp/ })
    assert.deepEqual((await readdir(checkout)).sort(), initialFiles)

    const authDir = path.join(checkout, 'auth')
    await mkdir(authDir)
    await writeFile(path.join(authDir, 'creds.json'), creds)
    await assert.rejects(exec(process.execPath, ['bridge.mjs'], {
      cwd: checkout, env: { ...env, OMEGACLAW_WA_AUTH: '', OMEGACLAW_WA_AUTH_DIR: '' },
    }), { code: 78, stderr: /expected identity Different account but found name=Example account/ })
    assert.equal(await readFile(path.join(authDir, 'creds.json'), 'utf8'), creds)
    assert.equal(hive.requests.length, 2)
  })

  test(`${copy} protects every Hive bridge route with the mind's credential`, async t => {
    const hive = await standInHive(t)
    const scratch = await mkdtemp(path.join(tmpdir(), 'whatsapp-loopback-'))
    t.after(() => rm(scratch, { recursive: true, force: true }))
    const base = await startBridge(t, folder, {
      ...hive.env,
      OMEGACLAW_MEMORY_DIR: path.join(scratch, 'mind'),
      OMEGACLAW_WA_AUTH: 'hive',
      OMEGACLAW_WA_AUTH_DIR: path.join(scratch, 'ignored-auth'),
    })
    for (const route of ['/status', '/health', '/messages', '/inbox']) {
      assert.equal((await fetch(base + route)).status, 401, route)
    }
    assert.equal((await fetch(base + '/send', { method: 'POST' })).status, 401)
    const derive = token => createHmac('sha256', token).update('omegahive whatsapp bridge/1').digest()
    const otherKey = derive('other-mind').toString('hex')
    const other = { headers: { Authorization: `Bearer ${otherKey}` } }
    assert.equal((await fetch(base + '/status', other)).status, 401)
    assert.equal((await fetch(base + '/messages', other)).status, 401)

    const key = derive(hive.env.HIVE_WS_TOKEN)
    const own = { headers: { Authorization: `Bearer ${key.toString('hex')}` } }
    assert.equal((await fetch(base + '/status', own)).status, 200)
    assert.equal((await fetch(base + '/health', own)).status, 200)
    assert.equal((await fetch(base + '/messages', own)).status, 200)

    const nonce = '0123456789abcdef'.repeat(2)
    const sign = prefix => createHmac('sha256', key).update(prefix + nonce).digest('hex')
    const probe = { headers: { 'X-Hive-WhatsApp-Challenge': nonce, Authorization: `Bearer ${sign('status-request:')}` } }
    const checked = await fetch(base + '/status', probe)
    assert.equal(checked.status, 200)
    assert.deepEqual(await checked.json(), { ok: true, proof: sign('status-response:') })
    assert.equal((await fetch(base + '/health', probe)).status, 401)
  })

  test(`${copy} keeps standalone bridge HTTP accessible without a bearer`, async t => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'whatsapp-standalone-'))
    t.after(() => rm(scratch, { recursive: true, force: true }))
    const base = await startBridge(t, folder, {
      HIVE_API_URL: '',
      HIVE_WS_TOKEN: '',
      OMEGACLAW_MEMORY_DIR: path.join(scratch, 'mind'),
      OMEGACLAW_WA_AUTH: '',
      OMEGACLAW_WA_AUTH_DIR: path.join(scratch, 'auth'),
    })
    assert.equal((await fetch(base + '/health')).status, 200)
    assert.equal((await fetch(base + '/messages')).status, 200)
    assert.deepEqual((await readdir(path.join(scratch, 'auth'))), [])
  })
}
