/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// `vite build --mode demo`: a static build that always runs the in-browser simulator, with relative
// asset URLs so it can be served from any directory (or wrapped as a hosted page, scripts/artifact-page.mjs).
// The production build also uses relative asset URLs: hive/core serves it at the root and, with
// HIVE_BASE_PATH, under a prefix such as /omegadot/ (the hash router keeps the path constant).
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  base: mode === 'development' ? '/' : './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 400,
    outDir: mode === 'demo' ? 'dist-demo' : mode === 'surface-preview' ? 'dist-surface-preview' : 'dist',
    // the demo is served as plain files: no modulepreload polyfill fetches, no absolute URLs
    modulePreload: mode === 'demo' ? { polyfill: false } : undefined,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}))
