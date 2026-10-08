import { execSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
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

console.log("\nBuild complete!");
