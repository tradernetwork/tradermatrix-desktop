import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { rollupInputs } from './devPages'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // The dev pages (chart-dev, ticket-dev, journal-dev, tm-dev, sync-dev, chat-dev: fake backend, no network, no real order) are built
    // only with REBULL_DEV_PAGES=1 (our visual-check builds). A plain build, which is what Tauri ships, has just index.html.
    rollupOptions: { input: rollupInputs(process.env) },
  },
})
