export { GarminClient } from "./client.ts";

export { FileTokenStorage } from "./storage.ts";
export { computeKmSplits, type KmSplit } from "./splits.ts";
export {
  buildWorkout,
  estimateSteps,
  parsePace,
  paceToSpeed,
  type WorkoutSpec,
  type WorkoutSpecStep,
  type SimpleStep,
  type RepeatStep,
  type StepKind,
  type StepDuration,
  type StepTarget,
  type WorkoutSport,
  type GarminWorkout,
  type GarminStep,
} from "./workout-builder.ts";
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
