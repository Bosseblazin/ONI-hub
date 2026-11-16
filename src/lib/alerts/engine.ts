import type { AlertCandidate, AlertRecord, Severity } from "../model/types";
import type { Rule, RuleContext } from "./rules";
import { ALL_RULES } from "./rules";

const RANK: Record<Severity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
const RESOLVED_RETENTION_MS = 24 * 3600_000;
const MAX_INFO = 50;

interface Counter {
  hits: number;
  misses: number;
}

export interface AlertEngineState {
  records: AlertRecord[];
  counters: Record<string, Counter>;
}

/**
 * Stateful alert evaluator with hysteresis:
 *  - A condition must hold for `persistEvaluations` consecutive evaluations before it raises.
 *  - An active alert resolves after `clearEvaluations` consecutive clear evaluations.
 *  - Scopes a rule could not evaluate (stale/missing data) are left untouched: missing data never
 *    resolves an alert and never raises one.
 *  - Dismissed alerts stay hidden until they resolve or escalate in severity.
 */
export class AlertEngine {
  private records = new Map<string, AlertRecord>();
  private counters = new Map<string, Counter>();

  constructor(private readonly rules: Rule[] = ALL_RULES, state?: AlertEngineState) {
    if (state) {
      for (const r of state.records) this.records.set(r.id, r);
      for (const [k, v] of Object.entries(state.counters)) this.counters.set(k, v);
    }
  }

  evaluate(ctx: RuleContext): AlertRecord[] {
    const now = ctx.now;
    for (const rule of this.rules) {
      let results;
      try {
        results = rule(ctx);
      } catch {
        continue; // a broken rule must never take the dashboard down
      }
      for (const { scope, candidate } of results) {
        if (candidate?.oneShot) {
          if (!this.records.has(candidate.id)) this.records.set(candidate.id, this.newRecord(candidate, now));
          continue;
        }
        const c = this.counters.get(scope) ?? { hits: 0, misses: 0 };
        const rec = this.records.get(scope);
        if (candidate) {
          c.hits++;
          c.misses = 0;
          if (rec && rec.status === "active") {
            const escalated = RANK[candidate.severity] > RANK[rec.severity];
            Object.assign(rec, candidate, { lastSeen: now });
            if (escalated) {
              rec.dismissed = false;
              rec.acknowledged = false;
            }
          } else if (c.hits >= ctx.th.persistEvaluations) {
            this.records.set(scope, this.newRecord(candidate, now));
          }
        } else {
          c.hits = 0;
          c.misses++;
          if (rec && rec.status === "active" && c.misses >= ctx.th.clearEvaluations) {
            rec.status = "resolved";
            rec.resolvedAt = now;
          }
        }
        this.counters.set(scope, c);
      }
    }
    this.prune(now);
    return this.list();
  }

  private newRecord(c: AlertCandidate, now: number): AlertRecord {
    return { ...c, status: "active", firstSeen: now, lastSeen: now, resolvedAt: null, acknowledged: false, dismissed: false };
  }

  private prune(now: number) {
    for (const [id, r] of this.records) {
      if (r.status === "resolved" && r.resolvedAt !== null && now - r.resolvedAt > RESOLVED_RETENTION_MS) this.records.delete(id);
    }
    const infos = [...this.records.values()].filter((r) => r.oneShot).sort((a, b) => b.firstSeen - a.firstSeen);
    for (const r of infos.slice(MAX_INFO)) this.records.delete(r.id);
  }

  acknowledge(id: string): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    r.acknowledged = true;
    return true;
  }

  dismiss(id: string): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    r.dismissed = true;
    r.acknowledged = true;
    // Informational events are cleared once dismissed.
    if (r.oneShot) {
      r.status = "resolved";
      r.resolvedAt = Date.now();
    }
    return true;
  }

  list(): AlertRecord[] {
    return [...this.records.values()].sort(
      (a, b) =>
        (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) ||
        RANK[b.severity] - RANK[a.severity] ||
        b.lastSeen - a.lastSeen,
    );
  }

  /** Clear everything (e.g. a different save was loaded). */
  resetForNewColony(): void {
    this.records.clear();
    this.counters.clear();
  }

  toState(): AlertEngineState {
    return { records: this.list(), counters: Object.fromEntries(this.counters) };
  }
}
