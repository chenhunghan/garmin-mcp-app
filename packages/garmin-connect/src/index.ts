export { GarminClient } from "./client.ts";

export { FileTokenStorage } from "./storage.ts";
export { computeKmSplits, type KmSplit } from "./splits.ts";
export type { TokenStorage } from "./storage.ts";

export type {
  OAuth1Token,
  OAuth2Token,
  GarminClientConfig,
  LoginResult,
  MfaState,
  OAuthConsumer,
} from "./types.ts";

export {
  GarminError,
  GarminAuthError,
  GarminApiError,
  GarminMfaRequiredError,
  GarminRateLimitError,
  GarminNetworkError,
  GarminTokenExpiredError,
} from "./errors.ts";
