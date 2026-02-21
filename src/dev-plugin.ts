/**
 * Vite plugin that exposes a POST /api/tools/call endpoint on the dev server.
 *
 * The browser-side dev.tsx forwards MCP tool calls to this endpoint via fetch.
 * The endpoint delegates to the real MCP server running in-process (see dev-server.ts).
 *
 * Uses viteServer.ssrLoadModule() to import dev-server.ts through Vite's SSR
 * transform pipeline — Node's native import() cannot resolve .ts files directly.
 */
import type { Plugin, ViteDevServer } from "vite";

export default function devPlugin(): Plugin {
  let viteServer: ViteDevServer;

  return {
    name: "garmin-dev-plugin",
    configureServer(server) {
      viteServer = server;
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/tools/call" || req.method !== "POST") return next();

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString());

        try {
          // Load via ssrLoadModule so Vite handles TS transform and module caching.
          const { getDevClient } = (await viteServer.ssrLoadModule(
            "./src/dev-server.ts",
          )) as typeof import("./dev-server.js");
          const client = await getDevClient();
          const result = await client.callTool({ name: body.name, arguments: body.arguments });
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error("[dev-plugin]", err);
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}
