const DAY_MS = 24 * 60 * 60 * 1000;

export interface Period {
  since: string;
  until: string;
}

/** UTC calendar date `n` days before `now` as YYYY-MM-DD (1 = yesterday). */
export function daysAgo(n: number, now = new Date()): string {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayMs - n * DAY_MS).toISOString().slice(0, 10);
}

/** Every YYYY-MM-DD date from `since` to `until`, inclusive. */
export function datesBetween({ since, until }: Period): string[] {
  const dates: string[] = [];
  for (let ms = Date.parse(since); ms <= Date.parse(until); ms += DAY_MS) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}
