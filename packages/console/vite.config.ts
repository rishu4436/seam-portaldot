import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The site root is the product page. The console is console.html. landing.html stays as the same page.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        site: resolve(here, "index.html"),
        landing: resolve(here, "landing.html"),
        console: resolve(here, "console.html"),
      },
    },
  },
});
