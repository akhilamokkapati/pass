import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies the API + WebSocket to the FastAPI backend on :8000, so
// `pnpm dev` works locally. In production the FastAPI app serves the built
// `dist/` directly (same origin), so no proxy is needed there.
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8000', ws: true },
      '/api': 'http://localhost:8000',
    },
  },
  build: { outDir: 'dist' },
})
