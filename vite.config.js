import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/anthropic/, ''),
      },
      '/api/ahrefs': {
        target: 'https://api.ahrefs.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/ahrefs/, ''),
      },
    },
  },
})
