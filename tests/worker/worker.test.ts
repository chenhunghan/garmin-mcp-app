/**
 * The self-hosted Worker end to end in workerd (Miniflare): OAuth with the
 * owner passphrase, Garmin sign-in (and MFA, wrong account, one-time links)
 * against a fake Garmin that answers the Worker's outbound requests, and the
 * MCP endpoint through a real MCP client.
 *
 * Run with `npm run test:worker` (bundles the Worker with wrangler first).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "http://localhost";
const PASSPHRASE = "a long owner passphrase for tests";
const REDIRECT = "https://client.example/callback";
const APP_HTML = "<!doctype html><title>stub app</title>";

// ── Fake Garmin ─────────────────────────────────────

/** Garmin account per email: other@ is a second account, mfa@ needs a code. */
const profileId = (email: string) => (email.startsWith("other") ? 2 : 1);
const garminCalls: string[] = [];
let ssoPassword = "";

const html = (body: string, status = 200) =>
  new Response(`<html><head>${body}</head></html>`, {
    status,
    headers: { "Content-Type": "text/html" },
  });
const csrf = `<input name="_csrf" value="csrf-1"/>`;
const success = (email: string) =>
  html(
    `<title>Success</title><a href="https://sso.garmin.com/sso/embed?ticket=ST-${encodeURIComponent(email)}">x</a>`,
  );

async function garmin(request: Request): Promise<Response> {
  const url = new URL(request.url);
  garminCalls.push(`${request.method} ${url.host}${url.pathname}`);
  if (url.host === "thegarth.s3.amazonaws.com") return new Response("", { status: 404 });
  if (url.host === "sso.garmin.com") {
    if (url.pathname === "/sso/embed") return html("<title>GAuth Embedded</title>");
    if (url.pathname === "/sso/signin" && request.method === "GET") {
      return html(`<title>Sign In</title>${csrf}`);
    }
    if (url.pathname === "/sso/signin") {
      const form = new URLSearchParams(await request.text());
      const email = form.get("username")!;
      ssoPassword = form.get("password")!;
      if (ssoPassword === "wrong") return html(`<title>Sign In</title>${csrf}`);
      if (email.startsWith("mfa")) return html(`<title>Enter MFA code</title>${csrf}`);
      return success(email);
    }
    if (url.pathname === "/sso/verifyMFA/loginEnterMfaCode") {
      const form = new URLSearchParams(await request.text());
      return form.get("mfa-code") === "123456"
        ? success("mfa@example.com")
        : html(`<title>Enter MFA code</title>${csrf}`);
    }
  }
  if (url.host === "connectapi.garmin.com") {
    if (url.pathname === "/oauth-service/oauth/preauthorized") {
      const email = url.searchParams.get("ticket")!.replace(/^ST-/, "");
      return new Response(`oauth_token=tok-${email}&oauth_token_secret=secret`);
    }
    if (url.pathname === "/oauth-service/oauth/exchange/user/2.0") {
      const token = /oauth_token="([^"]+)"/.exec(request.headers.get("Authorization") ?? "")?.[1];
      const email = decodeURIComponent(token ?? "").replace(/^tok-/, "");
      return Response.json({
        access_token: `acc-${email}`,
        token_type: "Bearer",
        refresh_token: "refresh",
        expires_in: 3600,
        refresh_token_expires_in: 7200,
      });
    }
    const email = (request.headers.get("Authorization") ?? "").replace(/^Bearer acc-/, "");
    if (url.pathname === "/userprofile-service/socialProfile") {
      return Response.json({ profileId: profileId(email), displayName: "runner" });
    }
    if (url.pathname.startsWith("/usersummary-service/stats/steps/daily/")) {
      return Response.json([{ calendarDate: "2026-10-01", totalSteps: 9000, stepGoal: 8000 }]);
    }
  }
  return new Response("not found", { status: 404 });
}

// ── Worker ──────────────────────────────────────────

let mf: Miniflare;

beforeAll(async () => {
  const out = mkdtempSync(join(tmpdir(), "run-coach-worker-"));
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out, "--env", ""], {
    stdio: "pipe",
  });
  const assets = mkdtempSync(join(tmpdir(), "run-coach-assets-"));
  writeFileSync(join(assets, "app.html"), APP_HTML);
  // The bundle is one ES module: no module rules needed
  const { modulesRules: _, ...workerOptions } = unstable_getMiniflareWorkerOptions(
    "wrangler.jsonc",
    "",
  ).workerOptions;
  // wrangler still describes the Worker in Miniflare 4's options
  mf = new Miniflare(
    convertV4MiniflareOptions({
      ...workerOptions,
      name: "run-coach",
      modules: true,
      scriptPath: join(out, "index.js"),
      modulesRoot: out,
      bindings: { OWNER_PASSPHRASE: PASSPHRASE, TOKEN_ENCRYPTION_KEY: "c".repeat(64) },
      assets: { ...workerOptions.assets!, directory: assets },
      outboundService: garmin,
    } as Parameters<typeof convertV4MiniflareOptions>[0]),
  );
  await mf.ready;
}, 120_000);

afterAll(() => mf?.dispose());

const fetchWorker = (input: string | URL, init?: RequestInit): Promise<Response> =>
  mf.dispatchFetch(new URL(input, ORIGIN), { redirect: "manual", ...init } as never) as never;

// ── OAuth helpers ───────────────────────────────────

const b64url = (b: Buffer) => b.toString("base64url");

async function registerClient(): Promise<string> {
  const res = await fetchWorker("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** A page's form state: the sign-in id and the cookie binding it to "this browser". */
class Browser {
  cookies = new Map<string, string>();
  tx = "";
  html = "";

  constructor(private ip = "203.0.113.1") {}

  async send(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetchWorker(path, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        "CF-Connecting-IP": this.ip,
      },
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const [k, v] = kv!.split("=");
      if (v) this.cookies.set(k!, v);
      else this.cookies.delete(k!);
    }
    if (res.headers.get("Content-Type")?.startsWith("text/html")) {
      this.html = await res.clone().text();
      this.tx = /name="tx" value="([^"]+)"/.exec(this.html)?.[1] ?? this.tx;
    }
    return res;
  }

  post(path: string, fields: Record<string, string>) {
    return this.send(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tx: this.tx, ...fields }),
    });
  }
}

async function startAuthorize(clientId: string, opts: { ip?: string } = {}) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const browser = new Browser(opts.ip);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-1",
    resource: `${ORIGIN}/mcp`,
  });
  const res = await browser.send(`/authorize?${params}`);
  expect(res.status).toBe(200);
  return { browser, verifier };
}

async function exchangeCode(clientId: string, location: string, verifier: string) {
  const code = new URL(location).searchParams.get("code")!;
  const res = await fetchWorker("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
      resource: `${ORIGIN}/mcp`,
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function mcpClient(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: (input, init) => fetchWorker(String(input), init),
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "worker-test", version: "0" });
  await client.connect(transport);
  return client;
}

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: { view?: string };
};

// ── Tests (in order: they share the one vault) ──────

describe("self-hosted Worker", () => {
  let clientId: string;
  let accessToken: string;

  it("serves the landing page with the connector URL", async () => {
    const res = await fetchWorker("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain(`${ORIGIN}/mcp`);
  });

  it("rejects MCP requests without a token, pointing at the resource metadata", async () => {
    const res = await fetchWorker("/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource/mcp");
  });

  it("refuses a wrong passphrase and doesn't ask for Garmin", async () => {
    clientId = await registerClient();
    const { browser } = await startAuthorize(clientId);
    expect(browser.html).toContain("Test Client");
    expect(browser.html).toContain("(name not verified)");
    expect(browser.html).toContain("client.example");
    // Not Claude or ChatGPT: the page says so
    expect(browser.html).toContain("client.example isn't Claude or ChatGPT");
    const res = await browser.post("/authorize", { passphrase: "nope" });
    expect(res.status).toBe(400);
    expect(browser.html).toContain("passphrase isn&#39;t right");
    expect(browser.html).not.toContain('name="password"');
  });

  it("refuses to continue a sign-in from another browser", async () => {
    const { browser } = await startAuthorize(clientId);
    browser.cookies.clear();
    const res = await browser.post("/authorize", { passphrase: PASSPHRASE });
    expect(res.status).toBe(400);
    expect(browser.html).toContain("another browser");
  });

  it("connects with passphrase + Garmin MFA sign-in and redirects with a code", async () => {
    const { browser, verifier } = await startAuthorize(clientId);
    await browser.post("/authorize", { passphrase: PASSPHRASE });
    expect(browser.html).toContain('name="password"');
    // The redirect target must be an allowed form target, or browsers block the last step
    const login = await browser.post("/authorize", {
      email: "mfa@example.com",
      password: "pw-1",
    });
    expect(login.headers.get("Content-Security-Policy")).toContain("https://client.example");
    expect(browser.html).toContain('name="code"');
    const res = await browser.post("/authorize", { code: "123456" });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location.startsWith(REDIRECT)).toBe(true);
    expect(new URL(location).searchParams.get("state")).toBe("state-1");
    accessToken = await exchangeCode(clientId, location, verifier);
  });

  it("serves tools, the app and Garmin data over MCP", async () => {
    const client = await mcpClient(accessToken);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get-daily-briefing");
    const app = await client.readResource({ uri: "ui://garmin-mcp/app.html" });
    expect((app.contents[0] as { text: string }).text).toBe(APP_HTML);
    const auth = (await client.callTool({ name: "garmin-check-auth" })) as ToolResult;
    expect(JSON.parse(auth.content[0]!.text)).toEqual({ authenticated: true });
    const steps = (await client.callTool({
      name: "get-steps",
      arguments: { date: "2026-10-01" },
    })) as ToolResult;
    expect(steps.isError).toBeFalsy();
    expect(JSON.parse(steps.content[0]!.text)[0].totalSteps).toBe(9000);
    expect(steps.structuredContent?.view).toBe("steps");
    await client.close();
  });

  it("a second client connects with the passphrase alone", async () => {
    const before = garminCalls.length;
    const id = await registerClient();
    const { browser, verifier } = await startAuthorize(id);
    const res = await browser.post("/authorize", { passphrase: PASSPHRASE });
    expect(res.status).toBe(302);
    expect(garminCalls.slice(before).filter((c) => c.includes("sso."))).toEqual([]);
    await exchangeCode(id, res.headers.get("Location")!, verifier);
  });

  it("when Garmin's sign-in is gone, tools answer with the app's form and a one-time link", async () => {
    const client = await mcpClient(accessToken);
    await client.callTool({ name: "garmin-logout" });
    const steps = (await client.callTool({
      name: "get-steps",
      arguments: { date: "2026-10-01" },
    })) as ToolResult;
    expect(steps.isError).toBe(true);
    expect(steps.structuredContent?.view).toBe("steps");
    const body = JSON.parse(steps.content[0]!.text) as { code: string; signInUrl: string };
    expect(body.code).toBe("not_authenticated");
    expect(body.signInUrl).toMatch(/^http:\/\/localhost\/signin\?t=/);

    // Another account can't take over, and a link offers no switch
    const intruder = new Browser();
    await intruder.send(body.signInUrl);
    const rejected = await intruder.post("/signin", { email: "other@example.com", password: "x" });
    expect(rejected.status).toBe(403);
    expect(intruder.html).toContain("another Garmin account");
    expect(intruder.html).not.toContain('name="switch"');

    // Opening the link (a preview, a reload) doesn't use it up
    const link = body.signInUrl;
    expect((await new Browser().send(link)).status).toBe(200);
    const owner = new Browser();
    await owner.send(link);
    const wrong = await owner.post("/signin", { email: "owner@example.com", password: "wrong" });
    expect(wrong.status).toBe(400);
    expect(owner.html).toContain("Garmin didn&#39;t accept");
    const ok = await owner.post("/signin", { email: "owner@example.com", password: "pw-2" });
    expect(ok.status).toBe(200);
    expect(owner.html).toContain("Signed in to Garmin");

    // Signing in used it up
    expect((await new Browser().send(link)).status).toBe(410);

    const steps2 = (await client.callTool({
      name: "get-steps",
      arguments: { date: "2026-10-01" },
    })) as ToolResult;
    expect(steps2.isError).toBeFalsy();
    await client.close();
  });

  it("signs in through the app with an encrypted password", async () => {
    const client = await mcpClient(accessToken);
    await client.callTool({ name: "garmin-logout" });
    const key = (await client.callTool({ name: "garmin-get-login-key" })) as ToolResult;
    const publicKey = JSON.parse(key.content[0]!.text).publicKey as string;
    const der = Uint8Array.from(atob(publicKey), (c) => c.charCodeAt(0));
    const pub = await crypto.subtle.importKey(
      "spki",
      der,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, new TextEncoder().encode("pw-app")),
    );
    const login = (await client.callTool({
      name: "garmin-login",
      arguments: {
        email: "owner@example.com",
        encryptedPassword: btoa(String.fromCharCode(...ct)),
      },
    })) as ToolResult;
    expect(JSON.parse(login.content[0]!.text)).toEqual({ status: "success" });
    expect(ssoPassword).toBe("pw-app");
    const auth = (await client.callTool({ name: "garmin-check-auth" })) as ToolResult;
    expect(JSON.parse(auth.content[0]!.text)).toEqual({ authenticated: true });
    await client.close();
  });

  it("lets the app's MFA form take another code after a mistyped one", async () => {
    const client = await mcpClient(accessToken);
    await client.callTool({ name: "garmin-logout" });
    const key = (await client.callTool({ name: "garmin-get-login-key" })) as ToolResult;
    const publicKey = JSON.parse(key.content[0]!.text).publicKey as string;
    const pub = await crypto.subtle.importKey(
      "spki",
      Uint8Array.from(atob(publicKey), (c) => c.charCodeAt(0)),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, new TextEncoder().encode("pw-mfa")),
    );
    const login = (await client.callTool({
      name: "garmin-login",
      arguments: { email: "mfa@example.com", encryptedPassword: btoa(String.fromCharCode(...ct)) },
    })) as ToolResult;
    expect(JSON.parse(login.content[0]!.text)).toEqual({ status: "needs_mfa" });
    const wrong = (await client.callTool({
      name: "garmin-submit-mfa",
      arguments: { code: "000000" },
    })) as ToolResult;
    expect(wrong.content[0]!.text).not.toContain("expired");
    const right = (await client.callTool({
      name: "garmin-submit-mfa",
      arguments: { code: "123456" },
    })) as ToolResult;
    expect(right.isError).toBeFalsy();
    const auth = (await client.callTool({ name: "garmin-check-auth" })) as ToolResult;
    expect(JSON.parse(auth.content[0]!.text)).toEqual({ authenticated: true });
    await client.close();
  });

  it("locks the passphrase after 5 failures, for that client only", async () => {
    const { browser } = await startAuthorize(clientId, { ip: "198.51.100.7" });
    for (let i = 0; i < 5; i++) await browser.post("/authorize", { passphrase: "nope" });
    await browser.post("/authorize", { passphrase: PASSPHRASE });
    expect(browser.html).toContain("Too many wrong passphrases");
    // The owner, elsewhere, still gets in (another client: a new grant replaces the old one)
    const owner = await startAuthorize(await registerClient());
    expect((await owner.browser.post("/authorize", { passphrase: PASSPHRASE })).status).toBe(302);
  });

  it("the owner can switch the server to another Garmin account", async () => {
    const client = await mcpClient(accessToken);
    await client.callTool({ name: "garmin-logout" });
    await client.close();
    const { browser, verifier } = await startAuthorize(clientId);
    await browser.post("/authorize", { passphrase: PASSPHRASE });
    await browser.post("/authorize", { email: "other@example.com", password: "pw-3" });
    expect(browser.html).toContain('name="switch"');
    const res = await browser.post("/authorize", { switch: "yes" });
    expect(res.status).toBe(302);
    const token = await exchangeCode(clientId, res.headers.get("Location")!, verifier);
    const client2 = await mcpClient(token);
    const auth = (await client2.callTool({ name: "garmin-check-auth" })) as ToolResult;
    expect(JSON.parse(auth.content[0]!.text)).toEqual({ authenticated: true });
    await client2.close();
  });

  it("limits client registrations per IP", async () => {
    const register = () =>
      fetchWorker("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.9" },
        body: JSON.stringify({ client_name: "Spam", redirect_uris: [REDIRECT] }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await register()).status);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
