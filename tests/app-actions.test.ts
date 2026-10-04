import { describe, expect, it } from "vitest";
import { assistantNameFor } from "../src/lib/app-actions.tsx";

describe("assistantNameFor", () => {
  it("names the assistant after the host", () => {
    expect(assistantNameFor("Claude Desktop")).toBe("Claude");
    expect(assistantNameFor("claude-ai")).toBe("Claude");
    expect(assistantNameFor("ChatGPT")).toBe("ChatGPT");
    expect(assistantNameFor("codex-desktop")).toBe("ChatGPT");
  });
  it("is neutral for unknown hosts", () => {
    expect(assistantNameFor("dev-mock")).toBeNull();
    expect(assistantNameFor(undefined)).toBeNull();
  });
});
