/**
 * Validate the assembled ChatGPT plugin (build/chatgpt-plugin) against the
 * Agent Plugins schemas (vendored from https://agent-plugins.org/schemas/1.0.0/).
 * Run after `npm run pack:chatgpt`; CI runs both.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "build/chatgpt-plugin/plugins/garmin");
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });

let ok = true;
for (const [schema, file] of [
  ["agent-plugins-plugin.schema.json", "plugin.json"],
  ["agent-plugins-mcp.schema.json", "mcp.json"],
]) {
  const validate = ajv.compile(
    JSON.parse(readFileSync(join(root, "scripts/schemas", schema), "utf-8")),
  );
  const data = JSON.parse(readFileSync(join(plugin, file), "utf-8"));
  if (validate(data)) {
    console.log(`${file}: valid`);
  } else {
    ok = false;
    console.error(`${file}: invalid`, JSON.stringify(validate.errors, null, 2));
  }
}
// The marketplace committed on main points at the build published to the
// `chatgpt-plugin` branch: it must name the same marketplace, plugin and path.
const pointer = JSON.parse(readFileSync(join(root, ".agents/plugins/marketplace.json"), "utf-8"));
const built = JSON.parse(
  readFileSync(join(root, "build/chatgpt-plugin/.agents/plugins/marketplace.json"), "utf-8"),
);
const pluginJson = JSON.parse(readFileSync(join(plugin, "plugin.json"), "utf-8"));
const source = pointer.plugins?.[0]?.source ?? {};
const builtPath = built.plugins?.[0]?.source?.path?.replace(/^\.\//, "");
const checks = [
  ["marketplace name", pointer.name === built.name],
  ["plugin name", pointer.plugins?.[0]?.name === pluginJson.name],
  [
    "source is the chatgpt-plugin branch",
    source.source === "url" && source.ref === "chatgpt-plugin",
  ],
  ["source path matches the build", source.path === builtPath],
];
for (const [what, pass] of checks) {
  if (!pass) {
    ok = false;
    console.error(`.agents/plugins/marketplace.json: ${what} doesn't match the packed plugin`);
  }
}
if (checks.every(([, pass]) => pass))
  console.log(".agents/plugins/marketplace.json: matches the build");

process.exit(ok ? 0 : 1);
