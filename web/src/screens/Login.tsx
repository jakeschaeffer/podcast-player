import { useState, type FormEvent } from "react";
import { api, describeError, unwrap } from "../api/client";
import { session } from "../auth/session";

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser";
  return `${device} web`;
}

export function Login() {
  const [name, setName] = useState(defaultDeviceName);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // set_cookie: the token travels in an HttpOnly cookie from here on; the response copy is not kept.
      const r = await unwrap(api.POST("/v1/devices", { body: { name: name.trim() || "Web", platform: "web", password, set_cookie: true } }));
      session.set({ deviceId: r.device.id, deviceName: r.device.name, since: Date.now() });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h1>Podcasts</h1>
        <p>Sign in with the owner password. This browser becomes a device you can revoke later.</p>
      </div>
      <form onSubmit={submit}>
        <label className="field">
          <span>Device name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} />
        </label>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
        </label>
        {error && <p className="error" role="alert">{error === "wrong password" ? "Wrong password" : error}</p>}
        <button className="btn btn--accent btn--block" type="submit" disabled={busy || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
