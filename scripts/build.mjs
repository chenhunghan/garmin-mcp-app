import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const run = (cmd) => {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

const dist = resolve("dist");

// 1. Clean dist
if (existsSync(dist)) {
  rmSync(dist, { recursive: true });
  console.log("Cleaned dist/");
}

// 2. Type-check server + UI
run("tsc --noEmit");
run("tsc --noEmit -p tsconfig.app.json");

// 3. Vite build → dist/app.html (flattenAppHtml plugin handles the move)
run("vite build");

// 4. esbuild server
// The banner makes dist/index.js runnable as the npm `bin` (npx garmin-mcp-app)
run(
  'esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.js --banner:js="#!/usr/bin/env node"',
);

// 5. The self-hosted Worker serves the app as a static asset (wrangler.jsonc);
// kept out of dist/ so the npm package stays stdio-only
mkdirSync("build/worker-assets", { recursive: true });
copyFileSync("dist/app.html", "build/worker-assets/app.html");

console.log("\nBuild complete!");
