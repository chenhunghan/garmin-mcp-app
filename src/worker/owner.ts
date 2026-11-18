/**
 * `/owner`: the owner's page, behind the Run Coach password. Shows whether the
 * owner's Garmin account is connected, the household (members, open invites,
 * inviting and removing people) and whether an update is out. A sign-in lasts
 * 30 minutes (a `__Host-` cookie whose hash the vault keeps); every form also
 * carries a token derived from it. Removing a member deletes their vault and
 * revokes their apps' grants.
 */
import { clientKey } from "./authorize.js";
import { personVault, vaultOf, type Env } from "./env.js";
import { copyScript, escapeHtml, page } from "./html.js";
import { DISCLAIMER } from "./landing.js";
import { LIMITS, formatInviteCode, type Invite, type Member } from "./vault.js";

const COOKIE = "__Host-rc-owner";
const PACKAGE_URL =
  "https://raw.githubusercontent.com/chenhunghan/garmin-mcp-app/main/package.json";

export async function handleOwner(request: Request, env: Env, version: string): Promise<Response> {
  const vault = vaultOf(env);
  const session = cookie(request, COOKIE) ?? "";
  const signedIn = await vault.checkSession(session);

  if (request.method === "POST") {
    const form = await request.formData();
    const action = String(form.get("action") ?? "");
    if (action === "login") return login(request, env, String(form.get("passphrase") ?? ""));
    if (!signedIn || String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
      return redirect("/owner");
    }
    const id = String(form.get("id") ?? "");
    switch (action) {
      case "logout":
        await vault.endSession(session);
        return redirect("/owner", clearCookie());
      case "invite": {
        const invite = await vault.createInvite();
        return redirect(invite ? `/owner?new=${invite.id}` : "/owner?full=invites");
      }
      case "cancel-invite":
        await vault.cancelInvite(id);
        return redirect("/owner");
      case "remove-ask": {
        const member = await vault.getMember(id);
        return member ? confirmRemove(member, await csrfToken(session)) : redirect("/owner");
      }
      case "remove":
        await removeMember(env, id);
        return redirect("/owner");
    }
    return redirect("/owner");
  }

  if (!signedIn) return loginPage();
  return dashboard(request, env, version, await csrfToken(session));
}

async function login(request: Request, env: Env, passphrase: string): Promise<Response> {
  const vault = vaultOf(env);
  const check = await vault.checkPassphrase(passphrase, await clientKey(request));
  if (!check.ok) {
    return loginPage(
      check.retryAfterMs
        ? `Too many wrong tries. Try again in ${Math.ceil(check.retryAfterMs / 60_000)} minutes.`
        : "That password isn't right.",
    );
  }
  const secret = await vault.createSession();
  return redirect(
    "/owner",
    `${COOKIE}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${LIMITS.sessionMs / 1000}`,
  );
}

function loginPage(error?: string): Response {
  return page({
    title: "Owner page",
    body: `<h1>Owner page</h1>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<p class="muted">Invite your household and check for updates.</p>
<form method="post" action="/owner"><input type="hidden" name="action" value="login">
<label for="passphrase">Run Coach password</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button></form>
<p class="muted" style="margin-top:18px">Forgot it? In the Cloudflare dashboard, open this Worker → Settings → Variables and Secrets and change <code>OWNER_PASSPHRASE</code>.</p>`,
    status: error ? 400 : 200,
  });
}

async function dashboard(
  request: Request,
  env: Env,
  version: string,
  csrf: string,
): Promise<Response> {
  const url = new URL(request.url);
  const vault = vaultOf(env);
  const [ownerName, ownerTokens, members, invites, timeZone, latest] = await Promise.all([
    vault.getName(),
    vault.loadTokens(),
    vault.listMembers(),
    vault.listInvites(),
    vault.getTimeZone(),
    latestVersion(),
  ]);
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en", { dateStyle: "medium", ...(timeZone && { timeZone }) }).format(
      ms,
    );
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
  const button = (action: string, label: string, id = "", cls = "small secondary") =>
    `<form method="post" action="/owner">${hidden}<input type="hidden" name="action" value="${action}">${
      id ? `<input type="hidden" name="id" value="${escapeHtml(id)}">` : ""
    }<button type="submit" class="${cls}">${label}</button></form>`;

  const you = ownerTokens
    ? `<p class="ok">● Connected${ownerName ? ` as ${escapeHtml(ownerName)}` : ""}</p>`
    : `<p>Not connected yet. Follow the steps on the <a href="/">setup page</a> to add Run Coach to Claude.</p>`;

  const newId = url.searchParams.get("new");
  const inviteText = (invite: Invite) =>
    `Join my Run Coach to ask Claude about your Garmin data: ${url.origin}/join?code=${invite.code}`;
  const inviteRows = invites
    .map((invite) => {
      const fresh = invite.id === newId;
      const text = escapeHtml(inviteText(invite));
      const row = `<div class="item"><div class="grow"><strong>${escapeHtml(formatInviteCode(invite.code))}</strong>
<div class="muted">Invite · works until ${escapeHtml(day(invite.exp))}, once</div>${
        fresh
          ? ""
          : `<button type="button" class="small secondary" style="margin-top:6px" data-copy="${text}">Copy message</button>`
      }</div>${button("cancel-invite", "Cancel", invite.id)}</div>`;
      // Just created: the message to send, full width under its row
      return fresh
        ? `${row}<div class="box" style="margin-top:8px"><p style="margin:0 0 8px">Send this message to the person you're inviting:</p><p class="muted" style="margin:0;overflow-wrap:anywhere">${text}</p><button type="button" data-copy="${text}">Copy message</button></div>`
        : row;
    })
    .join("");
  const memberRows = members
    .map(
      (
        m,
      ) => `<div class="item"><div class="grow"><strong>${escapeHtml(m.name ?? "Household member")}</strong>
<div class="muted">Joined ${escapeHtml(day(m.joinedAt))}</div></div>${button("remove-ask", "Remove", m.id)}</div>`,
    )
    .join("");
  const full = url.searchParams.get("full") === "invites";
  const canInvite = members.length < LIMITS.maxMembers;

  const update =
    latest === null
      ? `<p class="muted">Version ${escapeHtml(version)}. Couldn't check for updates right now.</p>`
      : newer(latest, version)
        ? `<p><strong>Version ${escapeHtml(latest)} is out</strong> (you have ${escapeHtml(version)}).</p>
<p class="muted">Your copy installs updates by itself every Monday. To update now: on GitHub, open your copy of the repository → Actions → Update Run Coach → Run workflow. Cloudflare then redeploys it in a few minutes.</p>`
        : `<p class="ok">● Up to date (version ${escapeHtml(version)})</p>`;

  return page({
    title: "Owner page",
    body: `<h1>Owner page</h1>
<h2>Your Garmin</h2>${you}
<h2>Household</h2>
<p class="muted">Everyone signs in with their own Garmin account and sees only their own data. Invite someone, send them the message, and they follow its steps.</p>
${memberRows}${inviteRows}
${full ? `<p class="error" role="alert">${LIMITS.maxInvites} invites are open already. Cancel one first.</p>` : ""}
${canInvite ? button("invite", "Invite someone", "", "") : `<p class="muted">The household is full (${LIMITS.maxMembers} members).</p>`}
<h2>Updates</h2>${update}
<h2>Setup</h2>
<p><a href="/">Setup page</a>: how to add Run Coach to Claude.</p>
${button("logout", "Sign out", "", "secondary")}
<p class="muted" style="margin-top:18px">${DISCLAIMER}</p>`,
    script: await copyScript(),
  });
}

function confirmRemove(member: Member, csrf: string): Response {
  const name = escapeHtml(member.name ?? "this household member");
  return page({
    title: "Remove member",
    body: `<h1>Remove ${name}?</h1>
<p>Their Garmin sign-in and settings are deleted from this Run Coach and their apps are disconnected. Their data in Garmin Connect isn't touched. You can invite them again later.</p>
<form method="post" action="/owner"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input type="hidden" name="action" value="remove"><input type="hidden" name="id" value="${escapeHtml(member.id)}">
<button type="submit">Remove</button></form>
<form method="get" action="/owner"><button type="submit" class="secondary">Keep</button></form>`,
  });
}

/** Deletes the member, their vault, and every grant their apps hold. */
export async function removeMember(env: Env, id: string): Promise<void> {
  const vault = vaultOf(env);
  if (!(await vault.getMember(id))) return;
  // Off the list first: from here on their tokens are refused (index.ts)
  await vault.removeMember(id);
  await personVault(env, id).wipe();
  let cursor: string | undefined;
  do {
    const grants = await env.OAUTH_PROVIDER.listUserGrants(id, cursor ? { cursor } : undefined);
    for (const grant of grants.items) await env.OAUTH_PROVIDER.revokeGrant(grant.id, id);
    cursor = grants.cursor;
  } while (cursor);
}

let latestCache: { at: number; version: string | null } | undefined;

/** The latest released version (main's package.json), checked at most every 6 hours. */
async function latestVersion(): Promise<string | null> {
  if (latestCache && Date.now() - latestCache.at < 6 * 3_600_000) return latestCache.version;
  let version: string | null = null;
  try {
    const res = await fetch(PACKAGE_URL, {
      headers: { "User-Agent": "run-coach-self-hosted" },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const v = ((await res.json()) as { version?: unknown }).version;
      if (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v)) version = v;
    }
  } catch {
    // Offline or GitHub is down: say so on the page
  }
  latestCache = { at: Date.now(), version };
  return version;
}

/** Whether version `a` is newer than `b` (x.y.z). */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

async function csrfToken(session: string): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`csrf:${session}`)),
  );
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(null, { status: 303, headers });
}

function clearCookie(): string {
  return `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
