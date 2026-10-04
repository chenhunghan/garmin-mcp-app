/**
 * ChatGPT-specific metadata (openai/mcp-extensions). Purely additive `_meta`
 * keys and icons: MCP Apps hosts such as Claude Desktop ignore them, so one
 * server serves both. Spec: https://github.com/openai/mcp-extensions/blob/main/docs/spec.md
 */

/**
 * A watch with a pulse line. Spec: monochrome SVG, transparent background,
 * `currentColor`, 20×20 viewport, 1.33px strokes (it follows the host theme).
 */
export const GARMIN_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"><path d="M7.2 4.5 7.8 2h4.4l.6 2.5"/><path d="M7.2 15.5 7.8 18h4.4l.6-2.5"/><rect x="4.5" y="4.5" width="11" height="11" rx="3"/><path d="M6.5 10h1.6l1-2 1.6 4 1-2h1.8"/></svg>`;

export const GARMIN_ICONS = [
  {
    src: `data:image/svg+xml;base64,${Buffer.from(GARMIN_ICON_SVG).toString("base64")}`,
    mimeType: "image/svg+xml",
    sizes: ["20x20"],
  },
];

/**
 * Open a tool's view from ChatGPT's navigation: `global` = a sidebar item
 * (opens fullscreen), `thread` = a tab inside a conversation. The tool MUST
 * accept `{}` as arguments.
 */
export function openaiEntrypoint(type: "global" | "thread") {
  return { "openai/ui": { entrypoints: [{ type }] } };
}

/**
 * `icons` for an entrypoint tool registered with registerAppTool. Its config
 * type doesn't declare `icons` (ext-apps 2.0.3), but it forwards the whole
 * config to `registerTool`, which supports them — spread this into the config.
 */
export const entrypointIcons: object = { icons: GARMIN_ICONS };
