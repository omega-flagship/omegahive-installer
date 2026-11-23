/// <reference types="vitest/config" />
import { defineConfig, loadEnv, searchForWorkspaceRoot, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

/**
 * The page's nonce slot. The hive (hive/core/app.py PAGE_NONCE_SLOT, the same word) replaces it with a fresh nonce in
 * every answer for index.html and names that nonce in the page's CSP, so the build writes it into each script, style and
 * preload tag and into the csp-nonce meta that lib/appFrame.ts frameNonce reads.
 */
const PAGE_NONCE_SLOT = 'HIVE-CSP-NONCE'

/** The host's defaults file (hive/config.json), which the simulator imports (src/api/sim/ask.ts). */
const HIVE_CONFIG = fileURLToPath(new URL('../config.json', import.meta.url))

/** The hive's own paths the UI calls or opens, which the dev and preview servers forward to VITE_HIVE_URL. */
const HIVE_PATHS = ['/api', '/llm', '/mcp', '/flow-studio', '/mind-iter', '/local-signin']

/**
 * The UI always calls the origin that served it, the way it runs when a hive serves it; in development that origin is
 * Vite's server, which forwards the hive's paths (and its events socket) to VITE_HIVE_URL. A request from the dev page
 * itself (Origin's host is the Host it reached) goes on with the hive's own Origin, so the hive's CORS and Origin checks,
 * which accept only its own origins, take it as the hive's page. A request from any other page keeps its Origin and is
 * refused there, as it would be at the hive itself.
 */
function hiveProxy(hiveUrl: string): Record<string, ProxyOptions> {
  const hiveOrigin = new URL(hiveUrl).origin
  const fromDevPage = (headers: { origin?: string; host?: string }) => {
    try {
      return !!headers.origin && !!headers.host && new URL(headers.origin).host === headers.host
    } catch {
      return false
    }
  }
  const options: ProxyOptions = {
    target: hiveUrl,
    changeOrigin: true,
    ws: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq, req) => { if (fromDevPage(req.headers)) proxyReq.setHeader('origin', hiveOrigin) })
      proxy.on('proxyReqWs', (proxyReq, req) => { if (fromDevPage(req.headers)) proxyReq.setHeader('origin', hiveOrigin) })
    },
  }
  return Object.fromEntries(HIVE_PATHS.map((path) => [path, options]))
}

// `vite build --mode demo`: a static build that always runs the in-browser simulator, with relative
// asset URLs so it can be served from any directory (or wrapped as a hosted page, scripts/artifact-page.mjs).
// The production build also uses relative asset URLs: hive/core serves it at the root and, with
// HIVE_BASE_PATH, under a prefix such as /omegadot/ (the hash router keeps the path constant).
export default defineConfig(({ mode }) => {
  const hive = loadEnv(mode, process.cwd(), 'VITE_').VITE_HIVE_URL
  const proxy = hive ? hiveProxy(hive) : undefined
  return {
    plugins: [react(), tailwindcss()],
    base: mode === 'development' ? '/' : './',
    // only the build a hive serves has a slot to fill (the demo and the surface preview are served as plain files)
    html: mode === 'production' ? { cspNonce: PAGE_NONCE_SLOT } : undefined,
    // the simulator reads the host's defaults from hive/config.json, outside this root: the dev server serves that one
    // file beside its default allow list (the workspace root)
    server: { proxy, fs: { allow: [searchForWorkspaceRoot(process.cwd()), HIVE_CONFIG] } },
    preview: { proxy },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 400,
      outDir: mode === 'demo' ? 'dist-demo' : mode === 'surface-preview' ? 'dist-surface-preview' : 'dist',
      // the demo is served as plain files: no modulepreload polyfill fetches, no absolute URLs
      modulePreload: mode === 'demo' ? { polyfill: false } : undefined,
      rollupOptions: {
        output: {
          // A released module whose file is named like a candidate (features/programs/parts.tsx vs the unreleased UI
          // parts inspector, candidate-markers.json "parts") gets its own chunk name, so the candidate-out gate keeps
          // its full name list and still catches the real candidate. Every other chunk keeps the default name.
          chunkFileNames: (chunk) =>
            (chunk.moduleIds ?? []).some((id) => /[\\/]features[\\/]programs[\\/]parts\.tsx$/.test(id))
              ? 'assets/programParts-[hash].js'
              : 'assets/[name]-[hash].js',
        },
      },
    },
    test: {
      environment: 'node',
      // a mounted test is .test.tsx (JSX); both kinds run in every gate
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }
})
