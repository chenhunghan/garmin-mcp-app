import { execSync } from "node:child_process";
import { rmSync, renameSync, existsSync } from "node:fs";
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

// 3. Vite build → dist/src/app.html
run("vite build");

// 4. Move dist/src/app.html → dist/app.html
renameSync(resolve(dist, "src", "app.html"), resolve(dist, "app.html"));
rmSync(resolve(dist, "src"), { recursive: true });
console.log("Moved dist/src/app.html → dist/app.html");

// 5. esbuild server
run("esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.js");

console.log("\nBuild complete!");
