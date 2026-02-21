import { cn } from "@/lib/utils.ts";

export function Select({
  className,
  onValueChange,
  children,
  ...props
}: Omit<React.ComponentProps<"select">, "onChange"> & {
  onValueChange?: (value: string) => void;
}) {
  return (
    <select
      className={cn(
        "flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      onChange={onValueChange ? (e) => onValueChange(e.target.value) : undefined}
      {...props}
    >
      {children}
    </select>
  );
}
