/**
 * Database access for the cloud relay. Two implementations behind one interface:
 *  - Neon serverless (HTTPS) in production on Vercel — DATABASE_URL, injected by the Vercel ⇄ Neon integration.
 *  - PGlite (embedded Postgres, WASM) for local development and tests — IC_CLOUD_DB=pglite:<dir|memory>.
 * Every relay operation is written as a single SQL statement, so no interactive transactions are needed
 * over the stateless HTTP driver.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ic_meta (key text PRIMARY KEY, value jsonb NOT NULL, updated_at double precision NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ic_commands (
     client_id text PRIMARY KEY, type text NOT NULL, payload jsonb NOT NULL, issued_by text NOT NULL,
     client_created_at double precision, queued_at double precision NOT NULL, delivered_at double precision, delivery_count int NOT NULL DEFAULT 0,
     home_status text, home_seq int, result text, error text, processed_at double precision, updated_at double precision NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ic_commands_open ON ic_commands (queued_at) WHERE home_status IS NULL`,
  `CREATE TABLE IF NOT EXISTS ic_sessions (id text PRIMARY KEY, token_hash text UNIQUE NOT NULL, label text NOT NULL,
     created_at double precision NOT NULL, last_seen_at double precision NOT NULL, expires_at double precision NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ic_login_failures (client_key text PRIMARY KEY, count int NOT NULL, locked_until double precision NOT NULL, updated_at double precision NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ic_history (colony text NOT NULL, w int NOT NULL, t double precision NOT NULL, c double precision NOT NULL, row jsonb NOT NULL, PRIMARY KEY (colony, w, t))`,
  `CREATE TABLE IF NOT EXISTS ic_audit (seq serial PRIMARY KEY, at double precision NOT NULL, actor text NOT NULL, event text NOT NULL, detail jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ic_screenshot (id int PRIMARY KEY, at double precision NOT NULL, mime text NOT NULL, data_b64 text NOT NULL)`,
];

class NeonDb implements Db {
  private sql: { query: (t: string, p?: unknown[]) => Promise<unknown> } | null = null;
  constructor(private url: string) {}
  async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
    if (!this.sql) {
      const { neon } = await import("@neondatabase/serverless");
      this.sql = neon(this.url) as unknown as { query: (t: string, p?: unknown[]) => Promise<unknown> };
    }
    return (await this.sql.query(text, params)) as T[];
  }
}

class PgliteDb implements Db {
  private db: Promise<{ query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }>;
  constructor(dir: string) {
    // Imported lazily so the WASM bundle never ships to Vercel functions.
    const mod = "@electric-sql/pglite";
    this.db = import(/* webpackIgnore: true */ mod).then(({ PGlite }) => new PGlite(dir === "memory" ? undefined : dir));
  }
  async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await (await this.db).query(text, params)).rows as T[];
  }
}

/** Create a Db from a spec: a postgres URL, or `pglite:<dir>` / `pglite:memory`. */
export function createDb(spec: string): Db {
  if (spec.startsWith("pglite:")) return new PgliteDb(spec.slice("pglite:".length));
  return new NeonDb(spec);
}

const migrated = new WeakMap<Db, Promise<void>>();
export function migrate(db: Db): Promise<void> {
  let p = migrated.get(db);
  if (!p) {
    p = (async () => {
      for (const s of SCHEMA) await db.query(s);
    })();
    migrated.set(db, p);
    p.catch(() => migrated.delete(db));
  }
  return p;
}
