import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import devPlugin from "./src/dev-plugin.ts";

export default defineConfig({
  plugins: [react(), devPlugin()],
  server: {
    port: 5173,
    open: true,
  },
});
