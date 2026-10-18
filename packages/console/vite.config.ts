import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Two static pages: the console (index.html) and the landing page (landing.html).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { console: resolve(here, 'index.html'), landing: resolve(here, 'landing.html') },
    },
  },
})
