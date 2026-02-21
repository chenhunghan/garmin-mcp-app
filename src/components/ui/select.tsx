import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

interface SelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children: ReactNode;
}

interface OptionInfo {
  value: string;
  label: string;
}

/** Extract value/label pairs from <option> children. */
function extractOptions(children: ReactNode): OptionInfo[] {
  const options: OptionInfo[] = [];
  const arr = Array.isArray(children) ? children : [children];
  for (const child of arr.flat(Infinity)) {
    if (child && typeof child === "object" && "props" in child && child.type === "option") {
      const value = String(child.props.value ?? "");
      const label = String(child.props.children ?? value);
      options.push({ value, label });
    }
  }
  return options;
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function Select({ value, onValueChange, className, children }: SelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const options = extractOptions(children);
  const selected = options.find((o) => o.value === value);

  const close = useCallback(() => setOpen(false), []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, close]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, close]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-full bg-foreground/10 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-foreground/15"
      >
        {selected?.label ?? "Select"}
        <ChevronDown className="opacity-60" />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[var(--trigger-width,8rem)] rounded-lg border border-border/50 bg-popover p-1 shadow-lg">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={cn(
                "flex w-full items-center rounded-md px-2.5 py-1.5 text-xs transition-colors",
                opt.value === value
                  ? "bg-accent text-accent-foreground"
                  : "text-popover-foreground hover:bg-accent/50",
              )}
              onClick={() => {
                onValueChange?.(opt.value);
                close();
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
