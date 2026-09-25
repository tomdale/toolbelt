export type SideQuestDecision =
  { sideQuest: false } | { sideQuest: true; title: string; reason: string };

export type RequestEvent = {
  type?: string;
  seq?: number;
  data?: unknown;
};

export function requestText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = message as { role?: string; content?: unknown };
  if (value.role !== "user") return "";
  if (typeof value.content === "string") return value.content.trim();
  if (!Array.isArray(value.content)) return "";
  return value.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function parseDecision(text: string): SideQuestDecision | null {
  try {
    const value = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, ""),
    );
    if (typeof value.sideQuest !== "boolean") return null;
    if (!value.sideQuest) return { sideQuest: false };
    if (typeof value.title !== "string" || !value.title.trim()) return null;
    return {
      sideQuest: true,
      title: value.title.trim().slice(0, 80),
      reason:
        typeof value.reason === "string"
          ? value.reason.trim().slice(0, 240)
          : "",
    };
  } catch {
    return null;
  }
}

export function decisionPrompt(topic: string, request: string): string {
  return `Existing thread topic, oldest to newest:\n${topic}\n\nNew request:\n${request}`;
}

export function previousRequestSequence(
  events: RequestEvent[],
  currentRequest: string,
): number | null {
  const requests = events
    .flatMap((event) => {
      if (
        event.type !== "client/turn/requested" ||
        typeof event.seq !== "number"
      )
        return [];
      const data = event.data as { input?: unknown } | undefined;
      if (!data) return [];
      return [
        {
          seq: event.seq,
          text: requestText({ role: "user", content: data.input }),
        },
      ];
    })
    .filter(
      (event) =>
        event.text &&
        !event.text.startsWith("[bb system]") &&
        !event.text.startsWith("[bb message"),
    );
  let current = -1;
  for (let index = 0; index < requests.length; index++)
    if (requests[index].text === currentRequest) current = index;
  return current > 0 ? requests[current - 1].seq : null;
}
