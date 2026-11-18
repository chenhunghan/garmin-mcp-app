/**
 * The sign-in pages. `/authorize` connects an MCP client (Claude, ChatGPT).
 * The owner enters the Run Coach password, then signs in to Garmin (skipped
 * when their vault already has tokens). A household member signs in to Garmin,
 * with an invite code the first time: their Garmin account says who they are.
 * `/signin?t=…` (a one-time link) is the Garmin step alone, for when one
 * person's Garmin sign-in expired. Each sign-in lives in the owner's vault for
 * 10 minutes, bound to the browser that started it by a cookie. Nothing else is
 * written before the password, the invite or the person's own Garmin sign-in
 * is right, and starting sign-ins is rate-limited per IP.
 */
import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Sealer, ipNetwork, randomId } from "./crypto.js";
import { encryptionKey, personVault, vaultOf, type Env, type Person } from "./env.js";
import { escapeHtml, page } from "./html.js";
import { checkSignInLink } from "./signin-link.js";
import { WrongAccountError, garminLogin, garminMfa, keep, type SignedIn } from "./signin.js";
import { LIMITS, formatInviteCode, normalizeInviteCode, type SignInTransaction } from "./vault.js";

const COOKIE = "__Host-rc-";

/** Sign-ins one IP may start per 10 minutes: plenty for a person, little for a script. */
const STARTS_PER_IP = 20;

/** Where Claude and ChatGPT send people back to; anything else gets a warning. */
const KNOWN_HOSTS = new Set(["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com"]);

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  if (request.method === "POST") return continueSignIn(request, env);
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) {
      return Response.redirect(err.redirectTo, 302);
    }
    return errorPage("This connection request isn't valid. Start again from your chat app.", 400);
  }
  const consent = await env.OAUTH_PROVIDER.describeConsent(authRequest);
  return startSignIn(request, env, {
    kind: "authorize",
    authRequest,
    client: {
      // A registered client's name is whatever it said: only a CIMD domain is verified
      name: consent.clientDomain ?? consent.clientName,
      verified: consent.clientDomain !== undefined,
      host: consent.redirectHost,
      known: !consent.redirectIsLoopback && KNOWN_HOSTS.has(consent.redirectHost),
    },
    stage: "passphrase",
  });
}

export async function handleSignInLink(request: Request, env: Env): Promise<Response> {
  if (request.method === "POST") return continueSignIn(request, env);
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const sealer = new Sealer(() => encryptionKey(env));
  // Opening the link doesn't use it up (previews, reloads): signing in does
  const link = await checkSignInLink(vaultOf(env), sealer, token);
  // A member who was removed meanwhile has nothing to sign in to
  if (!link || (link.person !== "owner" && !(await vaultOf(env).getMember(link.person)))) {
    return linkUsedPage();
  }
  return startSignIn(request, env, {
    kind: "signin",
    stage: "garmin",
    linkNonce: link.nonce,
    person: link.person,
  });
}

async function startSignIn(
  request: Request,
  env: Env,
  start: Omit<SignInTransaction, "browser" | "attempts">,
): Promise<Response> {
  const vault = vaultOf(env);
  const limit = await vault.rateLimit(
    `start:${await clientKey(request)}`,
    STARTS_PER_IP,
    LIMITS.signInMs,
  );
  if (!limit.ok) return tooManyPage(limit.retryAfterMs);
  const id = randomId();
  const secret = randomId();
  // Kept with the sign-in; it becomes "today" for the tools once it's the owner's
  const timeZone = (request.cf as { timezone?: string } | undefined)?.timezone;
  const tx: SignInTransaction = {
    ...start,
    ...(timeZone && isTimeZone(timeZone) && { timeZone }),
    browser: await sha256Hex(secret),
    attempts: 0,
  };
  await vault.putSignIn(id, tx);
  const res = render(id, tx);
  res.headers.append(
    "Set-Cookie",
    `${COOKIE}${id}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${LIMITS.signInMs / 1000}`,
  );
  return res;
}

async function continueSignIn(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get("tx") ?? "");
  const vault = vaultOf(env);
  const tx = /^[\w-]{10,40}$/.test(id) ? await vault.getSignIn(id) : null;
  const secret = cookie(request, `${COOKIE}${id}`);
  if (!tx || !secret || (await sha256Hex(secret)) !== tx.browser) {
    return errorPage("This sign-in expired or was started in another browser. Start again.", 400);
  }

  if (tx.stage === "passphrase") {
    // "I'm a household member"
    if (form.get("as") === "member") {
      tx.stage = "invite";
      tx.role = "member";
      await vault.putSignIn(id, tx);
      return render(id, tx);
    }
    const check = await vault.checkPassphrase(
      String(form.get("passphrase") ?? ""),
      await clientKey(request),
    );
    if (!check.ok) {
      const error = check.retryAfterMs
        ? `Too many wrong tries. Try again in ${Math.ceil(check.retryAfterMs / 60_000)} minutes.`
        : "That password isn't right.";
      return render(id, tx, error);
    }
    tx.role = "owner";
    // Already signed in to Garmin (e.g. connecting a second app): done
    if (await vault.loadTokens()) return finish(env, "owner", id, tx);
    tx.stage = "garmin";
    await vault.putSignIn(id, tx);
    return render(id, tx);
  }

  if (tx.stage === "invite") {
    if (form.get("as") === "owner") {
      tx.stage = "passphrase";
      delete tx.role;
      await vault.putSignIn(id, tx);
      return render(id, tx);
    }
    const code = normalizeInviteCode(String(form.get("invite") ?? ""));
    // No code: someone who already joined, recognized by their Garmin account
    if (code) {
      const check = await vault.checkInvite(code, await clientKey(request));
      if (!check.ok) {
        const error = check.retryAfterMs
          ? `Too many wrong tries. Try again in ${Math.ceil(check.retryAfterMs / 60_000)} minutes.`
          : "That invite code isn't valid. It may have expired or been used: ask for a new one.";
        return render(id, tx, error);
      }
      tx.invite = code;
    }
    tx.stage = "garmin";
    await vault.putSignIn(id, tx);
    return render(id, tx);
  }

  if (tx.stage === "switch") {
    // The owner (passphrase checked) signed in with another Garmin account
    if (form.get("switch") === "yes" && tx.switchTo) {
      await vault.setOwner(tx.switchTo.garminId);
      await vault.saveTokens(tx.switchTo.tokens);
      return finish(env, "owner", id, tx);
    }
    tx.stage = "garmin";
    delete tx.switchTo;
    await vault.putSignIn(id, tx);
    return render(id, tx);
  }

  // Another tab finished with this link meanwhile
  if (tx.linkNonce && !(await vault.peekLinkNonce(tx.linkNonce))) {
    await vault.deleteSignIn(id);
    return linkUsedPage();
  }
  if (tx.attempts >= LIMITS.maxAttempts) {
    await vault.deleteSignIn(id);
    return errorPage("Too many attempts. Start again.", 429);
  }
  tx.attempts++;
  let signedIn: SignedIn;
  try {
    if (tx.stage === "garmin") {
      const result = await garminLogin(
        String(form.get("email") ?? "").trim(),
        String(form.get("password") ?? ""),
      );
      if (result.status === "needs_mfa") {
        tx.stage = "mfa";
        tx.mfaState = result.mfaState;
        await vault.putSignIn(id, tx);
        return render(id, tx);
      }
      signedIn = result.account;
    } else {
      if (!tx.mfaState) throw new Error("No verification pending");
      signedIn = await garminMfa(String(form.get("code") ?? "").trim(), tx.mfaState);
    }
  } catch (err) {
    await vault.putSignIn(id, tx);
    const what = tx.stage === "mfa" ? "verification code" : "sign-in";
    return render(id, tx, `Garmin didn't accept the ${what}: ${errorMessage(err)}`);
  }

  const placed = await place(env, tx, signedIn);
  if ("error" in placed) {
    await vault.deleteSignIn(id);
    return errorPage(placed.error, 403);
  }
  if ("switchTo" in placed) {
    // Only the passphrase holder may move this server to another account
    tx.stage = "switch";
    tx.switchTo = placed.switchTo;
    delete tx.mfaState;
    await vault.putSignIn(id, tx);
    return render(id, tx);
  }
  return finish(env, placed.person, id, tx);
}

type Placement =
  | { person: Person }
  | { error: string }
  | { switchTo: NonNullable<SignInTransaction["switchTo"]> };

/**
 * Whose vault a Garmin account that just signed in goes to, and keeps its
 * tokens there: the person a one-time link was for; the owner; or, for a
 * household member, the member with this Garmin account (or a new one, with
 * an invite).
 */
async function place(env: Env, tx: SignInTransaction, signedIn: SignedIn): Promise<Placement> {
  const site = vaultOf(env);
  const keepIn = async (person: Person): Promise<Placement> => {
    try {
      await keep(personVault(env, person), signedIn);
      return { person };
    } catch (err) {
      if (!(err instanceof WrongAccountError)) throw err;
      if (tx.kind === "authorize" && person === "owner") {
        return { switchTo: { garminId: err.garminId, tokens: err.tokens } };
      }
      return { error: err.message };
    }
  };
  const member = await site.findMemberByGarmin(signedIn.garminId);

  if (tx.kind === "signin") {
    const person = tx.person ?? "owner";
    if (person === "owner" && member) return { error: memberAccountError(member.name) };
    return keepIn(person);
  }

  if (tx.role === "owner") {
    // A member's Garmin account can't become the owner's
    if (member) return { error: memberAccountError(member.name) };
    return keepIn("owner");
  }

  // Household member: their Garmin account says who they are
  if ((await site.getOwner()) === signedIn.garminId) return keepIn("owner");
  if (member) return keepIn(member.id);
  if (!tx.invite) {
    return {
      error:
        "This Garmin account hasn't joined this Run Coach yet. Ask the person who runs it for an invite code, then connect again and enter it.",
    };
  }
  if (!(await site.findInvite(tx.invite))) {
    return { error: "The invite code expired or was used meanwhile. Ask for a new one." };
  }
  const added = await site.addMember(signedIn.garminId, signedIn.name);
  if (!added) {
    return { error: `This Run Coach already has ${LIMITS.maxMembers} household members.` };
  }
  await site.consumeInvite(tx.invite);
  return keepIn(added.id);
}

function memberAccountError(name: string | undefined): string {
  return `This Garmin account belongs to ${name ? shortName(name) : "a household member"} on this Run Coach. Sign in with the owner's Garmin account.`;
}

/** Names go into plain-text messages that pages escape; keep them short. */
function shortName(name: string): string {
  return name.slice(0, 60);
}

async function finish(
  env: Env,
  person: Person,
  id: string,
  tx: SignInTransaction,
): Promise<Response> {
  const vault = vaultOf(env);
  await vault.deleteSignIn(id);
  if (tx.linkNonce) await vault.consumeLinkNonce(tx.linkNonce);
  // The person's own browser: "today" for the tools is their day, not UTC's
  if (tx.timeZone) await personVault(env, person).setTimeZone(tx.timeZone);
  const clear = `${COOKIE}${id}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  if (tx.kind === "authorize") {
    const request = tx.authRequest!;
    // Grants belong to the person (removing a member revokes theirs); each
    // app (Claude, ChatGPT) gets its own. Grants from before households have
    // no props: they're the owner's.
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request,
      userId: person,
      metadata: {},
      scope: request.scope,
      props: { person },
    });
    return new Response(null, {
      status: 302,
      headers: { Location: redirectTo, "Set-Cookie": clear },
    });
  }
  return page({
    title: "Signed in",
    body: `<h1>Signed in to Garmin</h1><p>Go back to your chat and ask again. You can close this page.</p>`,
    headers: { "Set-Cookie": clear },
  });
}

function render(id: string, tx: SignInTransaction, error?: string): Response {
  const err = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
  const c = tx.kind === "authorize" ? tx.client : undefined;
  const who = c
    ? `<div class="who"><strong>${escapeHtml(c.name)}</strong>${c.verified ? "" : ` <span class="muted">(name not verified)</span>`} wants to use Run Coach. When you're done, you go back to <strong>${escapeHtml(c.host)}</strong>.</div>${
        c.known
          ? ""
          : `<p class="error" role="alert">${escapeHtml(c.host)} isn't Claude or ChatGPT. Continue only if you're connecting an app there yourself: whoever runs it gets access to your Garmin data.</p>`
      }`
    : "";
  const hidden = `<input type="hidden" name="tx" value="${escapeHtml(id)}">`;
  const action = tx.kind === "authorize" ? "/authorize" : "/signin";
  let title: string;
  let fields: string;
  if (tx.stage === "passphrase") {
    title = "Connect to Run Coach";
    fields = `<label for="passphrase">Run Coach password</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
<p class="muted">The password chosen when this Run Coach was set up.</p>
<button type="submit">Continue</button>
</form><form method="post" action="${action}">${hidden}<input type="hidden" name="as" value="member">
<button type="submit" class="secondary">I'm a household member</button>`;
  } else if (tx.stage === "invite") {
    title = "Join as a household member";
    fields = `<label for="invite">Invite code</label>
<input id="invite" name="invite" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" autofocus>
<p class="muted">First time? Enter the code you were sent. Already joined? Leave it empty and continue: your Garmin sign-in is enough.</p>
<button type="submit">Continue</button>
</form><form method="post" action="${action}">${hidden}<input type="hidden" name="as" value="owner">
<button type="submit" class="secondary">I run this Run Coach</button>`;
  } else if (tx.stage === "garmin") {
    title = "Sign in to Garmin Connect";
    const joining = tx.invite
      ? `<p class="muted">Invite ${escapeHtml(formatInviteCode(tx.invite))} accepted. Sign in with your own Garmin account.</p>`
      : "";
    fields = `${joining}<p class="muted">Your password goes to Garmin only, once. Run Coach keeps the sign-in Garmin returns, encrypted.</p>
<label for="email">Garmin email</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="password">Garmin password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>`;
  } else if (tx.stage === "switch") {
    title = "Another Garmin account";
    fields = `<p>This Run Coach is linked to another Garmin account. Switch it to the account you just signed in with? Every app connected as the owner will then see this account's data.</p>
<button type="submit" name="switch" value="yes">Switch to this account</button>
<button type="submit" name="switch" value="no" class="secondary">Sign in with the linked account</button>`;
  } else {
    title = "Verification code";
    fields = `<p class="muted">Garmin sent you a verification code.</p>
<label for="code">Code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus>
<button type="submit">Verify</button>`;
  }
  return page({
    title,
    body: `<h1>${title}</h1>${who}${err}<form method="post" action="${action}">${hidden}${fields}</form>`,
    status: error ? 400 : 200,
    // The last step redirects to the client: its origin must be an allowed form target
    formAction: tx.kind === "authorize" ? redirectOrigin(tx) : undefined,
  });
}

function errorPage(message: string, status: number): Response {
  return page({
    title: "Can't continue",
    body: `<h1>Can't continue</h1><p>${escapeHtml(message)}</p>`,
    status,
  });
}

function linkUsedPage(): Response {
  return errorPage(
    "This sign-in link has expired or was already used. Ask again in your chat for a new one.",
    410,
  );
}

function tooManyPage(retryAfterMs: number): Response {
  return errorPage(
    `Too many sign-ins started from your network. Try again in ${Math.ceil(retryAfterMs / 60_000)} minutes.`,
    429,
  );
}

function redirectOrigin(tx: SignInTransaction): string[] {
  try {
    return [new URL(tx.authRequest!.redirectUri).origin];
  } catch {
    return [];
  }
}

/**
 * Who's asking, for rate limits: the IP (an IPv6 address's /64, which is what
 * one connection gets), hashed. The records expire within a day.
 */
export async function clientKey(request: Request): Promise<string> {
  return (await sha256Hex(ipNetwork(request.headers.get("CF-Connecting-IP") ?? ""))).slice(0, 32);
}

function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
