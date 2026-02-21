import OAuth from "oauth-1.0a";
import { createHmac } from "node:crypto";
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

  const oauth = createOAuth(consumer);
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "GET" }));

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        ...authHeader,
        "User-Agent": "com.garmin.android.apps.connectmobile",
      },
    });
  } catch (err) {
    throw new GarminNetworkError(err instanceof Error ? err.message : "Network request failed");
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

  const oauth = createOAuth(consumer);
  const token = { key: oauth1.oauth_token, secret: oauth1.oauth_token_secret };
  const data: Record<string, string> = {};
  if (oauth1.mfa_token) {
    data.mfa_token = oauth1.mfa_token;
  }

  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "POST", data }, token));

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
    throw new GarminNetworkError(err instanceof Error ? err.message : "Network request failed");
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

function createOAuth(consumer: OAuthConsumer): OAuth {
  return new OAuth({
    consumer: { key: consumer.consumer_key, secret: consumer.consumer_secret },
    signature_method: "HMAC-SHA1",
    hash_function(baseString: string, key: string) {
      return createHmac("sha1", key).update(baseString).digest("base64");
    },
  });
}
