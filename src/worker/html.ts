/** Server-rendered pages: no scripts unless a page brings its own hash, nothing third-party. */

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f7f7f5; --card: #fff; --fg: #1c1c1a; --muted: #6b6b66;
  --border: #e2e2dc; --accent: #c2410c; --error: #b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #1f1f1d; --fg: #ededea;
  --muted: #a3a39c; --border: #34342f; --accent: #fb923c; --error: #f87171; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
  background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--border);
  border-radius: 14px; padding: 28px 24px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.brand { color: var(--muted); font-size: 13px; margin: 0 0 20px; }
p { margin: 0 0 14px; }
.muted { color: var(--muted); font-size: 13px; }
.who { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 0 0 18px; font-size: 14px; }
.who strong { font-weight: 600; }
label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--fg); font: inherit; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { margin-top: 18px; width: 100%; padding: 10px 12px; border: 0; border-radius: 8px;
  background: var(--fg); color: var(--card); font: inherit; font-weight: 600; cursor: pointer; }
.error { color: var(--error); font-size: 14px; margin: 0 0 12px; }
code, .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.url { display: block; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); word-break: break-all; user-select: all; }
ol { padding-left: 20px; margin: 0 0 14px; } li { margin: 4px 0; }
a { color: var(--accent); }
`;

export interface PageOptions {
  title: string;
  /** Trusted HTML: escape every value interpolated into it */
  body: string;
  status?: number;
  /** Extra origins the page's forms may end up at (the OAuth client's redirect) */
  formAction?: string[];
  /** Inline script, allowed by its hash */
  script?: { source: string; sha256: string };
  headers?: HeadersInit;
}

export function page(o: PageOptions): Response {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `form-action 'self'${o.formAction?.length ? " " + o.formAction.join(" ") : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    ...(o.script ? [`script-src 'sha256-${o.script.sha256}'`] : []),
  ].join("; ");
  const headers = new Headers(o.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", csp);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  // Keep one-time sign-in tokens out of Referer headers
  headers.set("Referrer-Policy", "no-referrer");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(o.title)} · Run Coach</title><style>${STYLE}</style></head>
<body><main><p class="brand">Run Coach · self-hosted</p>${o.body}</main>${
    o.script ? `<script>${o.script.source}</script>` : ""
  }</body></html>`;
  return new Response(html, { status: o.status ?? 200, headers });
}

export async function sha256Base64(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  let bin = "";
  for (const b of d) bin += String.fromCharCode(b);
  return btoa(bin);
}
