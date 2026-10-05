/**
 * Pairs a thread BB's native New thread view just created with the Product or
 * feature its Workstreams banner showed for that draft.
 *
 * The banner can attach the choice as submit data only when it sees the
 * submit: BB's Enter key calls the composer's submit directly and fires no
 * form event a plugin could intercept, and the composer has no hook that adds
 * data to every submit (docs/bb-sdk-wishlist.md). So the banner reports its
 * draft's text and identity as they change, and the dispatch hook matches a
 * fresh first message against them by text. Either side can arrive first: a
 * dispatch with no matching draft waits briefly for a late report.
 */
import type { DraftSubjectProposal } from "../domain/corpus.ts";

export type ComposedIdentity = {
  entityId?: string | null;
  proposal?: DraftSubjectProposal | null;
  provenance?: "manual" | "automatic";
} | null;

type Draft = { text: string; identity: ComposedIdentity; at: number };
type Waiting = { threadId: string; text: string; at: number };

/** How long a reported draft stays claimable after its last change. */
const DRAFT_TTL_MS = 60 * 60_000;
/** How long a dispatch waits for its draft's report to arrive. */
const WAIT_MS = 10_000;
const MAX_DRAFTS = 50;
const MAX_WAITING = 20;

/** Whitespace-insensitive, as BB trims the text it sends. */
export function draftText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export class ComposedDrafts {
  private drafts = new Map<string, Draft>();
  private waiting: Waiting[] = [];

  constructor(private now: () => number = Date.now) {}

  /**
   * Records the identity a banner shows for draft `key`; empty text forgets
   * the draft. Returns the thread a dispatch already started from this text,
   * which the caller files with `identity`, or null.
   */
  report(
    key: string,
    text: string,
    identity: ComposedIdentity,
  ): { threadId: string } | null {
    this.prune();
    const normalized = draftText(text);
    if (!normalized) {
      this.drafts.delete(key);
      return null;
    }
    const index = this.waiting.findIndex((w) => w.text === normalized);
    if (index >= 0) {
      const [match] = this.waiting.splice(index, 1);
      this.drafts.delete(key);
      return { threadId: match!.threadId };
    }
    this.drafts.delete(key);
    this.drafts.set(key, { text: normalized, identity, at: this.now() });
    while (this.drafts.size > MAX_DRAFTS)
      this.drafts.delete(this.drafts.keys().next().value!);
    return null;
  }

  /**
   * Claims the newest reported draft whose text is `text`, for thread
   * `threadId`. With none, the thread waits for a matching `report` and this
   * returns undefined; a draft's own identity may be null (nothing to file).
   */
  claim(
    threadId: string,
    text: string,
  ): { identity: ComposedIdentity } | undefined {
    this.prune();
    const normalized = draftText(text);
    if (!normalized) return undefined;
    let found: [string, Draft] | null = null;
    for (const entry of this.drafts)
      if (
        entry[1].text === normalized &&
        (!found || entry[1].at >= found[1].at)
      )
        found = entry;
    if (found) {
      this.drafts.delete(found[0]);
      return { identity: found[1].identity };
    }
    this.waiting = this.waiting.filter((w) => w.threadId !== threadId);
    this.waiting.push({ threadId, text: normalized, at: this.now() });
    if (this.waiting.length > MAX_WAITING) this.waiting.shift();
    return undefined;
  }

  /** Drops a draft whose text was just submitted with its own data. */
  consume(text: string): void {
    const normalized = draftText(text);
    for (const [key, draft] of this.drafts)
      if (draft.text === normalized) this.drafts.delete(key);
  }

  private prune() {
    const now = this.now();
    for (const [key, draft] of this.drafts)
      if (now - draft.at > DRAFT_TTL_MS) this.drafts.delete(key);
    this.waiting = this.waiting.filter((w) => now - w.at <= WAIT_MS);
  }
}
