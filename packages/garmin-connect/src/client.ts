import type {
  OAuth1Token,
  OAuth2Token,
  GarminClientConfig,
  LoginResult,
  MfaState,
} from "./types.ts";
import type { TokenStorage } from "./storage.ts";
import { FileTokenStorage } from "./storage.ts";
import { GarminAuthError, GarminError, GarminTokenExpiredError } from "./errors.ts";
import * as sso from "./sso.ts";
import * as oauth from "./oauth.ts";

const DEFAULT_DOMAIN = "garmin.com";
const DEFAULT_USER_AGENT = "com.garmin.android.apps.connectmobile";

export class GarminClient {
  private oauth1Token: OAuth1Token | null = null;
  private oauth2Token: OAuth2Token | null = null;
  private storage: TokenStorage;
  private domain: string;
  private userAgent: string;
  private oauthConsumerOverride;
  private pendingMfaState: MfaState | null = null;

  constructor(config?: GarminClientConfig) {
    this.domain = config?.domain ?? DEFAULT_DOMAIN;
    this.userAgent = config?.userAgent ?? DEFAULT_USER_AGENT;
    this.oauthConsumerOverride = config?.oauthConsumer;

    if (config?.storage) {
      this.storage = config.storage;
    } else {
      this.storage = new FileTokenStorage(config?.storagePath ?? "~/.garminconnect");
    }
  }

  // ── Authentication ────────────────────────────────────

  async login(email: string, password: string): Promise<LoginResult> {
    const ssoConfig = { domain: this.domain, userAgent: this.userAgent };
    const result = await sso.login(email, password, ssoConfig);

    if (result.status === "needs_mfa") {
      this.pendingMfaState = result.mfaState;
      return { status: "needs_mfa", mfaState: result.mfaState };
    }

    await this.exchangeAndSave(result.ticket);
    return {
      status: "success",
      oauth1: this.oauth1Token!,
      oauth2: this.oauth2Token!,
    };
  }

  async submitMfa(mfaCode: string, mfaState?: MfaState): Promise<void> {
    const state = mfaState ?? this.pendingMfaState;
    if (!state) throw new GarminAuthError("No pending MFA state");

    const ssoConfig = { domain: this.domain, userAgent: this.userAgent };
    const result = await sso.submitMfa(mfaCode, state, ssoConfig);
    await this.exchangeAndSave(result.ticket);
    this.pendingMfaState = null;
  }

  async resume(): Promise<void> {
    const tokens = await this.storage.load();
    if (!tokens) throw new GarminAuthError("No saved tokens found");
    this.oauth1Token = tokens.oauth1;
    this.oauth2Token = tokens.oauth2;

    if (this.isOAuth2Expired()) {
      await this.refreshOAuth2();
    }
  }

  get isAuthenticated(): boolean {
    return this.oauth1Token !== null && this.oauth2Token !== null;
  }

  async getAccessToken(): Promise<string> {
    if (!this.oauth2Token || !this.oauth1Token) {
      throw new GarminAuthError("Not authenticated");
    }
    if (this.isOAuth2Expired()) {
      await this.refreshOAuth2();
    }
    return this.oauth2Token.access_token;
  }

  get tokens(): { oauth1: OAuth1Token | null; oauth2: OAuth2Token | null } {
    return { oauth1: this.oauth1Token, oauth2: this.oauth2Token };
  }

  async logout(): Promise<void> {
    this.oauth1Token = null;
    this.oauth2Token = null;
    await this.storage.clear();
  }

  // ── Garmin Connect API ────────────────────────────────

  async connectapi<T = unknown>(
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    body?: unknown,
  ): Promise<T> {
    const accessToken = await this.getAccessToken();
    let resp = await this.makeApiRequest(path, method, body, accessToken);

    if (resp.status === 401) {
      await this.refreshOAuth2();
      resp = await this.makeApiRequest(path, method, body, this.oauth2Token!.access_token);
      if (resp.status === 401) {
        throw new GarminTokenExpiredError("Token rejected after refresh");
      }
    }

    if (!resp.ok) {
      throw new GarminError(`API error: ${resp.status} ${resp.statusText}`);
    }

    if (resp.status === 204 || resp.headers.get("content-length") === "0") {
      return undefined as T;
    }
    return resp.json() as Promise<T>;
  }

  // ── API Methods (date format: "YYYY-MM-DD") ──────────

  async getUserProfile(): Promise<unknown> {
    return this.connectapi("/userprofile-service/socialProfile");
  }

  async getFullName(): Promise<string> {
    const profile = (await this.connectapi("/userprofile-service/socialProfile")) as Record<
      string,
      unknown
    >;
    return (profile.displayName as string) ?? (profile.fullName as string) ?? "Unknown";
  }

  async getUserSummary(date: string): Promise<unknown> {
    return this.connectapi(`/usersummary-service/usersummary/daily?calendarDate=${date}`);
  }

  async getSteps(date: string): Promise<unknown> {
    return this.connectapi(`/usersummary-service/stats/steps/daily/${date}/${date}`);
  }

  async getHeartRates(date: string): Promise<unknown> {
    return this.connectapi(`/wellness-service/wellness/dailyHeartRate?date=${date}`);
  }

  async getSleepData(date: string): Promise<unknown> {
    return this.connectapi(`/wellness-service/wellness/dailySleepData?date=${date}`);
  }

  async getStressData(date: string): Promise<unknown> {
    return this.connectapi(`/wellness-service/wellness/dailyStress/${date}`);
  }

  async getBodyComposition(date: string): Promise<unknown> {
    return this.connectapi(`/weight-service/weight/dateRange?startDate=${date}&endDate=${date}`);
  }

  async getActivities(start = 0, limit = 20): Promise<unknown> {
    return this.connectapi(
      `/activitylist-service/activities/search/activities?start=${start}&limit=${limit}`,
    );
  }

  async getActivityDetails(activityId: string): Promise<unknown> {
    return this.connectapi(`/activity-service/activity/${activityId}`);
  }

  // ── Recovery & Readiness ─────────────────────────────

  async getTrainingReadiness(date: string): Promise<unknown> {
    return this.connectapi(`/metrics-service/metrics/trainingreadiness/${date}`);
  }

  async getTrainingStatus(date: string): Promise<unknown> {
    return this.connectapi(`/mobile-gateway/usersummary/trainingstatus/latest/${date}`);
  }

  async getHrvData(startDate: string, endDate: string): Promise<unknown> {
    return this.connectapi(`/hrv-service/hrv/daily/${startDate}/${endDate}`);
  }

  async getBodyBattery(startDate: string, endDate: string): Promise<unknown> {
    return this.connectapi(
      `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${startDate}&endDate=${endDate}`,
    );
  }

  // ── Activity Deep Dive ──────────────────────────────

  async getActivitySplits(activityId: string): Promise<unknown> {
    return this.connectapi(`/activity-service/activity/${activityId}/splits`);
  }

  async getActivityHrZones(activityId: string): Promise<unknown> {
    return this.connectapi(`/activity-service/activity/${activityId}/hrTimeInZones`);
  }

  // ── Fitness Benchmarks ──────────────────────────────

  async getVo2Max(startDate: string, endDate: string): Promise<unknown> {
    return this.connectapi(`/metrics-service/metrics/maxmet/daily/${startDate}/${endDate}`);
  }

  async getRacePredictions(): Promise<unknown> {
    const profile = (await this.connectapi("/userprofile-service/socialProfile")) as Record<
      string,
      unknown
    >;
    const displayName = profile.displayName as string;
    return this.connectapi(`/metrics-service/metrics/racepredictions/latest/${displayName}`);
  }

  async getUserSettings(): Promise<unknown> {
    return this.connectapi("/userprofile-service/userprofile/user-settings");
  }

  async getHydrationData(date: string): Promise<unknown> {
    return this.connectapi(`/usersummary-service/usersummary/hydration/daily/${date}`);
  }

  async getDeviceLastUsed(): Promise<unknown> {
    return this.connectapi("/device-service/deviceregistration/devices/usage");
  }

  // ── Workouts ──────────────────────────────────────────

  async getWorkouts(start = 0, limit = 20): Promise<unknown> {
    return this.connectapi(`/workout-service/workouts?start=${start}&limit=${limit}`);
  }

  async getWorkout(workoutId: string): Promise<unknown> {
    return this.connectapi(`/workout-service/workout/${workoutId}`);
  }

  async createWorkout(workout: Record<string, unknown>): Promise<unknown> {
    return this.connectapi("/workout-service/workout", "POST", workout);
  }

  async updateWorkout(workoutId: string, workout: Record<string, unknown>): Promise<unknown> {
    return this.connectapi(`/workout-service/workout/${workoutId}`, "PUT", workout);
  }

  async deleteWorkout(workoutId: string): Promise<unknown> {
    return this.connectapi(`/workout-service/workout/${workoutId}`, "DELETE");
  }

  async scheduleWorkout(workoutId: string, date: string): Promise<unknown> {
    return this.connectapi(`/workout-service/schedule/${workoutId}`, "POST", { date });
  }

  // ── Private ───────────────────────────────────────────

  private async exchangeAndSave(ticket: string): Promise<void> {
    const consumer = await oauth.getConsumer(this.oauthConsumerOverride);
    this.oauth1Token = await oauth.getOAuth1Token(ticket, this.domain, consumer);
    this.oauth2Token = await oauth.exchangeOAuth2(this.oauth1Token, consumer);
    await this.storage.save(this.oauth1Token, this.oauth2Token);
  }

  private isOAuth2Expired(): boolean {
    if (!this.oauth2Token) return true;
    const now = Math.floor(Date.now() / 1000);
    return now >= this.oauth2Token.expires_at - 60;
  }

  private async refreshOAuth2(): Promise<void> {
    if (!this.oauth1Token) throw new GarminTokenExpiredError();
    const consumer = await oauth.getConsumer(this.oauthConsumerOverride);
    this.oauth2Token = await oauth.exchangeOAuth2(this.oauth1Token, consumer);
    await this.storage.save(this.oauth1Token, this.oauth2Token);
  }

  private async makeApiRequest(
    path: string,
    method: string,
    body: unknown,
    accessToken: string,
  ): Promise<Response> {
    const url = `https://connectapi.${this.domain}/${path.replace(/^\//, "")}`;
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": this.userAgent,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}
