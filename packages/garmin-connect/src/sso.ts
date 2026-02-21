import { CookieJar } from "tough-cookie";
import type { MfaState } from "./types.ts";
import { GarminAuthError, GarminNetworkError, GarminRateLimitError } from "./errors.ts";

const CSRF_RE = /name="_csrf"\s+value="(.+?)"/;
const TITLE_RE = /<title>(.+?)<\/title>/;
const TICKET_RE = /embed\?ticket=([^"]+)"/;

export interface SsoConfig {
  domain: string;
  userAgent: string;
}

export type SsoLoginResult =
  | { status: "success"; ticket: string; cookies: CookieJar }
  | { status: "needs_mfa"; mfaState: MfaState };

export async function login(
  email: string,
  password: string,
  config: SsoConfig,
): Promise<SsoLoginResult> {
  const jar = new CookieJar();
  const SSO = `https://sso.${config.domain}/sso`;
  const SSO_EMBED = `${SSO}/embed`;

  const SSO_EMBED_PARAMS = new URLSearchParams({
    id: "gauth-widget",
    embedWidget: "true",
    gauthHost: SSO,
  });

  const SIGNIN_PARAMS = new URLSearchParams({
    id: "gauth-widget",
    embedWidget: "true",
    gauthHost: SSO_EMBED,
    service: SSO_EMBED,
    source: SSO_EMBED,
    redirectAfterAccountLoginUrl: SSO_EMBED,
    redirectAfterAccountCreationUrl: SSO_EMBED,
  });

  // Step 1: Establish session cookies
  await fetchWithCookies(`${SSO_EMBED}?${SSO_EMBED_PARAMS}`, jar, config);

  // Step 2: Get CSRF token from signin page
  const signinResp = await fetchWithCookies(`${SSO}/signin?${SIGNIN_PARAMS}`, jar, config, {
    headers: { Referer: SSO_EMBED },
  });
  const signinHtml = await signinResp.text();
  const csrfToken = extractCsrf(signinHtml);

  // Step 3: Submit credentials
  const loginResp = await fetchWithCookies(`${SSO}/signin?${SIGNIN_PARAMS}`, jar, config, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${SSO}/signin?${SIGNIN_PARAMS}`,
    },
    body: new URLSearchParams({
      username: email,
      password: password,
      embed: "true",
      _csrf: csrfToken,
    }),
    redirect: "manual",
  });

  if (loginResp.status === 429) {
    throw new GarminRateLimitError();
  }

  const loginHtml = await loginResp.text();
  const title = extractTitle(loginHtml);

  // Handle MFA
  if (title.includes("MFA") || title.includes("Challenge")) {
    return {
      status: "needs_mfa",
      mfaState: {
        signinParams: Object.fromEntries(SIGNIN_PARAMS),
        cookies: JSON.stringify(jar.toJSON()),
        csrfToken: extractCsrf(loginHtml),
      },
    };
  }

  if (title !== "Success") {
    throw new GarminAuthError(`Login failed: "${title}"`);
  }

  const ticket = extractTicket(loginHtml);
  return { status: "success", ticket, cookies: jar };
}

export async function submitMfa(
  mfaCode: string,
  mfaState: MfaState,
  config: SsoConfig,
): Promise<{ ticket: string; cookies: CookieJar }> {
  const jar = CookieJar.deserializeSync(JSON.parse(mfaState.cookies));
  const SSO = `https://sso.${config.domain}/sso`;
  const params = new URLSearchParams(mfaState.signinParams);

  const resp = await fetchWithCookies(`${SSO}/verifyMFA/loginEnterMfaCode?${params}`, jar, config, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${SSO}/verifyMFA/loginEnterMfaCode?${params}`,
    },
    body: new URLSearchParams({
      "mfa-code": mfaCode,
      embed: "true",
      _csrf: mfaState.csrfToken,
      fromPage: "setupEnterMfaCode",
    }),
    redirect: "manual",
  });

  if (resp.status === 429) {
    throw new GarminRateLimitError();
  }

  const html = await resp.text();
  const title = extractTitle(html);

  if (title !== "Success") {
    throw new GarminAuthError(`MFA verification failed: "${title}"`);
  }

  const ticket = extractTicket(html);
  return { ticket, cookies: jar };
}

// ── Helpers ─────────────────────────────────────────────

async function fetchWithCookies(
  url: string,
  jar: CookieJar,
  config: SsoConfig,
  init?: RequestInit,
): Promise<Response> {
  const cookieString = await jar.getCookieString(url);
  const headers = new Headers(init?.headers);
  if (cookieString) {
    headers.set("Cookie", cookieString);
  }
  headers.set("User-Agent", config.userAgent);

  let resp: Response;
  try {
    resp = await fetch(url, { ...init, headers, redirect: init?.redirect ?? "follow" });
  } catch (err) {
    throw new GarminNetworkError(err instanceof Error ? err.message : "Network request failed");
  }

  // Store response cookies
  const setCookies = resp.headers.getSetCookie();
  for (const cookie of setCookies) {
    await jar.setCookie(cookie, url);
  }

  return resp;
}

function extractCsrf(html: string): string {
  const match = CSRF_RE.exec(html);
  if (!match?.[1]) {
    throw new GarminAuthError("Could not extract CSRF token");
  }
  return match[1];
}

function extractTitle(html: string): string {
  const match = TITLE_RE.exec(html);
  if (!match?.[1]) {
    throw new GarminAuthError("Could not extract page title");
  }
  return match[1].trim();
}

function extractTicket(html: string): string {
  const match = TICKET_RE.exec(html);
  if (!match?.[1]) {
    throw new GarminAuthError("Could not extract SSO ticket");
  }
  return match[1];
}
