import { readCookie, SESSION_COOKIE, sameOrigin } from "../auth/auth";
import { home } from "./singleton";

export interface Principal {
  sessionId: string;
  label: string;
}

/**
 * Authenticate a request. Every API route except /api/health and /api/auth/* calls this.
 * `write` additionally enforces same-origin (CSRF) for state-changing requests.
 */
export function guard(req: Request, opts: { write?: boolean } = {}): Principal | Response {
  const auth = home().auth;
  if (!auth.passphraseSet()) {
    return Response.json({ error: "setup_required", message: "Remote access is not set up. Run `npm run setup` on the home PC." }, { status: 401 });
  }
  const rec = auth.check(readCookie(req, SESSION_COOKIE));
  if (!rec) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (opts.write && !sameOrigin(req)) return Response.json({ error: "bad_origin" }, { status: 403 });
  return { sessionId: rec.id, label: rec.label };
}

export const isResponse = (x: unknown): x is Response => x instanceof Response;
