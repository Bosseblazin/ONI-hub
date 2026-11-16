"use client";
import { useEffect, useState } from "react";

export default function LoginPage() {
  const [pass, setPass] = useState("");
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  useEffect(() => {
    setLabel(/iphone|android|mobile/i.test(navigator.userAgent) ? "Phone" : "Browser");
    void fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((s: { authenticated: boolean; setupRequired: boolean }) => {
        if (s.authenticated) window.location.href = "/";
        setSetup(s.setupRequired);
      })
      .catch(() => setErr("Cannot reach the home PC."));
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: pass, label }) });
      const b = (await r.json()) as { error?: string; retryAfterMs?: number };
      if (!r.ok) {
        setErr(b.retryAfterMs ? `${b.error} (${Math.ceil(b.retryAfterMs / 1000)} s)` : b.error ?? "Sign-in failed");
        return;
      }
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    } catch {
      setErr("Cannot reach the home PC.");
    } finally {
      setBusy(false);
      setPass("");
    }
  };
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="panel w-full max-w-sm space-y-4 p-6">
        <div>
          <h1 className="text-lg font-bold tracking-[0.25em]">INTERPLANETARY COMMAND</h1>
          <p className="text-[10px] tracking-[0.25em] text-muted">COMMANDER AUTHENTICATION</p>
        </div>
        {setup ? (
          <p className="text-sm text-warn">Remote access is not set up yet. On the home PC run <code className="num">npm run setup</code> to choose a commander passphrase.</p>
        ) : (
          <>
            <label className="block text-xs text-ink2">
              Passphrase
              <input type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus required className="mt-1 w-full rounded border border-line bg-panel2 px-3 py-2.5 text-base text-ink focus:border-accent focus:outline-none" />
            </label>
            <label className="block text-xs text-ink2">
              Device name
              <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} className="mt-1 w-full rounded border border-line bg-panel2 px-3 py-2 text-base text-ink" />
            </label>
            <button disabled={busy || !pass} className="w-full rounded bg-accent py-2.5 text-sm font-bold tracking-wider text-[#06121f] disabled:opacity-50">{busy ? "VERIFYING…" : "SIGN IN"}</button>
          </>
        )}
        {err && <p role="alert" className="text-sm text-crit">{err}</p>}
        <p className="text-[10px] text-muted">Signed-in devices stay signed in for 30 days of inactivity and can be revoked from Home PC &amp; Settings.</p>
      </form>
    </main>
  );
}
