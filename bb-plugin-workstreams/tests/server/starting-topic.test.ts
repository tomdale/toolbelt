/**
 * How a new root gets its first topic and title (SPEC §6): the topic you
 * picked in the composer, the topic of the workstream whose ＋ opened it, the
 * topic of the thread it was started from, or Quick analysis of its first
 * request, reusing the composer's own preview when the text matches.
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld } from "./fake-bb.ts";
import { TopicStore } from "../../src/server/topics.ts";
import { openDatabase } from "../../src/server/db.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

const isQuick = (prompt: string) =>
  prompt.includes("You name one new agent thread");

async function setup() {
  let topicId = "";
  world = await fakeWorld({
    complete: ({ prompt }) =>
      isQuick(prompt)
        ? JSON.stringify({
            goal: "Parser tab handling",
            subjectId: topicId,
            proposed: null,
          })
        : JSON.stringify({ recap: "r", state: "in_progress" }),
  });
  const w = world;
  const corpus = new TopicStore(openDatabase(w.bb));
  const parser = corpus.create("Parser", "Parser product");
  const docs = corpus.create("Docs", "Docs product");
  topicId = parser.id;
  const hook = w.harness.registrations.hooks["message.dispatch"]!;
  const dispatch = async (
    threadId: string,
    text: string,
    overrides: Record<string, unknown> = {},
    thread: Record<string, unknown> = {},
  ) => {
    const created = w.addThread(threadId, {
      title: null,
      createdAt: Date.now(),
      ...thread,
    });
    const context = makeMessageDispatchHookContext({
      thread: created,
      input: { text },
      parentThreadId: null,
      origin: "app",
      experimental_submission: null,
      ...overrides,
    });
    expect(await hook(context)).toEqual({ action: "proceed" });
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  const quickCalls = () => w.completions.filter((c) => isQuick(c.prompt));
  return { w, corpus, parser, docs, dispatch, settle, quickCalls };
}

describe("a new root's first topic", () => {
  it("comes from Quick analysis of the first request, with its title", async () => {
    const { w, corpus, parser, dispatch, settle, quickCalls } = await setup();
    await dispatch("t1", "Make the parser handle tabs");
    await settle();
    expect(quickCalls()).toHaveLength(1);
    expect(quickCalls()[0]!.prompt).toContain("Make the parser handle tabs");
    expect(corpus.assignment("t1")).toMatchObject({
      entityId: parser.id,
      provenance: "quick",
    });
    expect(w.threads.get("t1")?.title).toBe("Parser tab handling");
  });

  it("reuses the composer's preview of the same text, with no second call", async () => {
    const { w, corpus, docs, dispatch, settle, quickCalls } = await setup();
    await w.harness.behavior.callRpc("draftIdentity", {
      draftKey: "d1",
      text: "Write the docs",
      identity: {
        entityId: docs.id,
        proposal: null,
        provenance: "automatic",
        goal: "Docs for tabs",
      },
    });
    await dispatch("t1", "Write the docs");
    await settle();
    expect(quickCalls()).toHaveLength(0);
    expect(corpus.assignment("t1")).toMatchObject({
      entityId: docs.id,
      provenance: "quick",
    });
    expect(w.threads.get("t1")?.title).toBe("Docs for tabs");
  });

  it("is the topic you picked, which Quick analysis never replaces", async () => {
    const { w, corpus, docs, dispatch, settle } = await setup();
    await w.harness.behavior.callRpc("draftIdentity", {
      draftKey: "d1",
      text: "Make the parser handle tabs",
      identity: { entityId: docs.id, proposal: null, provenance: "manual" },
    });
    await dispatch("t1", "Make the parser handle tabs");
    await settle();
    expect(corpus.assignment("t1")).toMatchObject({
      entityId: docs.id,
      provenance: "manual",
    });
    // Quick analysis still titles it.
    expect(w.threads.get("t1")?.title).toBe("Parser tab handling");
  });

  it("is the topic of the workstream whose ＋ opened the composer", async () => {
    const { w, corpus, docs, dispatch, settle } = await setup();
    const section = w.addSection("Docs");
    corpus.bindGroup(section.id, docs.id);
    await w.harness.behavior.callRpc("draftIdentity", {
      draftKey: "d1",
      text: "Make the parser handle tabs",
      identity: {
        entityId: null,
        proposal: null,
        provenance: "inherited",
        sectionId: section.id,
      },
    });
    await dispatch("t1", "Make the parser handle tabs");
    await settle();
    expect(corpus.assignment("t1")).toMatchObject({
      entityId: docs.id,
      provenance: "inherited",
    });
  });

  it("is the topic of the thread an agent started it from", async () => {
    const { w, corpus, docs, dispatch, settle } = await setup();
    w.addThread("caller", { title: "Caller" });
    corpus.assign("caller", docs.id, { provenance: "full" });
    await dispatch("t1", "Make the parser handle tabs", {
      origin: "agent",
      initiator: "agent",
      senderThreadId: "caller",
    });
    await settle();
    expect(corpus.assignment("t1")).toMatchObject({
      entityId: docs.id,
      provenance: "inherited",
    });
  });

  it("isn't given to a child, which follows its parent", async () => {
    const { w, corpus, parser, dispatch, settle } = await setup();
    w.addThread("parent", { title: "Parent" });
    await dispatch(
      "child",
      "Run the tests",
      { parentThreadId: "parent", origin: "agent", initiator: "agent" },
      { parentThreadId: "parent" },
    );
    await settle();
    await w.harness.behavior.callRpc("refresh", null);
    expect(corpus.assignment("child").inheritedFrom).toBe("parent");
    expect(corpus.assignment("parent").entityId).not.toBe(parser.id);
  });
});

describe("the composer's preview", () => {
  it("gives a mentioned workstream's topic without a model call, and changes nothing", async () => {
    const { w, corpus, docs, quickCalls } = await setup();
    const section = w.addSection("Docs");
    corpus.bindGroup(section.id, docs.id);
    const revision = corpus.revision();
    const preview = (await w.harness.behavior.callRpc("preview", {
      prompt: `Add an example to @section:${section.id}`,
    })) as { subjectId: string | null; subject: string | null };
    expect(preview).toMatchObject({ subjectId: docs.id, subject: "Docs" });
    expect(quickCalls()).toHaveLength(0);
    expect(corpus.revision()).toBe(revision);
  });

  it("previews a draft with Quick analysis and never creates a topic", async () => {
    let calls = 0;
    world = await fakeWorld({
      complete: () => {
        calls++;
        return JSON.stringify({
          goal: "Shelf reservations",
          subjectId: null,
          proposed: { name: "Reservations", description: "" },
        });
      },
    });
    const corpus = new TopicStore(openDatabase(world.bb));
    const preview = (await world.harness.behavior.callRpc("preview", {
      prompt: "Let people reserve shelves",
    })) as {
      goal: string | null;
      proposal: { name: string } | null;
      subject: string | null;
    };
    expect(calls).toBe(1);
    expect(preview).toMatchObject({
      goal: "Shelf reservations",
      subject: "Reservations",
      proposal: { name: "Reservations" },
    });
    expect(corpus.list()).toEqual([]);
  });
});
