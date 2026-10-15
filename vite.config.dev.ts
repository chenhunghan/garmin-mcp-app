import path from "node:path";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import devPlugin from "./src/dev-plugin.ts";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  define: {
    __DEV_UI__: "true",
  },
  // The replay's runner model (src/replay/assets) is imported as an inlined asset
  assetsInclude: ["**/*.glb"],
  plugins: [tailwindcss(), react(), devPlugin()],
  server: {
    port: 5173,
    open: true,
  },
});
