import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [tailwindcss(), react(), viteSingleFile()],
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
        "@modelcontextprotocol/ext-apps/react",
      ],
      output: {
        paths: {
          react: "https://esm.sh/react@19",
          "react-dom": "https://esm.sh/react-dom@19",
          "react-dom/client": "https://esm.sh/react-dom@19/client",
          "react/jsx-runtime": "https://esm.sh/react@19/jsx-runtime",
          "react/jsx-dev-runtime": "https://esm.sh/react@19/jsx-dev-runtime",
          "@modelcontextprotocol/ext-apps/react":
            "https://esm.sh/@modelcontextprotocol/ext-apps@1/react",
        },
      },
    },
  },
});
