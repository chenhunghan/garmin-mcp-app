import { useState, useEffect, useRef, useCallback } from "react";
import { type App, useApp } from "@modelcontextprotocol/ext-apps/react";
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
      className="auth-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(email, password);
      }}
    >
      <h2>Sign in to Garmin Connect</h2>
      {error && <div className="form-error">{error}</div>}
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoFocus
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <button type="submit" disabled={loading}>
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
      className="auth-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code);
      }}
    >
      <h2>Enter verification code</h2>
      <p className="form-hint">Check your email or authenticator app</p>
      {error && <div className="form-error">{error}</div>}
      <input
        type="text"
        placeholder="Verification code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        required
        autoFocus
        inputMode="numeric"
        autoComplete="one-time-code"
      />
      <button type="submit" disabled={loading}>
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

  if (connError) return <div className="center">Error: {connError.message}</div>;
  if (!isConnected) return <div className="center">Connecting...</div>;

  switch (authState) {
    case "checking":
      return <div className="center">Checking authentication...</div>;
    case "login":
      return (
        <div className="center">
          <LoginForm onSubmit={handleLogin} loading={loading} error={error} />
        </div>
      );
    case "mfa":
      return (
        <div className="center">
          <MfaForm onSubmit={handleMfa} loading={loading} error={error} />
        </div>
      );
    case "authenticated":
      return (
        <div className="center">
          <div className="auth-status">
            <span className="status-dot" />
            Connected to Garmin
          </div>
        </div>
      );
  }
}
