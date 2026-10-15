/** Set to `true` by vite.config.dev.ts when running `npm run dev:ui`. */
declare const __DEV_UI__: boolean;

/** Assets inlined as data URLs (Vite's `?inline`), e.g. the runner model. */
declare module "*?inline" {
  const src: string;
  export default src;
}
