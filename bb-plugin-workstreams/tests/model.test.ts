import { expect, it } from "vitest";
import {
  classificationPrompt,
  excludeDispatchThreads,
  type Thread,
} from "../model";

it("excludes Dispatch roots from product groups but retains child managers", () => {
  const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({
    id,
    title: id,
    project: "p",
    repository: null,
    status: "idle",
    updatedAt: 1,
    latestAttentionAt: 1,
    sectionId: null,
    parentThreadId: null,
    environmentPath: null,
    hasPendingInteraction: false,
    ...extra,
  });
  const dispatch = thread("dispatch", {
    environmentPath: "/Users/tomdale/Code/tomdaleOS/",
  });
  const manager = thread("manager", { parentThreadId: "dispatch" });
  const worker = thread("worker", { parentThreadId: "manager" });
  expect(
    excludeDispatchThreads([dispatch, manager, worker]).map((t) => t.id),
  ).toEqual(["manager", "worker"]);
  expect(
    excludeDispatchThreads([
      thread("other-root", { environmentPath: "/tmp/tomdaleOS" }),
      manager,
    ]).map((t) => t.id),
  ).toEqual(["other-root", "manager"]);
});

it("includes project fallback evidence in classification prompts", () => {
  const prompt = classificationPrompt([
    {
      id: "1",
      title: "Continue work",
      project: "Agent Toolkit",
      repository: null,
      path: null,
      excerpts: "User: Continue. Assistant: What next?",
      timeline: "",
      status: "idle",
      updatedAt: 1,
      latestAttentionAt: 1,
      sectionId: null,
      hasPendingInteraction: false,
    },
  ]);
  expect(prompt).toContain('"project":"Agent Toolkit"');
  expect(prompt).toContain("then BB project name");
});
