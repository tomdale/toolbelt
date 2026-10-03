import { describe, expect, it, vi } from "vitest";
import {
  agentToolResult,
  copyAnswerAttachments,
} from "../../../src/server/questions/attachments.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

function createBb() {
  const uploads: unknown[] = [];
  const bb = {
    sdk: {
      projects: {
        attachments: {
          read: vi.fn(async ({ path }: { path: string }) => ({
            bytes: path.endsWith(".txt")
              ? new TextEncoder().encode("hello")
              : new Uint8Array([1, 2, 3]),
            mimeType: path.endsWith(".png") ? "image/png" : "text/plain",
            sizeBytes: path.endsWith(".txt") ? 5 : 3,
          })),
          upload: vi.fn(
            async ({
              filename,
              mimeType = "",
              projectId,
            }: Record<string, string>) => {
              const result = {
                type: mimeType.startsWith("image/")
                  ? "localImage"
                  : "localFile",
                path: `target/${filename}`,
                name: filename,
                mimeType,
                sizeBytes: 3,
              };
              uploads.push({ projectId, ...result });
              return result;
            },
          ),
        },
      },
    },
  };
  return { bb: bb as unknown as BbPluginApi, uploads };
}

describe("question attachments", () => {
  it("copies attachments into the thread project and rewrites references", async () => {
    const { bb, uploads } = createBb();
    const response = await copyAnswerAttachments(bb, "project-target", {
      answers: {
        q0: {
          selected: [],
          attachments: [
            {
              type: "localImage",
              projectId: "project-compose",
              path: "source/screenshot.png",
              name: "screenshot.png",
            },
            {
              type: "localFile",
              projectId: "thread-project",
              path: "thread/notes.md",
              name: "notes.md",
            },
          ],
        },
      },
    });

    expect(uploads).toHaveLength(2);
    expect(response.answers.q0?.attachments).toEqual([
      expect.objectContaining({
        projectId: "project-target",
        path: "target/screenshot.png",
        sourceProjectId: "project-compose",
        sourcePath: "source/screenshot.png",
        type: "localImage",
      }),
      expect.objectContaining({
        projectId: "project-target",
        path: "target/notes.md",
        sourceProjectId: "thread-project",
        sourcePath: "thread/notes.md",
        type: "localFile",
      }),
    ]);
  });

  it("includes text attachment contents in the agent result", async () => {
    const { bb } = createBb();
    const result = await agentToolResult(bb, {
      questions: [],
      answers: { "What?": "" },
      annotations: {
        "What?": {
          attachments: [
            {
              type: "localFile",
              projectId: "project-target",
              path: "target/notes.txt",
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: 3,
            },
          ],
        },
      },
    });

    if (typeof result === "string")
      throw new Error("Expected structured result");
    expect(result.content).toContainEqual({
      type: "text",
      text: `Attached file notes.txt:\nhello`,
    });
  });

  it("includes pasted images in the agent result as image content", async () => {
    const { bb } = createBb();
    const result = await agentToolResult(bb, {
      questions: [],
      answers: { "What?": "" },
      annotations: {
        "What?": {
          attachments: [
            {
              type: "localImage",
              projectId: "project-target",
              path: "target/screenshot.png",
              name: "screenshot.png",
              mimeType: "image/png",
            },
          ],
        },
      },
    });

    expect(result).toEqual({
      content: [
        { type: "text", text: expect.stringContaining('"screenshot.png"') },
        { type: "image", data: "AQID", mimeType: "image/png" },
      ],
    });
  });
});
