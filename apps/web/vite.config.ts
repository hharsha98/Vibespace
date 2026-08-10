import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    proxy: {
      "/api": {
        target: "http://localhost:4317",
        changeOrigin: true,
        // The terminal WebSocket connects through /api/sessions/:id/ws — the
        // Vite dev server must proxy the WebSocket upgrade too, or that
        // connection just fails silently.
        ws: true,
      },
    },
  },
});
