import path from "node:path";
import fs from "node:fs";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Vite preserves the src/ directory structure in output since input is src/app.html.
// This plugin moves dist/src/app.html → dist/app.html after each build so the
// MCP server can find it, and works in both regular and --watch builds.
function flattenAppHtml(): import("vite").Plugin {
  return {
    name: "flatten-app-html",
    closeBundle() {
      const src = path.resolve("dist/src/app.html");
      const dest = path.resolve("dist/app.html");
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
        fs.rmSync(path.resolve("dist/src"), { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  define: {
    __DEV_UI__: "false",
  },
  plugins: [tailwindcss(), react(), viteSingleFile(), flattenAppHtml()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    // Everything (React, Recharts) is bundled into one self-contained file:
    // ChatGPT's sandbox and offline use can't rely on a CDN.
    rollupOptions: {
      input: "src/app.html",
    },
  },
});
