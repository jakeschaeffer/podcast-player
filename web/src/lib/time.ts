// Every readout is whole seconds: the owner never wants decimals (6:57, not 6:57.4).

/** 7:04 or 1:02:33 */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** 60 s, 2:05 */
export function spanLength(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 100 ? `${s} s` : clock(ms);
}

/** 14 min, 1 h 6 min */
export function minutes(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

/** 4:04 left */
export function timeLeft(positionMs: number, durationMs: number): string {
  return `${clock(Math.max(0, durationMs - positionMs))} left`;
}

const DAY = 86_400_000;

/** Today, Yesterday, Mon, Oct 15, or Oct 15, 2025 */
export function relativeDay(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return "";
  const d = new Date(ts);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const diff = startOfToday.getTime() - new Date(d).setHours(0, 0, 0, 0);
  if (diff < DAY && diff > -DAY) return "Today";
  if (diff < 2 * DAY && diff > 0) return "Yesterday";
  if (diff < 7 * DAY && diff > 0) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (d.getFullYear() === new Date(now).getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Wednesday, October 21 */
export function longDate(now: number = Date.now()): string {
  return new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

/** 4h ago, 3 min ago, just now */
export function ago(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return "never";
  const m = Math.round((now - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
