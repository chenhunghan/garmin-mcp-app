import type { TokenStorage } from "./storage.ts";

/** OAuth1 token returned from Garmin's preauthorized endpoint */
export interface OAuth1Token {
  oauth_token: string;
  oauth_token_secret: string;
  mfa_token?: string;
  mfa_expiration_timestamp?: string;
  domain: string;
}

/** OAuth2 token returned from Garmin's exchange endpoint */
export interface OAuth2Token {
  access_token: string;
  token_type: string;
  refresh_token: string;
  expires_in: number;
  /** Unix timestamp (seconds) */
  expires_at: number;
  refresh_token_expires_in: number;
  /** Unix timestamp (seconds) */
  refresh_token_expires_at: number;
}

/** Configuration for the Garmin client */
export interface GarminClientConfig {
  /** Default: "garmin.com", use "garmin.cn" for China */
  domain?: string;
  /** Where to persist tokens */
  storage?: TokenStorage;
  /** Shortcut: file path for FileTokenStorage */
  storagePath?: string;
  /** Override default consumer key/secret */
  oauthConsumer?: OAuthConsumer;
  /** Default: "com.garmin.android.apps.connectmobile" */
  userAgent?: string;
}

export interface OAuthConsumer {
  consumer_key: string;
  consumer_secret: string;
}

/** Result of a login attempt */
export type LoginResult =
  | { status: "success"; oauth1: OAuth1Token; oauth2: OAuth2Token }
  | { status: "needs_mfa"; mfaState: MfaState };

/** Opaque state object passed to submitMfa() after login returns needs_mfa */
export interface MfaState {
  signinParams: Record<string, string>;
  /** Serialized cookie jar (JSON) */
  cookies: string;
  csrfToken: string;
}
