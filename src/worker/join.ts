/**
 * `/join?code=…`: the page an invite link opens. Shows who invited you and
 * the steps to connect Claude as a household member. Opening it doesn't use
 * the invite up (link previews); joining does.
 */
import { clientKey } from "./authorize.js";
import { vaultOf, type Env } from "./env.js";
import { copyScript, escapeHtml, page } from "./html.js";
import { DISCLAIMER, chatGptSteps, connectSteps } from "./landing.js";
import { normalizeInviteCode } from "./vault.js";

/** Invite pages one IP may open per 10 minutes: guessing codes here gets nowhere. */
const VIEWS_PER_IP = 30;

export async function joinPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const vault = vaultOf(env);
  const limit = await vault.rateLimit(`join:${await clientKey(request)}`, VIEWS_PER_IP, 600_000);
  if (!limit.ok) {
    return page({
      title: "Try again later",
      body: `<h1>Try again later</h1><p>Too many invite pages opened from your network. Try again in ${Math.ceil(limit.retryAfterMs / 60_000)} minutes.</p>`,
      status: 429,
    });
  }
  const invite = await vault.findInvite(normalizeInviteCode(url.searchParams.get("code") ?? ""));
  if (!invite) {
    return page({
      title: "Invite expired",
      body: `<h1>This invite has expired</h1><p>Invites work for a week and only once. Ask the person who sent it for a new one.</p>`,
      status: 410,
    });
  }
  const owner = await vault.getName();
  const inviter = owner ? escapeHtml(owner) : "Someone";
  return page({
    title: "Join Run Coach",
    body: `<h1>${inviter} invited you to Run Coach</h1>
<p>Ask Claude about your runs, sleep and recovery, with charts from <strong>your own</strong> Garmin data.</p>
${connectSteps(`${url.origin}/mcp`, invite.code)}
${chatGptSteps(`${url.origin}/mcp`)}
<h2>Your privacy</h2>
<p class="muted">You sign in with your own Garmin account and only you see your data in your chats. Your Garmin sign-in is stored encrypted on a server that ${inviter === "Someone" ? "the person who invited you" : inviter} runs in their own Cloudflare account, so join only if you trust them. To leave, remove Run Coach from Claude's connectors and ask them to remove you, which deletes your sign-in. ${DISCLAIMER}</p>`,
    script: await copyScript(),
  });
}
