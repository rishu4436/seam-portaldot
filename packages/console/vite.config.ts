import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The site root is the product page. The console is console.html. landing.html stays as the same page.
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            { name: "recordings", test: /src[\\/]demo[\\/]/, maxSize: 250000 },
            { name: "vendor", test: /node_modules/, minSize: 30000, maxSize: 250000 },
          ],
        },
      },
      input: {
        site: resolve(here, "index.html"),
        landing: resolve(here, "landing.html"),
        console: resolve(here, "console.html"),
      },
    },
  },
});
