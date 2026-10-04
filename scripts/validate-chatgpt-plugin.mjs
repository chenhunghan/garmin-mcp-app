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
process.exit(ok ? 0 : 1);
