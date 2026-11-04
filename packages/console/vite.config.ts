import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));

// The site root is the product page. The console is console.html. landing.html stays as the same page.
export default defineConfig({
  plugins: [
    react(),
    {
      name: "seam-local-market-profile",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__seam_defi/registry" || req.method !== "GET") return next();
          res.setHeader("Cache-Control", "no-store");
          try {
            const profile = await readFile(resolve(here, "../../.seam-defi/registry.json"), "utf8");
            res.setHeader("Content-Type", "application/json");
            res.end(profile);
          } catch {
            res.statusCode = 404;
            res.end("Local market is not running");
          }
        });
      },
    },
  ],
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
