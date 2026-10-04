import { afterEach, describe, expect, it, vi } from "vitest";
import { login, submitMfa } from "../src/sso.ts";
import { CookieJar } from "tough-cookie";
import { GarminNetworkError } from "../src/errors.ts";

const config = { domain: "garmin.com", userAgent: "test-agent" };
const SSO = "https://sso.garmin.com/sso";

const csrfPage = (title: string) =>
  `<html><head><title>${title}</title></head><body><input name="_csrf" value="csrf-123"/></body></html>`;
const successPage = `<html><head><title>Success</title></head><body><a href="https://sso.garmin.com/sso/embed?ticket=ST-abc">x</a></body></html>`;

function html(body: string, setCookie?: string) {
  const headers = new Headers({ "Content-Type": "text/html" });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(body, { status: 200, headers });
}

function redirect(location: string, setCookie?: string) {
  const headers = new Headers({ Location: location });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 302, headers });
}

type Call = { url: string; method: string; cookie: string | null };

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ url, method, cookie: new Headers(init.headers).get("Cookie") });
      return handler(url, init);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sso.login", () => {
  it("returns a ticket for non-MFA accounts", async () => {
    mockFetch((url, init) => {
      if (url.startsWith(`${SSO}/embed`)) return html("ok", "SESSION=1; Path=/sso");
      if (url.startsWith(`${SSO}/signin`) && init.method !== "POST")
        return html(csrfPage("Sign In"));
      return html(successPage);
    });

    const result = await login("a@b.com", "pw", config);
    expect(result).toMatchObject({ status: "success", ticket: "ST-abc" });
  });

  it("follows the MFA redirect and carries cookies across hops", async () => {
    const calls = mockFetch((url, init) => {
      if (url.startsWith(`${SSO}/embed`)) return html("ok", "SESSION=1; Path=/sso");
      if (url.startsWith(`${SSO}/signin`) && init.method !== "POST")
        return html(csrfPage("Sign In"));
      if (url.startsWith(`${SSO}/signin`))
        return redirect("/sso/verifyMFA/loginEnterMfaCode?id=x", "MFA=2; Path=/sso");
      if (url.startsWith(`${SSO}/verifyMFA/loginEnterMfaCode`))
        return html(csrfPage("Enter security code"));
      throw new Error(`unexpected ${url}`);
    });

    const result = await login("a@b.com", "pw", config);

    expect(result.status).toBe("needs_mfa");
    if (result.status !== "needs_mfa") return;
    expect(result.mfaState.csrfToken).toBe("csrf-123");

    const hop = calls.find((c) => c.url.includes("verifyMFA"));
    expect(hop?.method).toBe("GET");
    expect(hop?.cookie).toContain("SESSION=1");
    expect(hop?.cookie).toContain("MFA=2");
  });

  it("wraps network failures with the underlying cause", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND sso.garmin.com"), {
            code: "ENOTFOUND",
          }),
        });
      }),
    );

    const err = await login("a@b.com", "pw", config).catch((e) => e);
    expect(err).toBeInstanceOf(GarminNetworkError);
    expect(err.message).toContain("ENOTFOUND");
  });
});

describe("sso.submitMfa", () => {
  it("follows the post-MFA redirect to the success page", async () => {
    const calls = mockFetch((url, init) => {
      if (url.startsWith(`${SSO}/verifyMFA`) && init.method === "POST")
        return redirect(`${SSO}/embed?done=1`, "AUTH=3; Path=/sso");
      if (url.startsWith(`${SSO}/embed`)) return html(successPage);
      throw new Error(`unexpected ${url}`);
    });

    const result = await submitMfa(
      "123456",
      {
        signinParams: { id: "gauth-widget" },
        cookies: JSON.stringify(new CookieJar().toJSON()),
        csrfToken: "c",
      },
      config,
    );

    expect(result.ticket).toBe("ST-abc");
    expect(calls.at(-1)?.cookie).toContain("AUTH=3");
  });
});
