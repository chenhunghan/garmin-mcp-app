/**
 * `/`: the setup page. How to add this Run Coach to Claude (or ChatGPT), in
 * steps a non-technical person can follow, with the URL to copy. Public: it
 * shows nothing about the people using the server.
 */
import { keyBytes } from "./crypto.js";
import type { Env } from "./env.js";
import { copyScript, escapeHtml, page } from "./html.js";
import { formatInviteCode } from "./vault.js";

const CLAUDE_CONNECTORS = "https://claude.ai/customize/connectors";

export const DISCLAIMER =
  "Unofficial; not affiliated with or endorsed by Garmin. Garmin is a trademark of Garmin Ltd.";

/**
 * The numbered steps for connecting Claude to `url`. With an invite code the
 * steps are a household member's; without, they cover the owner and members.
 */
export function connectSteps(url: string, invite?: string): string {
  const who = invite
    ? `<p>Choose <strong>I'm a household member</strong>, enter the invite code <strong>${escapeHtml(formatInviteCode(invite))}</strong>, then sign in with <strong>your own</strong> Garmin account.</p>
<button type="button" class="secondary" data-copy="${escapeHtml(formatInviteCode(invite))}">Copy invite code</button>`
    : `<p>If you set up this Run Coach, enter its password. Household members choose <strong>I'm a household member</strong> instead. Then sign in to Garmin.</p>`;
  return `<ol class="steps">
<li><strong>Copy your Run Coach address</strong>
<code class="url" id="url">${escapeHtml(url)}</code>
<button type="button" data-copy="${escapeHtml(url)}">Copy address</button></li>
<li><strong>Add it to Claude</strong>
<p>Open <a href="${CLAUDE_CONNECTORS}" target="_blank" rel="noopener">Claude's connectors</a> (in Claude: <em>Customize → Connectors</em>), choose <em>Add → Add custom connector</em>, name it <em>Run Coach</em>, paste the address and select <em>Add</em>. Leave the other settings as they are.</p>
<p class="muted">Easiest at claude.ai or in the Claude desktop app. Once added, Run Coach is also in the Claude app on your phone. Claude's free plan allows one custom connector.</p></li>
<li><strong>Connect</strong>
<p>Select <em>Connect</em> next to Run Coach. A sign-in page opens.</p>${who}</li>
<li><strong>Try it</strong>
<p>Ask Claude: <em>"How did I sleep last night?"</em> or <em>"Show my training week."</em></p></li>
</ol>`;
}

export function chatGptSteps(url: string): string {
  return `<details><summary>Using ChatGPT instead?</summary>
<p style="margin-top:10px">In ChatGPT on the web, turn on developer mode in Settings, then add an app with the address <code>${escapeHtml(url)}</code> and OAuth sign-in. Whether your plan allows this is up to OpenAI.</p></details>`;
}

export async function landing(request: Request, env: Env, version: string): Promise<Response> {
  const origin = new URL(request.url).origin;
  const url = `${origin}/mcp`;
  const badKey =
    !!env.TOKEN_ENCRYPTION_KEY?.trim() &&
    (await keyBytes(env.TOKEN_ENCRYPTION_KEY).then(
      () => false,
      () => true,
    ));
  const warning = !env.OWNER_PASSPHRASE
    ? `<p class="error" role="alert">Almost ready: this Run Coach has no password yet. In the Cloudflare dashboard, open this Worker → Settings → Variables and Secrets, and add a secret named <code>OWNER_PASSPHRASE</code> with a password only you know.</p>`
    : badKey
      ? `<p class="error" role="alert">Not ready: the optional <code>TOKEN_ENCRYPTION_KEY</code> secret is too short. Use 64 hex characters (<code>openssl rand -hex 32</code>), or delete it to let Run Coach make its own key.</p>`
      : "";
  return page({
    title: "Set up Run Coach",
    body: `<h1>Your Run Coach is ready</h1>${warning}
<p>Ask Claude about your runs, sleep and recovery, with charts from your Garmin data. Four steps, about two minutes:</p>
${connectSteps(url)}
${chatGptSteps(url)}
<p><a href="/owner">Owner page</a>: invite your household, check for updates.</p>
<p class="muted">Each person signs in with their own Garmin account and sees only their own data. ${DISCLAIMER} · Run Coach ${escapeHtml(version)}</p>`,
    script: await copyScript(),
  });
}
