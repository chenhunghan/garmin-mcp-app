import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ToolArgs } from "@/lib/tool-args.ts";
import { useAppActions, type CallTool } from "@/lib/app-actions.tsx";
import { AskAssistant } from "@/components/ask-assistant.tsx";
import { Select } from "@/components/ui/select.tsx";
import { clockLabel, hrZone, locate, paceLabel, valueAt, type ReplayData } from "./replay-model.ts";
import { colorModes, cssColor, defaultZones, sampleColors, type ColorBy } from "./replay/colors.ts";
import { MetricPanels } from "./metric-lanes.tsx";
import { Brackets, HUD_ACCENT, hudBox, hudLabel } from "./replay-hud.tsx";
import { buildTrack, type Track } from "./replay/track.ts";
import type { RunMap } from "./geo/types.ts";
import { CAMERA_LABEL, type CameraMode, type ReplayScene } from "./replay/scene.ts";
import type { RunnerBody } from "./replay/runner-model.ts";
import { RUNNER_CREDIT, assetCredits } from "./replay-assets.ts";

/** base64 → bytes, without fetch() (a host's CSP may forbid data: URLs) */
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const RATES = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128];
const CAMERA_MODES: CameraMode[] = ["chase", "side", "front", "drone", "overview"];

export function RunReplayView({ callTool, args }: { callTool: CallTool; args?: ToolArgs }) {
  const [data, setData] = useState<ReplayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    callTool(
      "garmin-get-run-replay",
      args?.activityId !== undefined ? { activityId: args.activityId } : {},
    )
      .then((d) => {
        if (cancelled) return;
        const replay = d as unknown as ReplayData | null;
        if (!replay?.n || replay.n < 2)
          setError("This activity has no recorded time series to replay.");
        else setData(replay);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [callTool, args?.activityId]);

  if (error) {
    return (
      <div className="rounded-xl border border-border/50 p-6 text-sm text-muted-foreground">
        Couldn't load the run replay: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex aspect-[16/10] min-h-[360px] items-center justify-center rounded-xl border border-border/50 text-sm text-muted-foreground">
        Loading run…
      </div>
    );
  }
  return <ReplayPlayer key={data.activity.id} data={data} />;
}

function ReplayPlayer({ data }: { data: ReplayData }) {
  const { callTool, shareContext, canShareContext, displayMode, canFullscreen, setDisplayMode } =
    useAppActions();
  // Real map (elevation + OpenStreetMap): opt-in, fetched before the scene is built
  const [realMap, setRealMap] = useState<boolean | null>(null);
  // The server can't fetch map data (self-hosted on the Workers free plan)
  const [realMapUnavailable, setRealMapUnavailable] = useState(false);
  const [map, setMap] = useState<RunMap | null>(null);
  const [mapState, setMapState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [mapNote, setMapNote] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const timeRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<ReplayScene | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [backend, setBackend] = useState<string | null>(null);
  const [synthetic, setSynthetic] = useState(false);
  const [realMapShown, setRealMapShown] = useState(false);
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(2);
  const modes = useMemo(() => colorModes(data), [data]);
  const [colorBy, setColorBy] = useState<ColorBy>(modes[0] ?? "pace");
  const [camera, setCamera] = useState<CameraMode>("drone");
  const [showMetrics, setShowMetrics] = useState(true);
  // Which runner: from the Garmin profile (sex, height, weight), or picked
  const [body, setBody] = useState<RunnerBody>(() => {
    try {
      const v = localStorage.getItem("run-coach:runner-body");
      return v === "female" || v === "male" ? v : "profile";
    } catch {
      return "profile";
    }
  });
  const bodyRef = useRef(body);
  // Time under the pointer (timeline or a sparkline): every metric reads it
  const [hover, setHover] = useState<number | null>(null);
  // Plays as soon as the scene is ready (not for viewers who asked for reduced
  // motion), and keeps playing if the scene is rebuilt, e.g. when the map arrives
  const wantPlay = useRef(
    typeof matchMedia === "undefined" || !matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const duration = data.channels.t.at(-1) ?? 0;
  const track = useMemo(() => buildTrack(data), [data]);
  const zones = useMemo(() => data.hrZones ?? defaultZones(data), [data]);
  const fullscreen = displayMode === "fullscreen";

  useEffect(() => {
    callTool("garmin-run-map-settings")
      .then((r) => {
        setRealMap(!!r?.realMap);
        setRealMapUnavailable(!!r?.unavailable);
      })
      .catch(() => setRealMap(false));
  }, [callTool]);

  useEffect(() => {
    if (!realMap || !data.hasGps) {
      setMap(null);
      setMapState("idle");
      return;
    }
    let cancelled = false;
    setMapState("loading");
    callTool("garmin-get-run-map", { activityId: data.activity.id })
      .then((r) => {
        if (cancelled) return;
        const m = r as unknown as (RunMap & { enabled?: boolean; unavailable?: string }) | null;
        if (m?.dem || m?.roads?.length) {
          setMap(m);
          setMapState("ready");
          setMapNote(m.missing?.length ? `Couldn't load ${m.missing.join(", ")}.` : null);
        } else {
          setMap(null);
          setMapState("failed");
          setMapNote(
            m?.unavailable ??
              (m?.missing?.length ? `Couldn't load ${m.missing.join(", ")}.` : "No map data."),
          );
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setMap(null);
        setMapState("failed");
        setMapNote(`Real map unavailable: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [realMap, data, callTool]);

  const toggleRealMap = useCallback(
    async (on: boolean) => {
      setConsent(false);
      try {
        const r = await callTool("garmin-run-map-settings", { realMap: on });
        setRealMap(!!r?.realMap);
      } catch {
        // Keep the current setting
      }
    },
    [callTool],
  );

  // Wait for the settings (and the real map, when on) so the scene is built once
  const sceneReady = realMap !== null && mapState !== "loading";
  const sceneKey = `${data.activity.id}:${map ? "map" : "plain"}`;

  // Build the scene per run (and when the real map arrives); three.js loads on demand
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sceneReady) return;
    setStatus("loading");
    let disposed = false;
    let scene: ReplayScene | null = null;
    (async () => {
      try {
        const { ReplayScene } = await import("./replay/scene.ts");
        if (disposed) return;
        scene = new ReplayScene(canvas, data, map);
        scene.body = bodyRef.current;
        // The asset pack: scanned materials, sky light, models (served by the MCP server)
        scene.fetchAsset = async (file) => {
          const r = (await callTool("garmin-get-replay-asset", { file })) as {
            data?: string;
          } | null;
          if (!r?.data) throw new Error(`no data for ${file}`);
          return fromBase64(r.data);
        };
        scene.onAssets = (ids) => !disposed && setAssetIds(ids);
        const info = await scene.init();
        if (disposed) {
          scene.dispose();
          return;
        }
        if (timeRef.current > 0) scene.seek(timeRef.current);
        scene.onFrame = (f) => {
          timeRef.current = f.t;
          setT(f.t);
          setPlaying(f.playing);
        };
        scene.onEnded = () => {
          wantPlay.current = false;
          setPlaying(false);
        };
        sceneRef.current = scene;
        if (typeof __DEV_UI__ !== "undefined" && __DEV_UI__) {
          (window as unknown as { __replay?: ReplayScene }).__replay = scene;
        }
        setBackend(info.backend);
        setSynthetic(info.syntheticCourse);
        setRealMapShown(info.realMap);
        setStatus("ready");
        if (wantPlay.current) {
          scene.play();
          setPlaying(true);
        }
      } catch (e) {
        console.error("[replay]", e);
        if (!disposed) {
          setSceneError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      }
    })();
    return () => {
      disposed = true;
      sceneRef.current = null;
      scene?.dispose();
    };
    // sceneKey changes with the map; the canvas is replaced with it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, sceneReady, sceneKey]);

  useEffect(() => sceneRef.current?.setRate(rate), [rate, status]);
  useEffect(() => sceneRef.current?.setColorBy(colorBy), [colorBy, status]);
  useEffect(() => sceneRef.current?.setCameraMode(camera), [camera, status]);
  useEffect(() => {
    bodyRef.current = body;
    try {
      localStorage.setItem("run-coach:runner-body", body);
    } catch {
      // (storage unavailable: the pick lasts for this view)
    }
    const s = sceneRef.current;
    if (s && s.body !== body) void s.setRunnerBody(body);
  }, [body]);

  const togglePlay = useCallback(() => {
    const s = sceneRef.current;
    if (!s) return;
    if (s.playing) s.pause();
    else s.play();
    wantPlay.current = s.playing;
    setPlaying(s.playing);
  }, []);
  const seek = useCallback((time: number) => {
    const s = sceneRef.current;
    if (!s) return;
    s.seek(time);
    setT(s.time);
  }, []);

  // Values at the playhead
  const at = useMemo(() => locate(data.channels.t, t), [data, t]);
  const v = useCallback(
    (k: keyof ReplayData["channels"]) => valueAt(data.channels[k] as never, at),
    [data, at],
  );
  const hr = v("hr");
  const zone = hrZone(hr, zones);
  const speed = v("speed");
  const dist = v("d") ?? 0;
  const gradeNow = track.grade[at.i] ?? 0;
  const lap = data.laps.find((l) => t >= l.startT && t < l.endT) ?? data.laps.at(-1);

  // Tell the assistant what's on screen when paused
  const lastShared = useRef("");
  useEffect(() => {
    if (!canShareContext || playing || status !== "ready") return;
    const id = setTimeout(() => {
      const parts = [
        `Run replay: "${data.activity.name ?? "Run"}" (${data.activity.startLocal ?? ""}), paused at ${clockLabel(t)} / ${(dist / 1000).toFixed(2)} km`,
        speed ? `pace ${paceLabel(speed)}/km` : null,
        hr ? `HR ${Math.round(hr)} bpm (zone ${zone})` : null,
        v("cad") ? `cadence ${Math.round(v("cad")!)} spm` : null,
        v("elev") !== null
          ? `elevation ${Math.round(v("elev")!)} m, grade ${(gradeNow * 100).toFixed(1)}%`
          : null,
        v("power") ? `power ${Math.round(v("power")!)} W` : null,
        lap && data.laps.length > 1 ? `lap ${lap.index}` : null,
      ].filter(Boolean);
      const text = parts.join(", ");
      if (text === lastShared.current) return;
      lastShared.current = text;
      shareContext(text, {
        activityId: data.activity.id,
        t: Math.round(t),
        distanceM: Math.round(dist),
      }).catch(() => {});
    }, 600);
    return () => clearTimeout(id);
  }, [
    playing,
    t,
    status,
    canShareContext,
    shareContext,
    data,
    dist,
    speed,
    hr,
    zone,
    gradeNow,
    lap,
    v,
  ]);

  // Keyboard: space play/pause, ←/→ ±10 s (shift ±60 s), +/- speed, 1–5 cameras
  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      const s = sceneRef.current;
      if (!s) return;
      if (e.key === " " || e.key === "k") togglePlay();
      else if (e.key === "ArrowRight") seek(s.time + (e.shiftKey ? 60 : 10));
      else if (e.key === "ArrowLeft") seek(s.time - (e.shiftKey ? 60 : 10));
      else if (e.key === "+" || e.key === "=")
        setRate((r) => RATES[Math.min(RATES.length - 1, RATES.indexOf(r) + 1)]!);
      else if (e.key === "-") setRate((r) => RATES[Math.max(0, RATES.indexOf(r) - 1)]!);
      else if (/^[1-5]$/.test(e.key)) setCamera(CAMERA_MODES[Number(e.key) - 1]!);
      else return;
      e.preventDefault();
    },
    [togglePlay, seek],
  );

  const name = data.activity.name ?? "Run";
  const startLabel = startTimeLabel(data.activity.startLocal);
  const weather = data.weather;

  const questions = useMemo(() => {
    const label = `my run "${name}"${startLabel ? ` on ${startLabel}` : ""}`;
    return [
      `Where did I lose pace in ${label}, and why?`,
      `How did my heart rate drift over ${label}?`,
      data.channels.cad
        ? `Was my cadence and form consistent through ${label}?`
        : `How even was my pacing in ${label}?`,
    ];
  }, [name, startLabel, data.channels.cad]);

  return (
    <div className="flex flex-col gap-3">
      <div
        tabIndex={0}
        onKeyDown={onKey}
        className={
          "relative overflow-hidden rounded-xl border border-border/50 bg-[#0d1117] outline-none focus-visible:ring-2 focus-visible:ring-ring " +
          (fullscreen
            ? "h-[calc(100dvh-6.5rem)] min-h-[480px]"
            : "aspect-[16/10] min-h-[480px] max-h-[85vh]")
        }
        aria-label={`3D replay of ${name}`}
      >
        <canvas
          key={sceneKey}
          ref={canvasRef}
          className="absolute inset-0 h-full w-full touch-none"
        />

        {status !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white/80">
            {mapState === "loading"
              ? "Loading the real terrain and map…"
              : status === "loading"
                ? "Building the course…"
                : `3D isn't available here (${sceneError}). The timeline below still plays the data.`}
          </div>
        )}

        {/* Top: the run, the clock, the map */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
          <Glass className="max-w-[40%] px-3 py-2">
            <div className={hudLabel + " text-white/40"}>Run replay</div>
            <div className="truncate font-mono text-[13px] uppercase tracking-[0.18em] text-white">
              {name}
            </div>
            <div className="truncate font-mono text-[10px] tracking-wider text-white/50">
              {[startLabel, weatherLabel(weather)].filter(Boolean).join(" · ")}
            </div>
          </Glass>
          <Glass className="px-4 py-1.5 text-center">
            <div className="font-mono text-[26px] font-extralight tabular-nums leading-tight tracking-[0.12em] text-white">
              {clockLabel(t)}
            </div>
            <div className={hudLabel + " tabular-nums"}>
              {(dist / 1000).toFixed(2)} km
              {lap && data.laps.length > 1 ? ` · Lap ${lap.index}` : ""}
            </div>
          </Glass>
          <MiniMap track={track} i={at.i + at.f} className="hidden sm:block" />
        </div>

        {/* Every metric, in two columns along the edges: the middle stays clear */}
        {showMetrics && (
          <>
            <div className="absolute bottom-[4.25rem] left-3 top-[6.5rem] hidden w-[11.5rem] xl:w-[14.5rem] overflow-y-auto md:block">
              <MetricPanels
                data={data}
                track={track}
                zones={zones}
                t={t}
                duration={duration}
                hover={hover}
                onHover={setHover}
                colorBy={colorBy}
                onColorBy={setColorBy}
                onSeek={seek}
                groups={["Run"]}
              />
            </div>
            <div className="absolute bottom-[4.25rem] right-3 top-[9.75rem] hidden w-[11.5rem] xl:w-[14.5rem] overflow-y-auto md:block">
              <MetricPanels
                data={data}
                track={track}
                zones={zones}
                t={t}
                duration={duration}
                hover={hover}
                onHover={setHover}
                colorBy={colorBy}
                onColorBy={setColorBy}
                onSeek={seek}
                groups={["Terrain", "Form", "Body"]}
                firstLetter={1}
              />
            </div>
          </>
        )}

        {/* Bottom: one slim row of controls with the timeline in it */}
        <div className="absolute inset-x-3 bottom-3">
          <Glass className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 md:flex-nowrap">
            <IconButton
              label={playing ? "Pause (space)" : "Play (space)"}
              onClick={togglePlay}
              disabled={status !== "ready"}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </IconButton>
            <IconButton
              label="Back 10 s (←)"
              onClick={() => seek(t - 10)}
              disabled={status !== "ready"}
            >
              <SkipIcon back />
            </IconButton>
            <IconButton
              label="Forward 10 s (→)"
              onClick={() => seek(t + 10)}
              disabled={status !== "ready"}
            >
              <SkipIcon />
            </IconButton>
            <Select
              side="top"
              value={String(rate)}
              onValueChange={(r) => setRate(Number(r))}
              className="shrink-0"
              triggerClassName="h-7 rounded-none border border-white/20 bg-transparent px-2 py-0 font-mono text-[11px] tracking-wider text-white hover:bg-white/10"
              aria-label="Playback speed"
            >
              {RATES.map((r) => (
                <option key={r} value={String(r)}>
                  {`${r}×`}
                </option>
              ))}
            </Select>
            <div className="order-first min-w-0 basis-full md:order-none md:basis-auto md:flex-1">
              <Timeline
                data={data}
                track={track}
                colorBy={colorBy}
                t={t}
                duration={duration}
                hover={hover}
                onHover={setHover}
                onSeek={seek}
              />
            </div>
            <button
              type="button"
              onClick={() => setShowMetrics((x) => !x)}
              aria-pressed={showMetrics}
              title={showMetrics ? "Hide the metric panels" : "Show the metric panels"}
              className={
                hudLabel +
                " hidden shrink-0 whitespace-nowrap border border-white/20 px-2 py-1 hover:bg-white/10 hover:text-white md:inline-block"
              }
            >
              HUD {showMetrics ? "on" : "off"}
            </button>
            <div
              className="flex items-center border border-white/15"
              role="group"
              aria-label="Runner"
            >
              {(
                [
                  ["profile", "Me", "Your sex, height and build from your Garmin profile"],
                  ["female", "F", "Female runner"],
                  ["male", "M", "Male runner"],
                ] as const
              ).map(([b, label, title]) => (
                <button
                  key={b}
                  type="button"
                  title={title}
                  aria-pressed={body === b}
                  onClick={() => setBody(b)}
                  className={
                    "px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors " +
                    (body === b
                      ? "bg-white/90 text-black"
                      : "text-white/55 hover:bg-white/10 hover:text-white")
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <div
              className="ml-auto flex items-center border border-white/15 md:ml-0"
              role="group"
              aria-label="Camera"
            >
              {CAMERA_MODES.map((m, k) => (
                <button
                  key={m}
                  type="button"
                  title={`${CAMERA_LABEL[m]} camera (${k + 1})`}
                  onClick={() => setCamera(m)}
                  className={
                    "px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors " +
                    (camera === m
                      ? "bg-white/90 text-black"
                      : "text-white/55 hover:bg-white/10 hover:text-white")
                  }
                >
                  {CAMERA_LABEL[m]}
                </button>
              ))}
            </div>
            {canFullscreen && (
              <IconButton
                label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                onClick={() => setDisplayMode(fullscreen ? "inline" : "fullscreen")}
              >
                <FullscreenIcon exit={fullscreen} />
              </IconButton>
            )}
          </Glass>
        </div>
      </div>
      {/* Small screens: the metric panels under the view (over it they'd cover it all) */}
      <div className="grid gap-2 rounded-xl bg-[#0b0d10] p-2 sm:grid-cols-2 md:hidden">
        <MetricPanels
          data={data}
          track={track}
          zones={zones}
          t={t}
          duration={duration}
          hover={hover}
          onHover={setHover}
          colorBy={colorBy}
          onColorBy={setColorBy}
          onSeek={seek}
          className="contents"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {synthetic
            ? "No GPS track (indoor or treadmill run): the course shape is illustrative; distance, elevation and every metric are recorded."
            : realMapShown
              ? "Real terrain and map around your GPS track."
              : "Path from GPS; the landscape around it is illustrative."}{" "}
          Drag to orbit · scroll to zoom · space to play.
        </span>
        <span className="flex items-center gap-3">
          {data.hasGps && realMap !== null && !realMapUnavailable && (
            <button
              type="button"
              onClick={() => (realMap ? void toggleRealMap(false) : setConsent(true))}
              className="rounded-full border border-border/50 px-2.5 py-0.5 text-xs text-foreground hover:bg-muted"
            >
              Real map: {realMap ? (mapState === "loading" ? "loading…" : "on") : "off"}
            </button>
          )}
          {backend && <span>Rendered with {backend}</span>}
        </span>
      </div>
      {consent && (
        <div className="rounded-lg border border-border/50 p-3 text-xs text-foreground">
          <p className="mb-2">
            Show the real terrain and map around your runs? The server fetches elevation from AWS
            Terrain Tiles and roads, land cover, water and buildings from OpenStreetMap for the area
            around each run. Those services see that area, which often includes where you live. Data
            is cached on this computer.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void toggleRealMap(true)}
              className="rounded-md bg-foreground px-3 py-1 text-background"
            >
              Turn on
            </button>
            <button
              type="button"
              onClick={() => setConsent(false)}
              className="rounded-md border border-border/50 px-3 py-1"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {status === "ready" || mapNote ? (
        <div className="text-[11px] text-muted-foreground">
          {[
            realMapShown ? map?.attribution.join(" · ") : null,
            assetCredits(assetIds) || null,
            RUNNER_CREDIT,
          ]
            .filter(Boolean)
            .join(" · ")}
          {mapNote && <span className="ml-2">{mapNote}</span>}
        </div>
      ) : null}
      <AskAssistant questions={questions} />
    </div>
  );
}

// ── Pieces ──

/** A floating box on the view, in the HUD style (replay-hud.tsx) */
function Glass({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`${hudBox} ${className}`}>
      <Brackets />
      {children}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 w-7 shrink-0 items-center justify-center text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="4" width="4.5" height="16" rx="1.2" />
      <rect x="13.5" y="4" width="4.5" height="16" rx="1.2" />
    </svg>
  );
}

function SkipIcon({ back }: { back?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={back ? { transform: "scaleX(-1)" } : undefined}
    >
      <path d="M4 12a8 8 0 1 0 2.3-5.6" />
      <path d="M4 4v4h4" />
      <text
        x="12"
        y="15.5"
        fontSize="7.5"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        style={back ? { transform: "scaleX(-1)", transformOrigin: "12px 12px" } : undefined}
      >
        10
      </text>
    </svg>
  );
}

function FullscreenIcon({ exit }: { exit?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      {exit ? (
        <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
      ) : (
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      )}
    </svg>
  );
}

/** Route outline from above with the runner's position. */
/**
 * The timeline: elevation profile with the route's color strip under it and
 * lap marks; click or drag anywhere to jump there. The pointer's time is
 * shared with the metric cards, which then read that moment.
 */
function Timeline({
  data,
  track,
  colorBy,
  t,
  duration,
  hover,
  onHover,
  onSeek,
}: {
  data: ReplayData;
  track: Track;
  colorBy: ColorBy;
  t: number;
  duration: number;
  hover: number | null;
  onHover: (t: number | null) => void;
  onSeek: (t: number) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  // useId's colons aren't safe inside url(#…)
  const gradientId = `strip${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const W = 1000;
  const H = 30;
  const STRIP = 3;
  const buckets = 300;
  const { area, strip } = useMemo(() => {
    const { t: ts } = data.channels;
    const base = H - STRIP - 2;
    const colors = sampleColors(data, colorBy, track.grade, track.y);
    const ys: number[] = [];
    const strip: { x: number; color: string }[] = [];
    for (let b = 0; b <= buckets; b++) {
      const { i } = locate(ts, (b / buckets) * duration);
      ys.push(track.y[i]!);
      strip.push({ x: (b / buckets) * W, color: cssColor(colors, i) });
    }
    // The profile on its own range, with a little headroom
    const lo = Math.min(...ys);
    const span = Math.max(Math.max(...ys) - lo, 4);
    let d = `M0,${base}`;
    ys.forEach((y, b) => {
      d += `L${((b / buckets) * W).toFixed(1)},${(base - ((y - lo) / span) * (base - 6)).toFixed(1)}`;
    });
    d += `L${W},${base}Z`;
    return { area: d, strip };
  }, [data, track, colorBy, duration]);

  const timeFromEvent = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
  };
  const x = duration > 0 ? (t / duration) * W : 0;
  const hoverAt = hover !== null ? locate(data.channels.t, hover) : null;

  return (
    <div className="relative px-0.5 text-white">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-[30px] w-full cursor-pointer touch-none select-none"
        role="slider"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(t)}
        aria-valuetext={clockLabel(t)}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          onSeek(timeFromEvent(e));
        }}
        onPointerMove={(e) => {
          onHover(timeFromEvent(e));
          if (e.buttons & 1) onSeek(timeFromEvent(e));
        }}
        onPointerLeave={() => onHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
            {strip.map((s, k) => (
              <stop key={k} offset={s.x / W} stopColor={s.color} />
            ))}
          </linearGradient>
        </defs>
        <path
          d={area}
          fill="currentColor"
          fillOpacity={0.07}
          stroke="currentColor"
          strokeOpacity={0.6}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <rect x={0} y={0} width={x} height={H - STRIP - 2} fill="currentColor" fillOpacity={0.06} />
        <rect x={0} y={H - STRIP} width={W} height={STRIP} rx={2} fill={`url(#${gradientId})`} />
        {data.laps.slice(1).map((l) => (
          <line
            key={l.index}
            x1={(l.startT / duration) * W}
            x2={(l.startT / duration) * W}
            y1={4}
            y2={H - STRIP}
            stroke="currentColor"
            strokeOpacity={0.3}
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {hover !== null && (
          <line
            x1={(hover / duration) * W}
            x2={(hover / duration) * W}
            y1={0}
            y2={H}
            stroke="currentColor"
            strokeOpacity={0.5}
            vectorEffect="non-scaling-stroke"
          />
        )}
        <line
          x1={x}
          x2={x}
          y1={0}
          y2={H}
          stroke={HUD_ACCENT}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {hoverAt && hover !== null && (
        <div
          className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 whitespace-nowrap border border-white/20 bg-[rgba(8,10,12,0.85)] px-2 py-0.5 font-mono text-[10px] tracking-wider tabular-nums text-white"
          style={{ left: `${(hover / duration) * 100}%` }}
        >
          {clockLabel(hover)} · {((valueAt(data.channels.d, hoverAt) ?? 0) / 1000).toFixed(2)} km
        </div>
      )}
    </div>
  );
}

function MiniMap({ track, i, className = "" }: { track: Track; i: number; className?: string }) {
  const size = 112;
  const { path, project } = useMemo(() => {
    const b = track.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 1);
    const pad = 10;
    const k = (size - pad * 2) / span;
    const ox = pad + (size - pad * 2 - (b.maxX - b.minX) * k) / 2;
    const oz = pad + (size - pad * 2 - (b.maxZ - b.minZ) * k) / 2;
    const project = (x: number, z: number) =>
      [ox + (x - b.minX) * k, oz + (z - b.minZ) * k] as const;
    const step = Math.max(1, Math.floor(track.n / 400));
    let d = "";
    for (let j = 0; j < track.n; j += step) {
      const [px, py] = project(track.x[j]!, track.z[j]!);
      d += `${j ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`;
    }
    return { path: d, project };
  }, [track]);
  const j = Math.min(track.n - 1, Math.floor(i));
  const f = i - j;
  const k2 = Math.min(track.n - 1, j + 1);
  const [px, py] = project(
    track.x[j]! + (track.x[k2]! - track.x[j]!) * f,
    track.z[j]! + (track.z[k2]! - track.z[j]!) * f,
  );
  return (
    <Glass className={"p-1 " + className}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label="Route map">
        <path
          d={path}
          fill="none"
          stroke="white"
          strokeOpacity={0.55}
          strokeWidth={1.25}
          strokeLinejoin="round"
        />
        <circle cx={px} cy={py} r={6} fill="none" stroke={HUD_ACCENT} strokeOpacity={0.6} />
        <circle cx={px} cy={py} r={2.5} fill={HUD_ACCENT} />
        <text
          x={size - 6}
          y={13}
          fontSize={10}
          textAnchor="end"
          fill="white"
          fillOpacity={0.5}
          fontFamily="ui-monospace, monospace"
        >
          N
        </text>
      </svg>
    </Glass>
  );
}

function startTimeLabel(startLocal: string | null): string | null {
  if (!startLocal) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(startLocal);
  if (!m) return null;
  const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function weatherLabel(w: ReplayData["weather"]): string | null {
  if (!w) return null;
  const parts = [
    w.tempC !== null ? `${Math.round(w.tempC)}°C` : null,
    w.description,
    w.windKph !== null ? `wind ${Math.round(w.windKph)} km/h` : null,
    w.humidity !== null ? `${Math.round(w.humidity)}% RH` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}
