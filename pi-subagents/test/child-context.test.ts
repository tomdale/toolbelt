import { describe, expect, it, vi } from "vitest";
import { inChildSessionContext, runInChildSessionContext } from "../src/child-context.js";
import subagentsExtension from "../src/index.js";

describe("child session async context", () => {
  it("is scoped to the child async branch", async () => {
    expect(inChildSessionContext()).toBe(false);
    await runInChildSessionContext(async () => {
      expect(inChildSessionContext()).toBe(true);
      await Promise.resolve();
      expect(inChildSessionContext()).toBe(true);
    });
    expect(inChildSessionContext()).toBe(false);
  });

  it("prevents a child resource load from creating another extension manager", async () => {
    const pi = new Proxy({}, {
      get: vi.fn(() => {
        throw new Error("child extension factory must be a no-op");
      }),
    });

    await runInChildSessionContext(async () => {
      expect(() => subagentsExtension(pi as any)).not.toThrow();
    });
  });

  it("deactivates when BB_THREAD_ID is set", () => {
    const original = process.env.BB_THREAD_ID;
    try {
      process.env.BB_THREAD_ID = "thr_test123";
      const pi = new Proxy({}, {
        get: vi.fn(() => {
          throw new Error("extension factory must not access pi when in BB");
        }),
      });
      expect(() => subagentsExtension(pi as any)).not.toThrow();
    } finally {
      if (original === undefined) delete process.env.BB_THREAD_ID;
      else process.env.BB_THREAD_ID = original;
    }
  });
});
