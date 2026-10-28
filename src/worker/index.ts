/**
 * Run Coach as a self-hosted Cloudflare Worker (remote MCP server). The MCP
 * endpoint `/mcp` sits behind OAuth (workers-oauth-provider: dynamic client
 * registration, PKCE, tokens); `/authorize` asks for the owner passphrase and
 * the Garmin sign-in. The same createServer() as the stdio build, with
 * remoteDeps(). Never logs requests, tool arguments or results.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import pkg from "../../package.json" with { type: "json" };
import { createServer } from "../server.js";
import { handleAuthorize, handleSignInLink } from "./authorize.js";
import { remoteDeps } from "./deps.js";
import type { Env } from "./env.js";
import { landing } from "./landing.js";

export { GarminVault } from "./vault-do.js";

/** Grants live while they're used: each refresh extends them by this much. */
const GRANT_IDLE_TTL = 60 * 86_400;

const mcp: ExportedHandler<Env> & { fetch: NonNullable<ExportedHandler<Env>["fetch"]> } = {
  async fetch(request, env) {
    const deps = await remoteDeps(env, new URL(request.url).origin);
    return createMcpHandler(() => createServer(pkg.version, deps)).fetch(request);
  },
};

const site: ExportedHandler<Env> = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return handleAuthorize(request, env);
    if (pathname === "/signin") return handleSignInLink(request, env);
    if (pathname === "/" && request.method === "GET") return landing(request, env, pkg.version);
    return new Response("Not found", { status: 404 });
  },
};

/**
 * Tokens are bound to the URL clients connect to, which is the deployer's
 * own (*.workers.dev or a custom domain): one provider per origin.
 */
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcp,
      defaultHandler: site,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      // Clients register themselves (RFC 7591) or identify by a metadata document URL (CIMD)
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      refreshTokenTTL: GRANT_IDLE_TTL,
      refreshTokenIdleTTL: GRANT_IDLE_TTL,
    });
    if (providers.size > 8) providers.clear();
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
