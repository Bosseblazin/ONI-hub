import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../store/history";

/**
 * Remote-access authentication for the home server.
 *
 * - One commander passphrase (min 12 chars), stored as scrypt(N=2^15) hash + salt. Never stored in plain text.
 * - Sessions: 256-bit random tokens in an HttpOnly, SameSite=Strict cookie; only SHA-256(token) is stored.
 *   30-day sliding expiry; listable and revocable.
 * - Login throttling: per-client exponential back-off plus a global cap, to stop online guessing.
 * - State-changing requests must come from the same origin (CSRF defence in depth; SameSite=Strict too).
 * - Transport privacy comes from Tailscale (WireGuard) and `tailscale serve` HTTPS; see docs/REMOTE_ACCESS.md.
 */

export const SESSION_COOKIE = "ic_session";
const SESSION_TTL_MS = 30 * 86400_000;
const MIN_PASSPHRASE = 12;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

interface PassFile {
  v: 1;
  salt: string;
  hash: string;
  createdAt: number;
}

interface SessionRec {
  id: string; // public id (for listing/revocation)
  tokenHash: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface SessionInfo {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  current: boolean;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class AuthService {
  private dir: string;
  private sessions: SessionRec[];
  private failures = new Map<string, { count: number; lockedUntil: number }>();
  private globalFailures: number[] = [];

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "auth");
    fs.mkdirSync(this.dir, { recursive: true });
    this.sessions = (readJsonFile<SessionRec[]>(path.join(this.dir, "sessions.json")) ?? []).filter((s) => s.expiresAt > Date.now());
  }

  private passFile() {
    return path.join(this.dir, "passphrase.json");
  }

  passphraseSet(): boolean {
    return !!readJsonFile<PassFile>(this.passFile());
  }

  setPassphrase(pass: string): void {
    if (pass.length < MIN_PASSPHRASE) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE} characters.`);
    const salt = randomBytes(16);
    const hash = scryptSync(pass.normalize("NFKC"), salt, 64, SCRYPT);
    writeJsonFileAtomic(this.passFile(), { v: 1, salt: salt.toString("hex"), hash: hash.toString("hex"), createdAt: Date.now() } satisfies PassFile);
    try {
      fs.chmodSync(this.passFile(), 0o600);
    } catch {
      /* best effort on Windows */
    }
    this.revokeAll(); // a new passphrase signs every device out
  }

  private verify(pass: string): boolean {
    const f = readJsonFile<PassFile>(this.passFile());
    if (!f) return false;
    const got = scryptSync(pass.normalize("NFKC"), Buffer.from(f.salt, "hex"), 64, SCRYPT);
    const want = Buffer.from(f.hash, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** Remaining lock time in ms for a client key (0 = may attempt). */
  lockedFor(clientKey: string, now = Date.now()): number {
    const f = this.failures.get(clientKey);
    const local = f ? Math.max(0, f.lockedUntil - now) : 0;
    this.globalFailures = this.globalFailures.filter((t) => now - t < 3600_000);
    const global = this.globalFailures.length >= 50 ? 15 * 60_000 : 0;
    return Math.max(local, global);
  }

  login(pass: string, clientKey: string, label: string, now = Date.now()): { ok: true; token: string; session: SessionInfo } | { ok: false; error: string; retryAfterMs?: number } {
    if (!this.passphraseSet()) return { ok: false, error: "Remote access is not set up. Run `npm run setup` on the home PC." };
    const locked = this.lockedFor(clientKey, now);
    if (locked > 0) return { ok: false, error: "Too many attempts. Try again later.", retryAfterMs: locked };
    if (typeof pass !== "string" || pass.length > 1024 || !this.verify(pass)) {
      const f = this.failures.get(clientKey) ?? { count: 0, lockedUntil: 0 };
      f.count++;
      // 3 free attempts, then 30 s, 1 min, 2 min, ... capped at 1 h.
      if (f.count >= 3) f.lockedUntil = now + Math.min(3600_000, 30_000 * 2 ** (f.count - 3));
      this.failures.set(clientKey, f);
      this.globalFailures.push(now);
      return { ok: false, error: "Incorrect passphrase." };
    }
    this.failures.delete(clientKey);
    const token = randomBytes(32).toString("base64url");
    const rec: SessionRec = { id: randomBytes(6).toString("hex"), tokenHash: sha(token), label: label.slice(0, 80) || "device", createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_TTL_MS };
    this.sessions.push(rec);
    this.persist();
    return { ok: true, token, session: { ...this.info(rec), current: true } };
  }

  /** Validate a session token; slides the expiry. Returns null if invalid. */
  check(token: string | undefined | null, now = Date.now()): SessionRec | null {
    if (!token || token.length > 200) return null;
    const h = sha(token);
    const rec = this.sessions.find((s) => s.tokenHash === h);
    if (!rec || rec.expiresAt <= now) return null;
    if (now - rec.lastSeenAt > 60_000) {
      rec.lastSeenAt = now;
      rec.expiresAt = now + SESSION_TTL_MS;
      this.persist();
    }
    return rec;
  }

  logout(token: string): void {
    const h = sha(token);
    this.sessions = this.sessions.filter((s) => s.tokenHash !== h);
    this.persist();
  }

  revoke(id: string): boolean {
    const n = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.persist();
    return this.sessions.length < n;
  }

  revokeAll(): void {
    this.sessions = [];
    this.persist();
  }

  list(currentId?: string): SessionInfo[] {
    const now = Date.now();
    return this.sessions.filter((s) => s.expiresAt > now).map((s) => ({ ...this.info(s), current: s.id === currentId }));
  }

  count(): number {
    return this.sessions.filter((s) => s.expiresAt > Date.now()).length;
  }

  private info(s: SessionRec): Omit<SessionInfo, "current"> {
    return { id: s.id, label: s.label, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt };
  }

  private persist() {
    writeJsonFileAtomic(path.join(this.dir, "sessions.json"), this.sessions);
    try {
      fs.chmodSync(path.join(this.dir, "sessions.json"), 0o600);
    } catch {
      /* best effort */
    }
  }
}

/* --------------------------------------------------------------- request helpers */

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Key for login throttling: Tailscale identity if present, else forwarded address, else a shared bucket. */
export function clientKey(req: Request): string {
  return (
    req.headers.get("tailscale-user-login") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "direct"
  );
}

export function isHttps(req: Request): boolean {
  return req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
}

export function sessionCookie(token: string, req: Request, maxAgeS = SESSION_TTL_MS / 1000): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${isHttps(req) ? "; Secure" : ""}`;
}

export function clearCookie(req: Request): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? "; Secure" : ""}`;
}

/** Same-origin check for state-changing requests. Browsers always send Origin on POST. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
