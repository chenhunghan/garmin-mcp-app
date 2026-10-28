import { createHmac } from "node:crypto";
import OAuth from "oauth-1.0a";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signRequest } from "../src/oauth.ts";

const consumer = { consumer_key: "consumer-key", consumer_secret: "consumer-secret" };

/** The header the client sent before signing moved to WebCrypto. */
function nodeHeader(request: OAuth.RequestOptions, token?: OAuth.Token) {
  const oauth = new OAuth({
    consumer: { key: consumer.consumer_key, secret: consumer.consumer_secret },
    signature_method: "HMAC-SHA1",
    hash_function: (base, key) => createHmac("sha1", key).update(base).digest("base64"),
  });
  return oauth.toHeader(oauth.authorize(request, token));
}

describe("signRequest", () => {
  afterEach(() => vi.restoreAllMocks());

  // Fixed nonce and timestamp, so both signers sign the same base string
  function freeze() {
    vi.spyOn(OAuth.prototype, "getNonce").mockReturnValue("fixed-nonce");
    vi.spyOn(OAuth.prototype, "getTimeStamp").mockReturnValue(1_700_000_000);
  }

  it("matches the createHmac signature without a token (preauthorize GET)", async () => {
    freeze();
    const request = {
      url: "https://connectapi.garmin.com/oauth-service/oauth/preauthorized?ticket=ST-1&login-url=https%3A%2F%2Fsso.garmin.com%2Fsso%2Fembed&accepts-mfa-tokens=true",
      method: "GET",
    };
    expect(await signRequest(consumer, request)).toEqual(nodeHeader({ ...request }));
  });

  it("matches the createHmac signature with a token and body (exchange POST)", async () => {
    freeze();
    const request = {
      url: "https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0",
      method: "POST",
      data: { mfa_token: "mfa-123" },
    };
    const token = { key: "token-key", secret: "token secret/with&specials" };
    expect(await signRequest(consumer, request, token)).toEqual(nodeHeader({ ...request }, token));
  });
});
