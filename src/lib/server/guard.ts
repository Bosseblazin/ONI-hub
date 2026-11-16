import { readCookie, SESSION_COOKIE, sameOrigin } from "../auth/auth";
import { backend, type Principal } from "./backend";

export type { Principal };

/**
 * Authenticate a request (local or cloud backend). Every API route except /api/health, /api/auth/* and the
 * HMAC-signed /api/agent/* routes calls this. `write` additionally enforces same-origin (CSRF).
 */
export async function guard(req: Request, opts: { write?: boolean } = {}): Promise<Principal | Response> {
  const b = backend();
  if (await b.setupRequired()) {
    return Response.json(
      { error: "setup_required", message: b.mode === "cloud" ? "Sign-in is not configured: set IC_PASSPHRASE_HASH in the Vercel project." : "Remote access is not set up. Run `npm run setup` on the home PC." },
      { status: 401 },
    );
  }
  const p = await b.session(readCookie(req, SESSION_COOKIE));
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (opts.write && !sameOrigin(req)) return Response.json({ error: "bad_origin" }, { status: 403 });
  return p;
}

export const isResponse = (x: unknown): x is Response => x instanceof Response;

export const noStore = { "Cache-Control": "no-store" };
