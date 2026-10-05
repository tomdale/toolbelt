/**
 * A thread BB's New thread view creates is filed like a New work start: with
 * the Product or feature its banner showed, even when a plain Enter sent no
 * submit data, and journaled as started (SPEC §6).
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld } from "./fake-bb.ts";
import { CorpusStore } from "../../src/server/corpus.ts";
import { openDatabase } from "../../src/server/db.ts";
import { ComposedDrafts, draftText } from "../../src/server/composed-drafts.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;

afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

describe("ComposedDrafts", () => {
  it("hands a reported draft's identity to the dispatch with its text", () => {
    const drafts = new ComposedDrafts();
    drafts.report("d1", "Fix  the parser\n", {
      entityId: "e1",
      provenance: "manual",
    });
    expect(drafts.claim("t1", "Fix the parser")).toEqual({
      identity: { entityId: "e1", provenance: "manual" },
    });
    // Claimed once.
    expect(drafts.claim("t2", "Fix the parser")).toBeUndefined();
  });

  it("files a dispatch that arrives before its draft's report", () => {
    const drafts = new ComposedDrafts();
    expect(drafts.claim("t1", "Write docs")).toBeUndefined();
    expect(drafts.report("d1", "Write docs", null)).toEqual({ threadId: "t1" });
    expect(drafts.report("d1", "Write docs", null)).toBeNull();
  });

  it("forgets an emptied or consumed draft and stops waiting after a while", () => {
    let now = 0;
    const drafts = new ComposedDrafts(() => now);
    drafts.report("d1", "One", null);
    drafts.report("d1", "", null);
    expect(drafts.claim("t1", "One")).toBeUndefined();
    drafts.report("d2", "Two", null);
    drafts.consume("Two");
    expect(drafts.claim("t2", "Two")).toBeUndefined();
    now += 60_000;
    expect(drafts.report("d3", "Two", null)).toBeNull();
  });

  it("normalizes whitespace", () => {
    expect(draftText("  a \n\n b  ")).toBe("a b");
  });
});

describe("message.dispatch for the New thread view", () => {
  async function setup() {
    world = await fakeWorld();
    const w = world;
    const corpus = new CorpusStore(openDatabase(w.bb));
    const feature = corpus.remember("Parser", "Parser feature");
    const hook = w.harness.registrations.hooks["message.dispatch"]!;
    const dispatch = async (threadId: string, text: string) => {
      const thread = w.addThread(threadId, { createdAt: Date.now() });
      const context = makeMessageDispatchHookContext({
        thread,
        input: { text },
        parentThreadId: null,
        origin: "app",
        experimental_submission: null,
      });
      expect(await hook(context)).toEqual({ action: "proceed" });
      return context;
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    const starts = async (threadId: string) => {
      const { entries } = (await w.harness.behavior.callRpc(
        "journal",
        null,
      )) as {
        entries: {
          action: string;
          source: string;
          rationale: string;
          threads: { id: string }[];
        }[];
      };
      return entries.filter((e) => e.threads.some((t) => t.id === threadId));
    };
    return { w, corpus, feature, hook, dispatch, settle, starts };
  }

  it("files a plain Enter with the identity the banner reported", async () => {
    const { w, corpus, feature, dispatch, settle, starts } = await setup();
    await w.harness.behavior.callRpc("draftIdentity", {
      draftKey: "root",
      text: "Fix the parser",
      identity: { entityId: feature.id, proposal: null, provenance: "manual" },
    });
    await dispatch("t-enter", "Fix the parser");
    await settle();
    expect(corpus.assignment("t-enter")).toMatchObject({
      entityId: feature.id,
      provenance: "manual",
    });
    expect(await starts("t-enter")).toEqual([
      expect.objectContaining({
        action: "route",
        source: "user",
        rationale: "Started from New thread",
      }),
    ]);
  });

  it("files a report that arrives after the dispatch", async () => {
    const { w, corpus, feature, dispatch, settle } = await setup();
    await dispatch("t-late", "Fix the parser");
    await settle();
    expect(corpus.assignment("t-late").entityId).toBeNull();
    expect(
      await w.harness.behavior.callRpc("draftIdentity", {
        draftKey: "root",
        text: "Fix the parser",
        identity: {
          entityId: feature.id,
          proposal: null,
          provenance: "manual",
        },
      }),
    ).toEqual({ filed: true });
    expect(corpus.assignment("t-late").entityId).toBe(feature.id);
  });

  it("journals a start once across repeated passes", async () => {
    const { hook, dispatch, settle, starts } = await setup();
    const context = await dispatch("t-repeat", "Something new");
    expect(await hook(context)).toEqual({ action: "proceed" });
    await settle();
    expect(await starts("t-repeat")).toHaveLength(1);
  });

  it("leaves a thread naming an unknown subject for classification", async () => {
    const { w, corpus, dispatch, settle, starts } = await setup();
    await w.harness.behavior.callRpc("draftIdentity", {
      draftKey: "root",
      text: "Stale pick",
      identity: { entityId: "ent_gone", proposal: null, provenance: "manual" },
    });
    await dispatch("t-stale", "Stale pick");
    await settle();
    expect(corpus.assignment("t-stale").entityId).toBeNull();
    expect(await starts("t-stale")).toHaveLength(1);
  });

  it("files and journals nothing for an agent-started thread", async () => {
    const { w, corpus, feature, hook, settle, starts } = await setup();
    await w.harness.behavior.callRpc("draftIdentity", {
      draftKey: "root",
      text: "Delegated",
      identity: { entityId: feature.id, proposal: null, provenance: "manual" },
    });
    const thread = w.addThread("t-agent", { createdAt: Date.now() });
    await hook(
      makeMessageDispatchHookContext({
        thread,
        input: { text: "Delegated" },
        parentThreadId: null,
        origin: "plugin",
        initiator: "agent",
        experimental_submission: null,
      }),
    );
    await settle();
    expect(corpus.assignment("t-agent").entityId).toBeNull();
    expect(await starts("t-agent")).toEqual([]);
  });
});
