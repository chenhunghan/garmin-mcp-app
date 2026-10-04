import { CookieJar } from "tough-cookie";
import type { MfaState } from "./types.ts";
import { GarminAuthError, GarminNetworkError, GarminRateLimitError } from "./errors.ts";

const CSRF_RE = /name="_csrf"\s+value="(.+?)"/;
const TITLE_RE = /<title>(.+?)<\/title>/;
const TICKET_RE = /embed\?ticket=([^"]+)"/;
const MFA_URL_RE = /verifyMFA|loginEnterMfaCode/i;
const MAX_REDIRECTS = 10;

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
  // Follow redirects manually: MFA accounts get a 302 to the MFA page, and each
  // hop's cookies must land in the jar.
  const { resp: loginResp, url: loginUrl } = await fetchFollowing(
    `${SSO}/signin?${SIGNIN_PARAMS}`,
    jar,
    config,
    {
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
    },
  );

  if (loginResp.status === 429) {
    throw new GarminRateLimitError();
  }

  const loginHtml = await loginResp.text();
  const title = TITLE_RE.exec(loginHtml)?.[1]?.trim() ?? "";

  // Handle MFA — detected by the redirect target or the page title
  if (MFA_URL_RE.test(loginUrl) || title.includes("MFA") || title.includes("Challenge")) {
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
    throw new GarminAuthError(
      title
        ? `Login failed: "${title}"`
        : `Login failed: unexpected response (${loginResp.status})`,
    );
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

  const { resp } = await fetchFollowing(
    `${SSO}/verifyMFA/loginEnterMfaCode?${params}`,
    jar,
    config,
    {
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
    },
  );

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
    resp = await fetch(url, {
      ...init,
      headers,
      redirect: init?.redirect ?? "follow",
    });
  } catch (err) {
    throw GarminNetworkError.fromFetchError(err, url);
  }

  // Store response cookies
  const setCookies = resp.headers.getSetCookie();
  for (const cookie of setCookies) {
    await jar.setCookie(cookie, url);
  }

  return resp;
}

/**
 * Follow 3xx redirects manually so cookies set on every hop are stored in the
 * jar (native fetch drops them). Subsequent hops are plain GETs, per 302/303
 * semantics. Returns the final response and the URL it was fetched from.
 */
async function fetchFollowing(
  url: string,
  jar: CookieJar,
  config: SsoConfig,
  init: RequestInit,
): Promise<{ resp: Response; url: string }> {
  let currentUrl = url;
  let currentInit: RequestInit = { ...init, redirect: "manual" };

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const resp = await fetchWithCookies(currentUrl, jar, config, currentInit);
    const location = resp.headers.get("location");
    if (resp.status < 300 || resp.status >= 400 || !location) {
      return { resp, url: currentUrl };
    }
    currentUrl = new URL(location, currentUrl).toString();
    currentInit = { redirect: "manual" };
  }

  throw new GarminAuthError("Too many redirects during SSO login");
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
