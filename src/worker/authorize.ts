/**
 * The sign-in pages. `/authorize` connects an MCP client (Claude, ChatGPT):
 * owner passphrase, then Garmin email + password and, if asked, the
 * verification code — the Garmin step is skipped when the vault already has
 * tokens. `/signin?t=…` (a one-time link) is the Garmin step alone, for when
 * Garmin's sign-in expired. Each sign-in lives in the vault for 10 minutes,
 * bound to the browser that started it by a cookie. Nothing else is written
 * before the passphrase (or, for a link, the owner's Garmin sign-in) is right,
 * and starting sign-ins is rate-limited per IP.
 */
import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Sealer, randomId } from "./crypto.js";
import { vaultOf, type Env, type VaultStub } from "./env.js";
import { escapeHtml, page } from "./html.js";
import { checkSignInLink } from "./signin-link.js";
import { WrongAccountError, garminLogin, garminMfa } from "./signin.js";
import { LIMITS, type SignInTransaction } from "./vault.js";

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
  const sealer = new Sealer(env.TOKEN_ENCRYPTION_KEY);
  // Opening the link doesn't use it up (previews, reloads): signing in does
  const linkNonce = await checkSignInLink(vaultOf(env), sealer, token);
  if (!linkNonce) return linkUsedPage();
  return startSignIn(request, env, { kind: "signin", stage: "garmin", linkNonce });
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
    const check = await vault.checkPassphrase(
      String(form.get("passphrase") ?? ""),
      await clientKey(request),
    );
    if (!check.ok) {
      const error = check.retryAfterMs
        ? `Too many wrong passphrases. Try again in ${Math.ceil(check.retryAfterMs / 60_000)} minutes.`
        : "That passphrase isn't right.";
      return render(id, tx, error);
    }
    // Already signed in to Garmin (e.g. connecting a second app): done
    if (await vault.loadTokens()) return finish(env, vault, id, tx);
    tx.stage = "garmin";
    await vault.putSignIn(id, tx);
    return render(id, tx);
  }

  if (tx.stage === "switch") {
    // The owner (passphrase checked) signed in with another Garmin account
    if (form.get("switch") === "yes" && tx.switchTo) {
      await vault.setOwner(tx.switchTo.garminId);
      await vault.saveTokens(tx.switchTo.tokens);
      return finish(env, vault, id, tx);
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
  try {
    if (tx.stage === "garmin") {
      const result = await garminLogin(
        vault,
        String(form.get("email") ?? "").trim(),
        String(form.get("password") ?? ""),
      );
      if (result.status === "needs_mfa") {
        tx.stage = "mfa";
        tx.mfaState = result.mfaState;
        await vault.putSignIn(id, tx);
        return render(id, tx);
      }
    } else {
      if (!tx.mfaState) throw new Error("No verification pending");
      await garminMfa(vault, String(form.get("code") ?? "").trim(), tx.mfaState);
    }
  } catch (err) {
    if (err instanceof WrongAccountError) {
      // Only the passphrase holder may move this server to another account
      if (tx.kind === "authorize") {
        tx.stage = "switch";
        tx.switchTo = { garminId: err.garminId, tokens: err.tokens };
        delete tx.mfaState;
        await vault.putSignIn(id, tx);
        return render(id, tx);
      }
      await vault.deleteSignIn(id);
      return errorPage(err.message, 403);
    }
    await vault.putSignIn(id, tx);
    const what = tx.stage === "mfa" ? "verification code" : "sign-in";
    return render(id, tx, `Garmin didn't accept the ${what}: ${errorMessage(err)}`);
  }
  return finish(env, vault, id, tx);
}

async function finish(
  env: Env,
  vault: VaultStub,
  id: string,
  tx: SignInTransaction,
): Promise<Response> {
  await vault.deleteSignIn(id);
  if (tx.linkNonce) await vault.consumeLinkNonce(tx.linkNonce);
  // The owner's own browser: "today" for the tools is their day, not UTC's
  if (tx.timeZone) await vault.setTimeZone(tx.timeZone);
  const clear = `${COOKIE}${id}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  if (tx.kind === "authorize") {
    const request = tx.authRequest!;
    // One owner; Claude and ChatGPT each get their own grant
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request,
      userId: "owner",
      metadata: {},
      scope: request.scope,
      props: {},
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
    ? `<div class="who"><strong>${escapeHtml(c.name)}</strong>${c.verified ? "" : ` <span class="muted">(name not verified)</span>`} wants to use your Run Coach. When you're done, you go back to <strong>${escapeHtml(c.host)}</strong>.</div>${
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
    title = "Connect to your Run Coach";
    fields = `<p class="muted">Enter the owner passphrase you set when you deployed this server.</p>
<label for="passphrase">Owner passphrase</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Continue</button>`;
  } else if (tx.stage === "garmin") {
    title = "Sign in to Garmin Connect";
    fields = `<p class="muted">Your password goes to Garmin only, once. This server keeps the sign-in tokens Garmin returns, encrypted, in your Cloudflare account.</p>
<label for="email">Garmin email</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="password">Garmin password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>`;
  } else if (tx.stage === "switch") {
    title = "Another Garmin account";
    fields = `<p>This Run Coach is linked to another Garmin account. Switch it to the account you just signed in with? Every app connected to it will then see this account's data.</p>
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

/** Who's asking, for rate limits: the IP, hashed (the records expire within a day). */
export async function clientKey(request: Request): Promise<string> {
  return (await sha256Hex(request.headers.get("CF-Connecting-IP") ?? "")).slice(0, 32);
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
