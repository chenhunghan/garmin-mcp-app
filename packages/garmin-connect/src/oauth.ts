import OAuth from "oauth-1.0a";
import type { OAuth1Token, OAuth2Token, OAuthConsumer } from "./types.ts";
import {
  GarminAuthError,
  GarminNetworkError,
  GarminRateLimitError,
  GarminTokenExpiredError,
} from "./errors.ts";

const OAUTH_CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";

// Hardcoded fallback (these rarely change)
const FALLBACK_CONSUMER: OAuthConsumer = {
  consumer_key: "fc3e99d2-118c-44b8-8ae3-03370dde24c0",
  consumer_secret: "E08WAR897WEY",
};

let cachedConsumer: OAuthConsumer | null = null;

export async function getConsumer(override?: OAuthConsumer): Promise<OAuthConsumer> {
  if (override) return override;
  if (cachedConsumer) return cachedConsumer;

  try {
    const resp = await fetch(OAUTH_CONSUMER_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    cachedConsumer = (await resp.json()) as OAuthConsumer;
    return cachedConsumer;
  } catch {
    cachedConsumer = FALLBACK_CONSUMER;
    return FALLBACK_CONSUMER;
  }
}

/**
 * Exchange SSO ticket for OAuth1 token.
 * OAuth1-signed GET with consumer key/secret only (no token).
 */
export async function getOAuth1Token(
  ticket: string,
  domain: string,
  consumer: OAuthConsumer,
): Promise<OAuth1Token> {
  const loginUrl = `https://sso.${domain}/sso/embed`;
  const url = `https://connectapi.${domain}/oauth-service/oauth/preauthorized?ticket=${encodeURIComponent(ticket)}&login-url=${encodeURIComponent(loginUrl)}&accepts-mfa-tokens=true`;

  const authHeader = await signRequest(consumer, { url, method: "GET" });

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        ...authHeader,
        "User-Agent": "com.garmin.android.apps.connectmobile",
      },
    });
  } catch (err) {
    throw GarminNetworkError.fromFetchError(err, url);
  }

  if (resp.status === 401) {
    throw new GarminAuthError("OAuth1 preauthorization rejected");
  }
  if (resp.status === 429) {
    throw new GarminRateLimitError();
  }
  if (!resp.ok) {
    throw new GarminAuthError(`OAuth1 preauthorization failed: ${resp.status} ${resp.statusText}`);
  }

  const text = await resp.text();
  const parsed = new URLSearchParams(text);

  const oauthToken = parsed.get("oauth_token");
  const oauthTokenSecret = parsed.get("oauth_token_secret");
  if (!oauthToken || !oauthTokenSecret) {
    throw new GarminAuthError("Invalid OAuth1 response: missing token");
  }

  return {
    oauth_token: oauthToken,
    oauth_token_secret: oauthTokenSecret,
    mfa_token: parsed.get("mfa_token") || undefined,
    mfa_expiration_timestamp: parsed.get("mfa_expiration_timestamp") || undefined,
    domain,
  };
}

/**
 * Exchange OAuth1 token for OAuth2 access + refresh tokens.
 * OAuth1-signed POST with all 4 credentials (consumer + token).
 */
export async function exchangeOAuth2(
  oauth1: OAuth1Token,
  consumer: OAuthConsumer,
): Promise<OAuth2Token> {
  const url = `https://connectapi.${oauth1.domain}/oauth-service/oauth/exchange/user/2.0`;

  const token = { key: oauth1.oauth_token, secret: oauth1.oauth_token_secret };
  const data: Record<string, string> = {};
  if (oauth1.mfa_token) {
    data.mfa_token = oauth1.mfa_token;
  }

  const authHeader = await signRequest(consumer, { url, method: "POST", data }, token);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        ...authHeader,
        "User-Agent": "com.garmin.android.apps.connectmobile",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(data),
    });
  } catch (err) {
    throw GarminNetworkError.fromFetchError(err, url);
  }

  if (resp.status === 401) {
    throw new GarminTokenExpiredError();
  }
  if (resp.status === 429) {
    throw new GarminRateLimitError();
  }
  if (!resp.ok) {
    throw new GarminAuthError(`OAuth2 exchange failed: ${resp.status} ${resp.statusText}`);
  }

  const json = (await resp.json()) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = json.expires_in as number;
  const refreshExpiresIn = json.refresh_token_expires_in as number;

  return {
    access_token: json.access_token as string,
    token_type: json.token_type as string,
    refresh_token: json.refresh_token as string,
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    refresh_token_expires_in: refreshExpiresIn,
    refresh_token_expires_at: now + refreshExpiresIn,
  };
}

/**
 * OAuth1 HMAC-SHA1 Authorization header, signed with WebCrypto so the client
 * runs outside Node (Cloudflare Workers). Same steps as oauth-1.0a's
 * `authorize()`, whose `hash_function` must be synchronous.
 */
export async function signRequest(
  consumer: OAuthConsumer,
  request: OAuth.RequestOptions,
  token?: OAuth.Token,
): Promise<OAuth.Header> {
  const oauth = new OAuth({
    consumer: { key: consumer.consumer_key, secret: consumer.consumer_secret },
    signature_method: "HMAC-SHA1",
    hash_function: () => "",
  });
  const data: OAuth.Data = {
    oauth_consumer_key: consumer.consumer_key,
    oauth_nonce: oauth.getNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: oauth.getTimeStamp(),
    oauth_version: "1.0",
  };
  if (token?.key !== undefined) data.oauth_token = token.key;
  const signature = await hmacSha1Base64(
    oauth.getSigningKey(token?.secret),
    oauth.getBaseString({ ...request, data: request.data ?? {} }, data),
  );
  return oauth.toHeader({ ...data, oauth_signature: signature });
}

async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}
