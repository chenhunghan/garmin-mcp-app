import { createContext, useContext } from "react";

export type CallTool = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<Record<string, unknown> | null>;

/**
 * What a view can do besides render: call server tools, hand a question to
 * Claude, and tell Claude what the user is looking at. The host decides which
 * of these it supports, so views check `canAsk` / `canShareContext` and hide
 * the controls rather than show dead ones.
 */
export interface AppActions {
  callTool: CallTool;
  /** The host's assistant ("Claude", "ChatGPT"), for labels; null when unknown. */
  assistantName: string | null;
  /** Host accepts `ui/message`: send `text` as the user's next message to the assistant. */
  canAsk: boolean;
  ask: (text: string) => Promise<void>;
  /** Host accepts `ui/update-model-context`. */
  canShareContext: boolean;
  /**
   * Replace what Claude knows about the current view (e.g. "Dashboard: HRV and
   * resting HR, last 12 weeks; HRV trending down 8%"). Sent with the user's
   * next message; each call overwrites the previous one.
   */
  shareContext: (text: string, data?: Record<string, unknown>) => Promise<void>;
}

const noop = async () => {};

export const AppActionsContext = createContext<AppActions>({
  callTool: async () => null,
  assistantName: null,
  canAsk: false,
  ask: noop,
  canShareContext: false,
  shareContext: noop,
});

/** Name the assistant after the host, e.g. "Claude Desktop" → "Claude". */
export function assistantNameFor(hostName: string | undefined): string | null {
  if (!hostName) return null;
  if (/claude/i.test(hostName)) return "Claude";
  if (/chatgpt|openai|codex/i.test(hostName)) return "ChatGPT";
  return null;
}

export function useAppActions(): AppActions {
  return useContext(AppActionsContext);
}
