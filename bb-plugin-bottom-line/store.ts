import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { cardSchema, type Card } from "./contracts";

type State = {
  thread_id: string;
  epoch: number;
  intercepts: number;
  checked_seq: number;
  accepted_turn: string | null;
  card: string | null;
  enrolled: number;
  capped: number;
  correction_token: string | null;
  input_key: string | null;
};

export function createStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE states (
      thread_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0,
      intercepts INTEGER NOT NULL DEFAULT 0, checked_seq INTEGER NOT NULL DEFAULT 0,
      accepted_turn TEXT, card TEXT, enrolled INTEGER NOT NULL DEFAULT 0, capped INTEGER NOT NULL DEFAULT 0, correction_token TEXT, input_key TEXT
    )`,
  ]);
  function get(threadId: string): State {
    db.prepare("INSERT OR IGNORE INTO states (thread_id) VALUES (?)").run(threadId);
    return db.prepare("SELECT * FROM states WHERE thread_id = ?").get(threadId) as State;
  }
  return {
    get,
    enroll(threadId: string, enabled: boolean) {
      get(threadId);
      db.prepare("UPDATE states SET enrolled = ? WHERE thread_id = ?").run(Number(enabled), threadId);
    },
    reset(threadId: string, inputKey: string | null = null) {
      const state = get(threadId);
      if (inputKey !== null && state.input_key === inputKey) return;
      db.prepare("UPDATE states SET epoch = epoch + 1, intercepts = 0, capped = 0, accepted_turn = NULL, card = NULL, correction_token = NULL, input_key = ? WHERE thread_id = ?").run(inputKey, threadId);
    },
    accept(threadId: string, epoch: number, turnId: string, card: Card | null) {
      return db.prepare("UPDATE states SET accepted_turn = ?, card = ?, capped = 0 WHERE thread_id = ? AND epoch = ?")
        .run(turnId, card ? JSON.stringify(card) : null, threadId, epoch).changes === 1;
    },
    check(threadId: string, seq: number) {
      db.prepare("UPDATE states SET checked_seq = ? WHERE thread_id = ?").run(seq, threadId);
    },
    reserve(threadId: string, epoch: number, seq: number, cap: number, token: string) {
      // Persist before dispatch so a reload or duplicate idle event cannot refund a correction.
      return db.prepare("UPDATE states SET intercepts = intercepts + 1, checked_seq = ?, correction_token = ? WHERE thread_id = ? AND epoch = ? AND checked_seq < ? AND intercepts < ? AND enrolled = 1")
        .run(seq, token, threadId, epoch, seq, cap).changes === 1;
    },
    cap(threadId: string, epoch: number, seq: number, limit: number) {
      db.prepare("UPDATE states SET capped = 1, checked_seq = ? WHERE thread_id = ? AND epoch = ? AND intercepts >= ?").run(seq, threadId, epoch, limit);
    },
    card(threadId: string) {
      const raw = get(threadId).card;
      return raw ? cardSchema.parse(JSON.parse(raw)) : null;
    },
    dismiss(threadId: string, cardId: string) {
      const card = this.card(threadId);
      if (!card || card.id !== cardId) throw new Error("This card is no longer current.");
      db.prepare("UPDATE states SET card = NULL WHERE thread_id = ?").run(threadId);
    },
    remove(threadId: string) { db.prepare("DELETE FROM states WHERE thread_id = ?").run(threadId); },
  };
}
