/**
 * A thread's user requests as BB records them. Shared by everything that
 * reads what a thread was asked to do: analysis, ownership evidence, and the
 * opening title.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Sdk = BbPluginApi["sdk"];

const SYSTEM_PREFIX = "[bb system]";

type InputPart = { type: string; text?: string };

/** The concatenated text blocks of a prompt input. */
export function inputText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return (input as InputPart[])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** BB's own messages to a parent thread are not requests from the user. */
export const isUserRequest = (text: string) =>
  text.length > 0 && !text.startsWith(SYSTEM_PREFIX);

/** The first user request among a thread's `client/turn/requested` events. */
export function openingOf(
  requested: readonly { data?: unknown }[],
): string | null {
  return (
    requested
      .map((event) =>
        inputText((event.data as { input?: unknown } | null)?.input),
      )
      .find(isUserRequest) ?? null
  );
}

/**
 * The thread's opening request, or null before BB has recorded one. It is
 * recorded when the first turn is requested, before that turn starts.
 */
export async function openingRequest(
  sdk: Sdk,
  threadId: string,
): Promise<string | null> {
  return openingOf(
    await sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      order: "asc",
      limit: "4",
    }),
  );
}
