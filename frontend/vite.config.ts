import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const BACKEND_PORT = process.env.BACKEND_PORT ?? '8000'
const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT ?? '5173', 10)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    host: true,
    port: FRONTEND_PORT,
    proxy: {
      '/api': {
        target: `http://localhost:${BACKEND_PORT}`,
        rewrite: (p: string) => p.replace(/^\/api/, ''),
        timeout: 0,        // no socket timeout
        proxyTimeout: 0,   // no proxy timeout — model calls can take minutes
      },
    },
  },
})

