/** Separate test entry only. The normal product build never exposes the fixture's trusted host controls. */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({
  plugins: [react(), tailwindcss()], base: './',
  build: { target: 'es2022', modulePreload: { polyfill: false }, rollupOptions: { input: 'p8-memory-browser.html' } },
})
