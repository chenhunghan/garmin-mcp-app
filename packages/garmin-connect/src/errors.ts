export class GarminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GarminError";
  }
}

export class GarminAuthError extends GarminError {
  constructor(message: string = "Authentication failed") {
    super(message);
    this.name = "GarminAuthError";
  }
}

export class GarminMfaRequiredError extends GarminError {
  constructor(message: string = "MFA code required") {
    super(message);
    this.name = "GarminMfaRequiredError";
  }
}

export class GarminRateLimitError extends GarminError {
  constructor(message: string = "Rate limit exceeded") {
    super(message);
    this.name = "GarminRateLimitError";
  }
}

export class GarminNetworkError extends GarminError {
  constructor(message: string = "Network error") {
    super(message);
    this.name = "GarminNetworkError";
  }
}

export class GarminTokenExpiredError extends GarminError {
  constructor(message: string = "OAuth1 token expired, re-login required") {
    super(message);
    this.name = "GarminTokenExpiredError";
  }
}
