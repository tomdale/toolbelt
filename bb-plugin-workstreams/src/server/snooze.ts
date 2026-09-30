/**
 * Thread snoozes (see domain/snooze.ts), shared by every client. Kept as one
 * `ws_meta` value, like the manual order: there are at most a few dozen, and
 * every read wants all of them.
 */
import {
  isSnoozed,
  parseSnoozePrefs,
  type SnoozePrefs,
  type ThreadSnooze,
} from "../domain/snooze.ts";
import { getMeta, setMeta, type Database } from "./db.ts";

const KEY = "thread-snoozes";
const PREFS_KEY = "snooze-prefs";

export function loadSnoozePrefs(db: Database): SnoozePrefs {
  try {
    return parseSnoozePrefs(JSON.parse(getMeta(db, PREFS_KEY) ?? "null"));
  } catch {
    return parseSnoozePrefs(null);
  }
}

/** Merges `patch` into the stored preferences, dropping invalid values. */
export function saveSnoozePrefs(
  db: Database,
  patch: Partial<SnoozePrefs>,
): SnoozePrefs {
  const saved = parseSnoozePrefs({ ...loadSnoozePrefs(db), ...patch });
  setMeta(db, PREFS_KEY, JSON.stringify(saved));
  return saved;
}

export type StoredSnoozes = Record<string, ThreadSnooze>;

const isSnooze = (value: unknown): value is ThreadSnooze => {
  const v = value as Partial<ThreadSnooze> | null;
  return (
    !!v &&
    (v.until === null || typeof v.until === "number") &&
    typeof v.attentionAt === "number" &&
    typeof v.at === "number"
  );
};

export class ThreadSnoozes {
  constructor(private readonly db: Database) {}

  all(): StoredSnoozes {
    try {
      const parsed = JSON.parse(getMeta(this.db, KEY) ?? "{}") as Record<
        string,
        unknown
      >;
      return Object.fromEntries(
        Object.entries(parsed ?? {}).filter(([, v]) => isSnooze(v)),
      ) as StoredSnoozes;
    } catch {
      return {};
    }
  }

  get(threadId: string): ThreadSnooze | undefined {
    return this.all()[threadId];
  }

  set(threadId: string, snooze: ThreadSnooze): ThreadSnooze {
    this.save({ ...this.all(), [threadId]: snooze });
    return snooze;
  }

  /** Ends a thread's snooze; returns whether it had one. */
  clear(threadId: string): boolean {
    const all = this.all();
    if (!(threadId in all)) return false;
    delete all[threadId];
    this.save(all);
    return true;
  }

  /**
   * Drops snoozes that ended: past their wake time, woken by activity, or on a
   * thread that is no longer active (archived, hidden, deleted). Returns the
   * threads whose wake time came, which the caller marks unread so they
   * stand out when they return.
   */
  sweep(
    threads: readonly { id: string; latestAttentionAt: number }[],
    now: number,
  ): { ended: string[]; timed: string[] } {
    const all = this.all();
    const live = new Map(threads.map((t) => [t.id, t]));
    const ended: string[] = [];
    const timed: string[] = [];
    for (const [threadId, snooze] of Object.entries(all)) {
      const thread = live.get(threadId);
      if (thread && isSnoozed(snooze, thread, now)) continue;
      ended.push(threadId);
      if (thread && snooze.until !== null) timed.push(threadId);
      delete all[threadId];
    }
    if (ended.length) this.save(all);
    return { ended, timed };
  }

  private save(all: StoredSnoozes): void {
    setMeta(this.db, KEY, JSON.stringify(all));
  }
}
