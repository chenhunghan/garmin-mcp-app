import { useState } from "react";
import { useAppActions } from "@/lib/app-actions.tsx";

/**
 * Suggested follow-up questions that, when clicked, are sent to Claude as the
 * user's next message. Claude does the analysis; the app only frames it.
 * Renders nothing when the host can't receive messages.
 */
export function AskClaude({
  questions,
  label = "Ask Claude",
}: {
  questions: string[];
  label?: string;
}) {
  const { canAsk, ask } = useAppActions();
  const [sent, setSent] = useState<string | null>(null);
  if (!canAsk || questions.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="mr-0.5 text-xs text-muted-foreground">{label}</span>
      {questions.map((q) => (
        <button
          key={q}
          type="button"
          disabled={sent !== null}
          onClick={async () => {
            setSent(q);
            try {
              await ask(q);
            } catch {
              setSent(null);
            }
          }}
          className="rounded-full border border-border/50 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent"
        >
          {sent === q ? "Sent to Claude ✓" : q}
        </button>
      ))}
    </div>
  );
}
