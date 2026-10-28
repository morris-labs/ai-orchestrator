// Small chart helpers: linear scales and clean ticks, so the charts need no
// charting library.

export type Scale = ((v: number) => number) & { domain: [number, number]; range: [number, number] };

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const f = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Scale;
  f.domain = domain;
  f.range = range;
  return f;
}

/** About `count` round tick values covering `[min, max]`. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (max <= min) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks;
}

/** Index of the point whose x is closest to `x`. */
export function nearestIndex(xs: readonly number[], x: number): number {
  let best = 0;
  for (let i = 1; i < xs.length; i += 1) {
    if (Math.abs(xs[i]! - x) < Math.abs(xs[best]! - x)) best = i;
  }
  return best;
}
