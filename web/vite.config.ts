import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const hubPort = process.env.HUB_PORT || '8040'

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/pc/' : '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${hubPort}`,
        changeOrigin: true,
      },
      '/hub': {
        target: `http://127.0.0.1:${hubPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
}))
