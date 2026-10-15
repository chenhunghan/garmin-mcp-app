/**
 * The replay's heads-up display style: dark translucent panels with a hairline
 * frame and corner brackets, a boxed index letter and a spaced-out uppercase
 * title, monospace numbers, thin white chart lines and one orange accent for
 * "now" and the selected metric. It sits on the 3D view, so it is dark in
 * both themes.
 */
import type { ReactNode } from "react";

export const HUD_ACCENT = "#ff8a3d";

/** A panel's frame and ground, for any floating box on the view */
export const hudBox =
  "relative border border-white/[0.13] bg-[rgba(8,10,12,0.62)] text-white/90 backdrop-blur-[6px]";

/** Small uppercase label with wide tracking */
export const hudLabel = "font-mono text-[9.5px] uppercase tracking-[0.22em] text-white/55";

/** Corner brackets: top-left and bottom-right, as on an instrument */
export function Brackets() {
  return (
    <>
      <span className="pointer-events-none absolute -left-px -top-px h-2.5 w-2.5 border-l border-t border-white/70" />
      <span className="pointer-events-none absolute -bottom-px -right-px h-2.5 w-2.5 border-b border-r border-white/70" />
    </>
  );
}

export function HudPanel({
  letter,
  title,
  aside,
  className = "",
  children,
}: {
  letter?: string;
  title?: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`${hudBox} px-3 pb-2.5 pt-2 ${className}`}>
      <Brackets />
      {(letter || title) && (
        <header className="mb-1.5 flex items-center gap-2">
          {letter && (
            <span className="flex h-4 w-4 items-center justify-center border border-white/45 font-mono text-[9px] text-white/80">
              {letter}
            </span>
          )}
          {title && (
            <span className="font-mono text-[10.5px] uppercase tracking-[0.28em] text-white/85">
              {title}
            </span>
          )}
          {aside && <span className={`ml-auto ${hudLabel} text-white/30`}>{aside}</span>}
        </header>
      )}
      {children}
    </section>
  );
}
