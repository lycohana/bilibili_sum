import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const root = __dirname;
const backendStaticRoot = path.resolve(root, "../web/static");

export default defineConfig(({ command }) => ({
  root,
  base: command === "build" ? "/static/" : "/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: true,
    fs: {
      allow: [root, path.resolve(root, "..")],
    },
    proxy: {
      "/api": "http://127.0.0.1:3838",
      "/health": "http://127.0.0.1:3838",
      "/media": "http://127.0.0.1:3838",
      "/static/assets/icons": "http://127.0.0.1:3838",
      "/static/favicon.ico": "http://127.0.0.1:3838",
      "/static/favicon.svg": "http://127.0.0.1:3838",
      "/static/favicon-32x32.png": "http://127.0.0.1:3838",
      "/static/apple-touch-icon.png": "http://127.0.0.1:3838",
    },
  },
  build: {
    outDir: backendStaticRoot,
    emptyOutDir: false,
    assetsDir: "assets",
  },
}));
