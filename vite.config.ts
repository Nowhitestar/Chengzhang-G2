import { defineConfig } from "vite";

// The G2 app is a plain Vite web app. In development, /api is proxied to the
// backend so the WebView and the API share one origin (no CORS to think about).
export default defineConfig({
  // Relative asset paths, so the build works wherever the Even app unpacks it.
  base: "./",
  server: {
    host: true,
    port: 5173,
    proxy: { "/api": { target: `http://localhost:${process.env.PORT || 8787}`, changeOrigin: true } },
  },
  build: { target: "es2022" },
});
