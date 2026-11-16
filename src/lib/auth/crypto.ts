import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const MIN_PASSPHRASE = 12;
const N = 1 << 15, R = 8, P = 1;
const MAXMEM = 64 * 1024 * 1024;

export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export const newPublicId = () => randomBytes(6).toString("hex");

/**
 * Encode as `scrypt:N:r:p:saltHex:hashHex` — safe to paste into an env var (IC_PASSPHRASE_HASH on Vercel).
 * `:` rather than `$` so .env loaders that expand `$VARS` can't corrupt it; `$`-separated values still verify.
 */
export function hashPassphrase(pass: string): string {
  if (pass.length < MIN_PASSPHRASE) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  const salt = randomBytes(16);
  const hash = scryptSync(pass.normalize("NFKC"), salt, 64, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt:${N}:${R}:${P}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassphrase(pass: string, encoded: string | undefined | null): boolean {
  if (!encoded || typeof pass !== "string" || pass.length > 1024) return false;
  const parts = encoded.trim().split(/[$:]/);
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  try {
    const want = Buffer.from(hash, "hex");
    const got = scryptSync(pass.normalize("NFKC"), Buffer.from(salt, "hex"), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** Login throttling schedule shared by local and cloud auth: 3 free attempts, then 30 s doubling, max 1 h. */
export function lockoutMs(failures: number): number {
  return failures < 3 ? 0 : Math.min(3600_000, 30_000 * 2 ** (failures - 3));
}
