import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import type { InteractionResponse, ToolResult } from "./contracts.ts";

/** Copy uploaded composer attachments into the questioned thread's project. */
export async function copyAnswerAttachments(
  bb: BbPluginApi,
  targetProjectId: string,
  response: InteractionResponse,
): Promise<InteractionResponse> {
  const pathsByProject = new Map<string, Map<string, string>>();
  for (const answer of Object.values(response.answers)) {
    for (const attachment of answer.attachments ?? []) {
      if (attachment.projectId === targetProjectId) continue;
      const paths = pathsByProject.get(attachment.projectId) ?? new Map();
      paths.set(attachment.path, attachment.name ?? "Attachment");
      pathsByProject.set(attachment.projectId, paths);
    }
  }
  const copiedAttachments = new Map<
    string,
    Awaited<ReturnType<typeof bb.sdk.projects.attachments.upload>>
  >();
  for (const [sourceProjectId, paths] of pathsByProject) {
    const results = await Promise.all(
      [...paths].map(async ([path, name]) => {
        const content = await bb.sdk.projects.attachments.read({
          projectId: sourceProjectId,
          path,
        });
        return { name, path, content };
      }),
    );
    for (const { path, name, content } of results) {
      const uploaded = await bb.sdk.projects.attachments.upload({
        projectId: targetProjectId,
        clientFile: content.bytes,
        filename: name,
        mimeType: content.mimeType,
      });
      copiedAttachments.set(JSON.stringify([sourceProjectId, path]), uploaded);
    }
  }
  return {
    answers: Object.fromEntries(
      Object.entries(response.answers).map(([id, answer]) => [
        id,
        {
          ...answer,
          ...(answer.attachments === undefined
            ? {}
            : {
                attachments: answer.attachments.map((attachment) => {
                  const copied = copiedAttachments.get(
                    JSON.stringify([attachment.projectId, attachment.path]),
                  );
                  return copied
                    ? {
                        ...copied,
                        projectId: targetProjectId,
                        sourceProjectId: attachment.projectId,
                        sourcePath: attachment.path,
                      }
                    : attachment;
                }),
              }),
        },
      ]),
    ),
  };
}

/** Include pasted images as image content so the answering agent can inspect them. */
export async function agentToolResult(
  bb: BbPluginApi,
  result: ToolResult,
): Promise<PluginAgentToolResult> {
  const attachments = Object.values(result.annotations ?? {}).flatMap(
    (annotation) => annotation.attachments ?? [],
  );
  const content = await Promise.all(
    attachments.map(async (attachment) => {
      if (
        attachment.sizeBytes !== undefined &&
        attachment.sizeBytes > 256_000
      ) {
        return {
          type: "text" as const,
          text: `Attached file ${attachment.name} is ${attachment.sizeBytes} bytes; it is too large to include in the answer.`,
        };
      }
      const bytes = await bb.sdk.projects.attachments.read({
        projectId: attachment.sourceProjectId ?? attachment.projectId,
        path: attachment.sourcePath ?? attachment.path,
      });
      if (
        attachment.type === "localImage" &&
        !bytes.mimeType.startsWith("image/svg")
      ) {
        return {
          type: "image" as const,
          data: Buffer.from(bytes.bytes).toString("base64"),
          mimeType: bytes.mimeType,
        };
      }
      if (
        attachment.type === "localFile" &&
        (bytes.mimeType.startsWith("text/") ||
          bytes.mimeType === "application/json" ||
          bytes.mimeType.endsWith("+json")) &&
        bytes.sizeBytes <= 256_000
      ) {
        return {
          type: "text" as const,
          text: `Attached file ${attachment.name}:\n${Buffer.from(bytes.bytes).toString("utf8")}`,
        };
      }
      return {
        type: "text" as const,
        text: `Attached file: ${attachment.name} (${attachment.mimeType ?? bytes.mimeType}, ${bytes.sizeBytes} bytes)`,
      };
    }),
  );
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ...result,
        }),
      },
      ...content,
    ],
  };
}
