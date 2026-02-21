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
    rollupOptions: {
      input: "src/app.html",
      external: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "react-is",
        "recharts",
      ],
      output: {
        paths: {
          react: "https://esm.sh/react@19",
          "react-dom": "https://esm.sh/react-dom@19",
          "react-dom/client": "https://esm.sh/react-dom@19/client",
          "react/jsx-runtime": "https://esm.sh/react@19/jsx-runtime",
          "react/jsx-dev-runtime": "https://esm.sh/react@19/jsx-dev-runtime",
          "react-is": "https://esm.sh/react-is@19?external=react",
          recharts: "https://esm.sh/recharts@3.7.0?external=react,react-dom,react-is",
        },
      },
    },
  },
});
