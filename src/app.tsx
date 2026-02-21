import { useState, useEffect, useRef, useCallback } from "react";
import { type App, useApp } from "@modelcontextprotocol/ext-apps/react";
import { StepsChart } from "./steps-chart.tsx";
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
    <form
      className="flex flex-col gap-3 w-full max-w-80 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(email, password);
      }}
    >
      <h2 className="text-lg font-semibold text-center mb-1">Sign in to Garmin Connect</h2>
      {error && <div className="text-red-600 text-sm text-center">{error}</div>}
      <input
        className="px-3 py-2.5 border border-gray-300 rounded-md text-sm outline-none transition-colors focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoFocus
      />
      <input
        className="px-3 py-2.5 border border-gray-300 rounded-md text-sm outline-none transition-colors focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <button
        className="px-4 py-2.5 bg-blue-600 text-white rounded-md text-sm font-medium cursor-pointer transition-colors hover:not-disabled:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
        type="submit"
        disabled={loading}
      >
        {loading ? "Signing in..." : "Sign in"}
      </button>
    </form>
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
    <form
      className="flex flex-col gap-3 w-full max-w-80 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code);
      }}
    >
      <h2 className="text-lg font-semibold text-center mb-1">Enter verification code</h2>
      <p className="text-gray-500 text-sm text-center">Check your email or authenticator app</p>
      {error && <div className="text-red-600 text-sm text-center">{error}</div>}
      <input
        className="px-3 py-2.5 border border-gray-300 rounded-md text-sm outline-none transition-colors focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
        type="text"
        placeholder="Verification code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        required
        autoFocus
        inputMode="numeric"
        autoComplete="one-time-code"
      />
      <button
        className="px-4 py-2.5 bg-blue-600 text-white rounded-md text-sm font-medium cursor-pointer transition-colors hover:not-disabled:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
        type="submit"
        disabled={loading}
      >
        {loading ? "Verifying..." : "Verify"}
      </button>
    </form>
  );
}

export function GarminApp() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const { isConnected, error: connError } = useApp({
    appInfo: { name: "garmin-mcp", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      appRef.current = app;

      app.ontoolresult = (params) => {
        if (!params.isError) return;
        const text = params.content?.[0];
        if (text && "text" in text) {
          try {
            const data = JSON.parse(text.text);
            if (data.code === "not_authenticated") {
              setAuthState("login");
            }
          } catch {
            // ignore parse errors
          }
        }
      };
    },
  });

  useEffect(() => {
    if (isConnected) {
      checkAuth();
    }
  }, [isConnected, checkAuth]);

  if (connError)
    return (
      <div className="flex items-center justify-center min-h-screen">
        Error: {connError.message}
      </div>
    );
  if (!isConnected)
    return <div className="flex items-center justify-center min-h-screen">Connecting...</div>;

  switch (authState) {
    case "checking":
      return (
        <div className="flex items-center justify-center min-h-screen">
          Checking authentication...
        </div>
      );
    case "login":
      return (
        <div className="flex items-center justify-center min-h-screen">
          <LoginForm onSubmit={handleLogin} loading={loading} error={error} />
        </div>
      );
    case "mfa":
      return (
        <div className="flex items-center justify-center min-h-screen">
          <MfaForm onSubmit={handleMfa} loading={loading} error={error} />
        </div>
      );
    case "authenticated":
      return (
        <div className="flex flex-col min-h-screen p-4 gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[15px] text-gray-700">
              <span className="w-2 h-2 rounded-full bg-green-500" />
              Connected to Garmin
            </div>
            <button
              className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 cursor-pointer transition-colors"
              onClick={handleLogout}
              disabled={loading}
            >
              {loading ? "Logging out..." : "Log out"}
            </button>
          </div>
          <StepsChart callTool={callTool} />
        </div>
      );
  }
}
