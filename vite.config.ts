import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Served under BASE_PATH when hosted behind a path-routing proxy; "/" for a
// plain local clone. The express server (server/index.ts) mounts vite in
// middleware mode during development and serves dist/public in production.
const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "app"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      // Pin what the dev server may serve: this package plus hoisted deps.
      allow: [
        path.resolve(import.meta.dirname),
        path.resolve(import.meta.dirname, "node_modules"),
        path.resolve(import.meta.dirname, "../../node_modules"),
      ],
    },
  },
});
