import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, existsSync } from 'node:fs'

// The API server writes a random token on boot. The dev proxy attaches it to
// every request so a stray browser tab (or another localhost app) can't walk
// the filesystem through us.
function sessionToken(): string {
  try {
    return existsSync('.tether-session')
      ? readFileSync('.tether-session', 'utf8').trim()
      : ''
  } catch {
    return ''
  }
}

const token = sessionToken()

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            if (token) req.setHeader('x-tether-token', token)
          })
        },
      },
    },
  },
  build: { outDir: 'dist' },
})
