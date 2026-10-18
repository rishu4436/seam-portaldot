import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Two static pages: the console (index.html) and the landing page (landing.html).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { console: resolve(__dirname, 'index.html'), landing: resolve(__dirname, 'landing.html') },
    },
  },
})
