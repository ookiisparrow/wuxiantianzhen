/**
 * China Standard Time (UTC+8) business calendar helpers.
 * All timestamps in DB are UTC ms; business dates & week keys use CST.
 */
export const CST_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

export function toCstDate(utcMs: number): Date {
  return new Date(utcMs + CST_OFFSET_MS);
}

export function formatCstYmd(utcMs: number): string {
  const d = toCstDate(utcMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatCstCompactYmd(utcMs: number): string {
  return formatCstYmd(utcMs).replace(/-/g, "");
}

/** ISO week key in CST, e.g. "2026W48" */
export function formatCstWeekKey(utcMs: number): string {
  const d = toCstDate(utcMs);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${target.getUTCFullYear()}W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Computes deadline after adding `awakeHours`, skipping CST overnight sleep window [00:00, 08:00).
 * Used by docs/07 §5.2 stall guard (6h no-reply timeout excluding overnight sleep).
 */
export function addAwakeHoursCst(startUtcMs: number, awakeHours: number): number {
  let remainingMs = awakeHours * HOUR_MS;
  let cursor = startUtcMs;

  while (remainingMs > 0) {
    const cst = toCstDate(cursor);
    const h = cst.getUTCHours();
    if (h < 8) {
      // Advance directly to 08:00 CST of the same CST day
      const wakeCstMs = Date.UTC(cst.getUTCFullYear(), cst.getUTCMonth(), cst.getUTCDate(), 8, 0, 0, 0);
      cursor = wakeCstMs - CST_OFFSET_MS;
      continue;
    }
    // End of awake window is 24:00 CST (next day 00:00 CST)
    const midnightCstMs = Date.UTC(cst.getUTCFullYear(), cst.getUTCMonth(), cst.getUTCDate() + 1, 0, 0, 0, 0);
    const msUntilSleep = midnightCstMs - CST_OFFSET_MS - cursor;
    if (remainingMs <= msUntilSleep) {
      cursor += remainingMs;
      remainingMs = 0;
    } else {
      remainingMs -= msUntilSleep;
      cursor = midnightCstMs - CST_OFFSET_MS;
    }
  }
  return cursor;
}
