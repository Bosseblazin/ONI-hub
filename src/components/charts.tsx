"use client";
import { useMemo, useRef, useState } from "react";

export interface Series {
  key: string;
  label: string;
  color: string;
  points: { x: number; y: number }[];
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const d = Math.abs(min) || 1;
    min -= d * 0.1;
    max += d * 0.1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** Place series end labels in the right gutter, nudged apart so they never overlap (min 12px). */
function endLabels(series: Series[], sy: (y: number) => number, top: number, bottom: number) {
  const ls = series
    .filter((s) => s.points.length)
    .map((s) => ({ key: s.key, label: s.label, y: sy(s.points[s.points.length - 1]!.y) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ls.length; i++) if (ls[i]!.y - ls[i - 1]!.y < 12) ls[i]!.y = ls[i - 1]!.y + 12;
  const over = ls.length ? ls[ls.length - 1]!.y - bottom : 0;
  if (over > 0) for (const l of ls) l.y -= over;
  for (const l of ls) l.y = Math.max(top, l.y);
  return ls;
}

/** Tiny trend line for cards. Not interactive beyond a native title. */
export function Sparkline({ points, color, width = 120, height = 28, label }: { points: { x: number; y: number }[]; color: string; width?: number; height?: number; label: string }) {
  if (points.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label={`${label}: not enough history`}>
        <line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke="var(--grid)" strokeDasharray="2 3" />
      </svg>
    );
  }
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = (x: number) => (x1 === x0 ? width : ((x - x0) / (x1 - x0)) * (width - 4) + 2);
  const sy = (y: number) => (y1 === y0 ? height / 2 : height - 3 - ((y - y0) / (y1 - y0)) * (height - 6));
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
  const last = points[points.length - 1]!;
  return (
    <svg width={width} height={height} role="img" aria-label={`${label} trend`}>
      <title>{`${label}: ${points.length} samples over ${(x1 - x0).toFixed(2)} cycles`}</title>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={sx(last.x)} cy={sy(last.y)} r={2.5} fill={color} />
    </svg>
  );
}

/**
 * Line chart over game cycles. One y-axis only; all series share a unit.
 * Crosshair + tooltip on hover; legend above; series end-labelled when ≤ 3.
 */
export function LineChart({
  series,
  height = 200,
  format,
  yMin,
  title,
  unitLabel,
}: {
  series: Series[];
  height?: number;
  format: (v: number) => string;
  yMin?: number;
  title: string;
  unitLabel?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, padL = 74, padR = 96, padT = 10, padB = 24;
  const sorted = useMemo(() => series.map((s) => ({ ...s, points: [...s.points].sort((a, b) => a.x - b.x) })), [series]);
  series = sorted;
  const all = useMemo(() => series.flatMap((s) => s.points), [series]);
  const has = all.length >= 2;

  const g = useMemo(() => {
    if (!has) return null;
    const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...ys, yMin ?? Infinity), y1 = Math.max(...ys);
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    const yt = niceTicks(y0, y1);
    y0 = Math.min(y0, yt[0] ?? y0);
    y1 = Math.max(y1, yt[yt.length - 1] ?? y1);
    const sx = (x: number) => padL + (x1 === x0 ? 0 : ((x - x0) / (x1 - x0)) * (W - padL - padR));
    const sy = (y: number) => padT + (1 - (y - y0) / (y1 - y0)) * (H - padT - padB);
    const xt = niceTicks(x0, x1, 5).filter((t) => t >= x0 && t <= x1);
    return { x0, x1, y0, y1, yt, xt, sx, sy };
  }, [all, has, yMin, H]);

  if (!has || !g) {
    return (
      <figure className="w-full">
        <figcaption className="panel-title mb-2">{title}</figcaption>
        <div className="flex h-24 items-center justify-center rounded border border-dashed border-line text-xs text-muted">
          Not enough history yet — samples are recorded every 30 s while the game is unpaused.
        </div>
      </figure>
    );
  }

  const onMove = (e: React.MouseEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const x = ((e.clientX - r.left) / r.width) * W;
    const c = g.x0 + ((x - padL) / (W - padL - padR)) * (g.x1 - g.x0);
    setHover(Math.min(g.x1, Math.max(g.x0, c)));
  };
  const nearest = (s: Series, x: number) => s.points.reduce((b, p) => (Math.abs(p.x - x) < Math.abs(b.x - x) ? p : b), s.points[0]!);
  const hx = hover !== null ? g.sx(hover) : null;

  return (
    <figure className="w-full">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <figcaption className="panel-title">{title}</figcaption>
        {series.length > 1 && (
          <ul className="flex flex-wrap gap-3 text-[11px] text-ink2">
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className="inline-block h-[2px] w-3 rounded" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="relative">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={title}>
          {g.yt.filter((t, i, arr) => i === 0 || format(t) !== format(arr[i - 1]!)).map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={g.sy(t)} y2={g.sy(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={padL - 6} y={g.sy(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)" className="num">{format(t)}</text>
            </g>
          ))}
          <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke="var(--axis)" />
          {g.xt.map((t) => (
            <text key={t} x={g.sx(t)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--muted)" className="num">C{t % 1 === 0 ? t : t.toFixed(1)}</text>
          ))}
          {unitLabel && <text x={4} y={padT + 8} fontSize={9} fill="var(--muted)">{unitLabel}</text>}
          {series.map((s) => {
            if (s.points.length < 1) return null;
            const d = s.points.map((p, i) => `${i ? "L" : "M"}${g.sx(p.x).toFixed(1)},${g.sy(p.y).toFixed(1)}`).join("");
            return <path key={s.key} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />;
          })}
          {series.length <= 3 &&
            endLabels(series, g.sy, padT + 4, H - padB).map((l) => (
              <text key={l.key} x={W - padR + 6} y={l.y + 3.5} fontSize={10} fill="var(--ink-2)">{l.label}</text>
            ))}
          {hx !== null && (
            <g pointerEvents="none">
              <line x1={hx} x2={hx} y1={padT} y2={H - padB} stroke="var(--ink-2)" strokeWidth={1} strokeDasharray="3 3" />
              {series.map((s) => {
                const p = nearest(s, hover!);
                return <circle key={s.key} cx={g.sx(p.x)} cy={g.sy(p.y)} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />;
              })}
            </g>
          )}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-1 z-10 rounded border border-line bg-panel2 px-2 py-1.5 text-[11px] shadow-lg"
            style={{ left: `${((hx! / W) * 100).toFixed(1)}%`, transform: hx! > W * 0.6 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
          >
            <div className="num mb-1 text-muted">Cycle {hover.toFixed(2)}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-2 whitespace-nowrap">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                <span className="text-ink2">{s.label}</span>
                <span className="num ml-auto pl-2 text-ink">{format(nearest(s, hover).y)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
