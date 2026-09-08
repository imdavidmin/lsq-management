import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy /api to `wrangler dev` so the session cookie is same-origin.
// Prod: this app is built to web/dist and served by the Worker itself.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
