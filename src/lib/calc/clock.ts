/**
 * OniMcp only exposes the integer cycle (GameUtil.GetCurrentCycle) plus the
 * current time scale. Rates must be computed in *game* time, otherwise pausing
 * the game would look like everything stopped changing, and 3x speed would
 * triple apparent consumption. We estimate fractional game time by integrating
 * wall time x timeScale between polls, clamped to the reported cycle.
 *
 * ONI: one cycle = 600 game seconds; timeScale 0 = paused, 1/2/3 = speeds.
 */
export const SECONDS_PER_CYCLE = 600;

export interface ClockSample {
  cycle: number;
  speed: number;
  paused: boolean;
  wallMs: number;
}

export class GameClock {
  private est: number | null = null; // fractional cycles, 1-based like `cycle`
  private lastWall: number | null = null;
  private lastSpeed = 0;
  private lastCycle: number | null = null;

  constructor(private readonly maxGapMs = 60_000) {}

  /** Returns the estimated fractional cycle count and whether a discontinuity was detected. */
  update(s: ClockSample): { estCycles: number; discontinuity: boolean } {
    let discontinuity = false;
    if (this.est === null || this.lastCycle === null || this.lastWall === null) {
      this.est = s.cycle; // start of the reported cycle (conservative)
    } else if (s.cycle < this.lastCycle) {
      // Cycle went backwards: different save loaded or a reload.
      discontinuity = true;
      this.est = s.cycle;
    } else {
      const dt = s.wallMs - this.lastWall;
      if (dt > 0 && dt <= this.maxGapMs) {
        this.est += (dt / 1000) * this.lastSpeed / SECONDS_PER_CYCLE;
      } else if (dt > this.maxGapMs) {
        discontinuity = true;
      }
      // Clamp into [cycle, cycle + 1)
      if (this.est < s.cycle) this.est = s.cycle;
      if (this.est >= s.cycle + 1) this.est = s.cycle + 0.999;
    }
    this.lastWall = s.wallMs;
    this.lastSpeed = s.paused ? 0 : Math.max(0, s.speed);
    this.lastCycle = s.cycle;
    return { estCycles: this.est, discontinuity };
  }

  reset(): void {
    this.est = null;
    this.lastWall = null;
    this.lastCycle = null;
    this.lastSpeed = 0;
  }
}
