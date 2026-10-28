// Formatting helpers for sizes and times.

const units = ["B", "KiB", "MiB", "GiB", "TiB"];

/** Formats a byte count: `512 B`, `1.5 GiB`. */
export function formatBytes(bytes: number): string {
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Formats a time relative to `now`: `just now`, `5 min ago`, `3 h ago`, `2 days ago`. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const s = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}
