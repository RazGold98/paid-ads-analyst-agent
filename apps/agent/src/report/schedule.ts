import type { Collection, Db } from "mongodb";

/** The team's local date and time, e.g. { date: "2026-10-20", time: "08:00" } in Asia/Jerusalem. */
export function localClock(now: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** True once the local time has reached reportTime ("08:00"). "HH:MM" strings compare correctly as text. */
export function isDue(now: Date, reportTime: string, timeZone: string): { due: boolean; date: string } {
  const { date, time } = localClock(now, timeZone);
  return { due: time >= reportTime, date };
}

/** Remembers which days' reports were sent, so a restart or deploy never sends one twice. */
export interface RunStore {
  /** Marks the day as sent. Returns false if it was already marked. */
  claim(date: string): Promise<boolean>;
  /** Undoes a claim after a failed send, so the next check retries. */
  release(date: string): Promise<void>;
}

export class MongoRunStore implements RunStore {
  private readonly runs: Collection<{ _id: string; at: Date }>;

  constructor(db: Db) {
    this.runs = db.collection<{ _id: string; at: Date }>("scheduled_runs");
  }

  // One unique id per day: a second insert fails with 11000 (duplicate key), so only one send wins.
  async claim(date: string): Promise<boolean> {
    try {
      await this.runs.insertOne({ _id: `daily-report:${date}`, at: new Date() });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return false;
      throw err;
    }
  }

  async release(date: string): Promise<void> {
    await this.runs.deleteOne({ _id: `daily-report:${date}` });
  }
}

const CHECK_EVERY_MS = 60_000;

/**
 * Checks every minute instead of setting one long timer: a timer is lost on every restart,
 * while this catches up after a deploy or an outage at report time. Returns a stop function.
 */
export function startDailyReport(opts: {
  time: string;
  timeZone: string;
  runs: RunStore;
  send: (date: string) => Promise<void>;
  onError: (err: unknown) => void;
  now?: () => Date;
}): () => void {
  const check = async () => {
    const { due, date } = isDue(opts.now?.() ?? new Date(), opts.time, opts.timeZone);
    if (!due || !(await opts.runs.claim(date))) return;
    try {
      await opts.send(date);
    } catch (err) {
      await opts.runs.release(date);
      throw err;
    }
  };
  const tick = () => void check().catch(opts.onError);

  tick(); // also check right away, so a deploy after report time still sends today's report
  const timer = setInterval(tick, CHECK_EVERY_MS);
  return () => clearInterval(timer);
}
