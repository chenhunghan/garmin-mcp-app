/** `/`: the connector URL to paste into Claude or ChatGPT, and how. */
import type { Env } from "./env.js";
import { escapeHtml, page, sha256Base64 } from "./html.js";

const COPY_SCRIPT = `document.getElementById("copy").addEventListener("click",function(){navigator.clipboard.writeText(document.getElementById("url").textContent).then(function(){document.getElementById("copy").textContent="Copied"})})`;
let copyHash: Promise<string> | undefined;

export async function landing(request: Request, env: Env, version: string): Promise<Response> {
  const url = `${new URL(request.url).origin}/mcp`;
  const missing = [
    !env.OWNER_PASSPHRASE && "OWNER_PASSPHRASE",
    !env.TOKEN_ENCRYPTION_KEY && "TOKEN_ENCRYPTION_KEY",
  ].filter(Boolean) as string[];
  const warning = missing.length
    ? `<p class="error" role="alert">Not ready: set the secret${missing.length > 1 ? "s" : ""} ${missing.map((m) => `<code>${m}</code>`).join(" and ")} in the Cloudflare dashboard (Worker → Settings → Variables and Secrets).</p>`
    : "";
  return page({
    title: "Your Run Coach",
    body: `<h1>Your Run Coach is running</h1>${warning}
<p>Add it to Claude or ChatGPT as a custom connector with this URL:</p>
<code class="url" id="url">${escapeHtml(url)}</code>
<button type="button" id="copy">Copy URL</button>
<p style="margin-top:20px"><strong>Claude</strong> (web, desktop, mobile)</p>
<ol><li>Settings → Connectors → Add custom connector, paste the URL.</li>
<li>Connect: enter your owner passphrase, then sign in to Garmin.</li></ol>
<p><strong>ChatGPT</strong> (web)</p>
<ol><li>Turn on developer mode, then add an MCP app with this URL and OAuth. Custom MCP servers depend on your ChatGPT plan: see OpenAI's help center.</li>
<li>Connect the same way.</li></ol>
<p class="muted">Only someone with your owner passphrase can connect, and only your Garmin account can sign in. Unofficial; not affiliated with or endorsed by Garmin. Garmin is a trademark of Garmin Ltd. · Run Coach ${escapeHtml(version)}</p>`,
    script: { source: COPY_SCRIPT, sha256: await (copyHash ??= sha256Base64(COPY_SCRIPT)) },
  });
}
