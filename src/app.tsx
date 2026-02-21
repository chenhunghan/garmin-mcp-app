import { useState, useEffect, useRef, useCallback } from "react";
import { type App, useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { StepsChart } from "./steps-chart.tsx";
import { ActivitiesChart } from "./activities-chart.tsx";
import { SleepChart } from "./sleep-chart.tsx";
import { HeartRateChart } from "./heart-rate-chart.tsx";
import { TrainingChart } from "./training-chart.tsx";
import { RacePredictionsChart } from "./race-predictions-chart.tsx";
import { HrZonesChart } from "./hr-zones-chart.tsx";
import { StressChart } from "./stress-chart.tsx";
import { SplitsChart } from "./splits-chart.tsx";
import { RunPlanner } from "./run-planner";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/input.tsx";
import "./app.css";

type AuthState = "checking" | "login" | "mfa" | "authenticated";

function LoginForm({
  onSubmit,
  loading,
  error,
}: {
  onSubmit: (email: string, password: string) => void;
  loading: boolean;
  error: string | null;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <CardTitle>Sign in to Garmin Connect</CardTitle>
        <CardDescription>Enter your credentials to continue</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(email, password);
          }}
        >
          {error && <div className="text-sm text-center text-destructive">{error}</div>}
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function MfaForm({
  onSubmit,
  loading,
  error,
}: {
  onSubmit: (code: string) => void;
  loading: boolean;
  error: string | null;
}) {
  const [code, setCode] = useState("");

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <CardTitle>Enter verification code</CardTitle>
        <CardDescription>Check your email or authenticator app</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(code);
          }}
        >
          {error && <div className="text-sm text-center text-destructive">{error}</div>}
          <div className="grid gap-2">
            <Label htmlFor="mfa-code">Verification code</Label>
            <Input
              id="mfa-code"
              type="text"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </div>
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Verifying..." : "Verify"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// Views that can be shown — tools declare their view via structuredContent.view
const VALID_VIEWS = new Set([
  "run-planner",
  "steps",
  "activities",
  "sleep",
  "heart-rate",
  "training",
  "race-predictions",
  "hr-zones",
  "stress",
  "splits",
]);

export function GarminApp() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = unknown (waiting for ontoolresult to tell us which view)
  const [visibleCharts, setVisibleCharts] = useState<Set<string> | null>(null);
  const appRef = useRef<App | null>(null);

  const callTool = useCallback(async (name: string, args?: Record<string, unknown>) => {
    const app = appRef.current;
    if (!app) return null;
    const result = await app.callServerTool({ name, arguments: args });
    const text = result.content?.[0];
    if (text && "text" in text) {
      return JSON.parse(text.text) as Record<string, unknown>;
    }
    return null;
  }, []);

  const checkAuth = useCallback(async () => {
    const data = await callTool("garmin-check-auth");
    if (data?.authenticated) {
      setAuthState("authenticated");
    } else {
      setAuthState("login");
    }
  }, [callTool]);

  const handleLogin = useCallback(
    async (email: string, password: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await callTool("garmin-login", { email, password });
        if (data?.status === "needs_mfa") {
          setAuthState("mfa");
        } else {
          setAuthState("authenticated");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Login failed");
      } finally {
        setLoading(false);
      }
    },
    [callTool],
  );

  const handleMfa = useCallback(
    async (code: string) => {
      setLoading(true);
      setError(null);
      try {
        await callTool("garmin-submit-mfa", { code });
        setAuthState("authenticated");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Verification failed");
      } finally {
        setLoading(false);
      }
    },
    [callTool],
  );

  const handleLogout = useCallback(async () => {
    setLoading(true);
    try {
      await callTool("garmin-logout");
      setAuthState("login");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Logout failed");
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  const {
    app,
    isConnected,
    error: connError,
  } = useApp({
    appInfo: { name: "garmin-mcp", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      appRef.current = app;

      // Dev UI: show all charts (no host tool calls to route).
      // Claude Desktop: stay null until ontoolresult sets the view.
      if (typeof __DEV_UI__ !== "undefined" && __DEV_UI__) {
        setVisibleCharts(
          new Set([
            "run-planner",
            "steps",
            "activities",
            "sleep",
            "heart-rate",
            "training",
            "race-predictions",
            "hr-zones",
            "stress",
            "splits",
          ]),
        );
      }

      app.ontoolresult = (params: Record<string, unknown>) => {
        // Route to the correct chart based on structuredContent.view
        const sc = params.structuredContent as Record<string, unknown> | undefined;
        const view = sc?.view;
        if (typeof view === "string" && VALID_VIEWS.has(view)) {
          setVisibleCharts(new Set([view]));
        }

        // Handle auth errors
        if (params.isError) {
          const text = (params.content as Array<Record<string, unknown>>)?.[0];
          if (text && "text" in text) {
            try {
              const data = JSON.parse(text.text as string);
              if (data.code === "not_authenticated") {
                setAuthState("login");
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      };
    },
  });

  useHostStyles(app, app?.getHostContext());

  useEffect(() => {
    if (isConnected) {
      checkAuth();
    }
  }, [isConnected, checkAuth]);

  if (connError)
    return (
      <div className="flex items-center justify-center min-h-screen text-destructive">
        Error: {connError.message}
      </div>
    );
  if (!isConnected)
    return (
      <div className="flex items-center justify-center min-h-screen text-muted-foreground">
        Connecting...
      </div>
    );

  switch (authState) {
    case "checking":
      return (
        <div className="flex items-center justify-center min-h-screen text-muted-foreground">
          Checking authentication...
        </div>
      );
    case "login":
      return (
        <div className="flex items-center justify-center min-h-screen p-4">
          <LoginForm onSubmit={handleLogin} loading={loading} error={error} />
        </div>
      );
    case "mfa":
      return (
        <div className="flex items-center justify-center min-h-screen p-4">
          <MfaForm onSubmit={handleMfa} loading={loading} error={error} />
        </div>
      );
    case "authenticated":
      return (
        <div className="flex flex-col p-4 gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: "var(--success)" }}
              />
              Connected to Garmin
            </div>
            <Button variant="outline" size="sm" onClick={handleLogout} disabled={loading}>
              {loading ? "Logging out..." : "Log out"}
            </Button>
          </div>
          {visibleCharts?.has("run-planner") && <RunPlanner callTool={callTool} />}
          {visibleCharts?.has("steps") && <StepsChart callTool={callTool} />}
          {visibleCharts?.has("activities") && <ActivitiesChart callTool={callTool} />}
          {visibleCharts?.has("heart-rate") && <HeartRateChart callTool={callTool} />}
          {visibleCharts?.has("sleep") && <SleepChart callTool={callTool} />}
          {visibleCharts?.has("training") && <TrainingChart callTool={callTool} />}
          {visibleCharts?.has("race-predictions") && <RacePredictionsChart callTool={callTool} />}
          {visibleCharts?.has("hr-zones") && <HrZonesChart callTool={callTool} />}
          {visibleCharts?.has("stress") && <StressChart callTool={callTool} />}
          {visibleCharts?.has("splits") && <SplitsChart callTool={callTool} />}
        </div>
      );
  }
}
