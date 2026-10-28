import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { api, API } from "../api";

export function LoginPage() {
  const { login, register, user } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as any;
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The server gives each provider its own start path, so the page does not have
  // to know that OIDC and SAML begin at different URLs.
  const [providers, setProviders] = useState<{ id: string; label: string; protocol: string; startPath: string }[]>([]);

  // Only render the SSO section when the deployment actually has a provider.
  useEffect(() => { api.getSsoProviders().then((r) => setProviders(r.providers)).catch(() => {}); }, []);

  // The callback redirects back here with ?sso_error=… when sign-in was refused.
  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get("sso_error");
    if (err) setError(err);
  }, []);

  const dest = loc.state?.from ?? "/";
  if (user) { nav(dest, { replace: true }); return null; }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password, displayName);
      nav(dest, { replace: true });
    } catch (err: any) {
      setError(err.message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-hero">
        <div className="brand display">Yumi<span className="dot">.</span></div>
        <div>
          <div className="display" style={{ fontSize: "clamp(28px,4vw,44px)", maxWidth: "14ch" }}>
            Think together.
          </div>
          <p style={{ maxWidth: "42ch", opacity: 0.75, lineHeight: 1.5, marginTop: 16 }}>
            One room where the whole team draws, codes, and talks on a single living surface —
            so the context never leaves the work.
          </p>
        </div>
        <div className="meta" style={{ color: "var(--accent)" }}>Draw · Code · Talk · Message</div>
      </div>

      <div className="auth-form-side">
        <div className="auth-card card" style={{ padding: 32 }}>
          <h1 className="display" style={{ fontSize: 30, margin: "0 0 4px" }}>
            {mode === "login" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="meta" style={{ marginBottom: 24 }}>
            {mode === "login" ? "Log in to your workspace" : "Start collaborating in seconds"}
          </p>

          <form onSubmit={submit} className="stack" style={{ gap: 16 }}>
            {mode === "register" && (
              <div className="field">
                <label className="label">Display name</label>
                <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
              </div>
            )}
            <div className="field">
              <label className="label">Email</label>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label className="label">Password</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                required minLength={mode === "register" ? 8 : undefined} />
            </div>
            {error && <div className="error-text">{error}</div>}
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
            </button>
          </form>

          {providers.length > 0 && (
            <>
              <div className="auth-divider"><span>or</span></div>
              <div className="stack" style={{ gap: 8 }}>
                {providers.map((p) => (
                  <a key={`${p.protocol}:${p.id}`} className="btn btn-secondary" style={{ textAlign: "center" }}
                    href={`${API}${p.startPath}?returnTo=${encodeURIComponent(dest)}`}>
                    Continue with {p.label}
                  </a>
                ))}
              </div>
            </>
          )}

          <div style={{ marginTop: 20, fontSize: 14, color: "var(--ink-muted)" }}>
            {mode === "login" ? "New to Yumi? " : "Already have an account? "}
            <button className="btn-ghost btn btn-sm" style={{ padding: 0 }}
              onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
              {mode === "login" ? "Create one" : "Log in"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
