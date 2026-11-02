import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API, signed media, and public snip pages all live on the server. In development
// Vite forwards them so the app, the HttpOnly device cookie, and the audio element share one origin.
const API = process.env.API_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // `pnpm dev --host <tailscale ip>` makes the app reachable from a phone on the tailnet by its MagicDNS name.
    allowedHosts: [".ts.net"],
    // Anchored: a plain "/s" prefix would also capture /src/*.
    proxy: {
      "^/v1/": { target: API },
      "^/m/": { target: API },
      "^/s/": { target: API },
      "^/e/": { target: API },
    },
  },
  build: { sourcemap: true },
});
