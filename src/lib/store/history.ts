import fs from "node:fs";
import path from "node:path";
import type { HistorySample } from "../model/types";

/**
 * Append-only JSON-lines history, one file per colony (save name) per UTC day:
 *   <dataDir>/history/<colony-slug>/<YYYY-MM-DD>.jsonl
 * Lightweight, human-inspectable, and needs no native modules. Older files are
 * deleted after `retentionDays`.
 */
export class HistoryStore {
  private mem: HistorySample[] = [];
  private colony = "unknown";

  constructor(
    private readonly dataDir: string,
    private readonly retentionDays = 14,
    private readonly memoryLimit = 50_000,
  ) {}

  static slug(name: string | null): string {
    const s = (name ?? "unknown").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return s.slice(0, 80) || "unknown";
  }

  private dir(colony = this.colony): string {
    return path.join(this.dataDir, "history", colony);
  }

  /** Switch to a colony and load its recent history into memory. */
  open(saveName: string | null, lookbackDays = 3): void {
    const slug = HistoryStore.slug(saveName);
    if (slug === this.colony && this.mem.length) return;
    this.colony = slug;
    this.mem = [];
    const dir = this.dir();
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().slice(-lookbackDays);
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const s = JSON.parse(line) as HistorySample;
          if (typeof s.t === "number" && typeof s.c === "number" && typeof s.w === "number") this.mem.push(s);
        } catch {
          /* skip a corrupt line (e.g. a crash mid-write) */
        }
      }
    }
    this.mem.sort((a, b) => a.t - b.t);
    if (this.mem.length > this.memoryLimit) this.mem = this.mem.slice(-this.memoryLimit);
    this.prune();
  }

  /**
   * Cycles going backwards means the player reloaded an earlier save of the same colony.
   * Drop in-memory samples from the "future" so trends aren't computed across timelines.
   */
  rewindTo(cycles: number): void {
    this.mem = this.mem.filter((s) => s.c <= cycles);
  }

  append(samples: HistorySample[]): void {
    if (!samples.length) return;
    this.mem.push(...samples);
    if (this.mem.length > this.memoryLimit) this.mem.splice(0, this.mem.length - this.memoryLimit);
    try {
      fs.mkdirSync(this.dir(), { recursive: true });
      const day = new Date(samples[0]!.t).toISOString().slice(0, 10);
      fs.appendFileSync(path.join(this.dir(), `${day}.jsonl`), samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
    } catch {
      /* disk issues must not stop live monitoring; memory copy is kept */
    }
  }

  all(): readonly HistorySample[] {
    return this.mem;
  }

  forWorld(worldId: number, sinceCycles?: number): HistorySample[] {
    return this.mem.filter((s) => s.w === worldId && (sinceCycles === undefined || s.c >= sinceCycles));
  }

  private prune(): void {
    const cutoff = new Date(Date.now() - this.retentionDays * 86400_000).toISOString().slice(0, 10);
    const root = path.join(this.dataDir, "history");
    if (!fs.existsSync(root)) return;
    for (const colony of fs.readdirSync(root)) {
      const d = path.join(root, colony);
      try {
        for (const f of fs.readdirSync(d)) if (f.endsWith(".jsonl") && f.slice(0, 10) < cutoff) fs.unlinkSync(path.join(d, f));
      } catch {
        /* ignore */
      }
    }
  }
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonFileAtomic(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch {
    /* non-fatal */
  }
}
