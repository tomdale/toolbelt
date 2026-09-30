import {
  ThreadTitle,
  UrlLink,
  experimental_useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";

export function ActivityThreadLink({
  threadId,
  fallback,
}: {
  threadId: string;
  fallback?: string;
}) {
  const { threads } = experimental_useSidebarThreads();
  const thread = threads.find((thread) => thread.id === threadId);
  const href =
    thread?.projectId && thread.projectId !== "proj_personal"
      ? `/projects/${encodeURIComponent(thread.projectId)}/threads/${encodeURIComponent(threadId)}`
      : `/threads/${encodeURIComponent(threadId)}`;
  return (
    <UrlLink
      href={href}
      title={thread?.displayTitle ?? fallback ?? "Open thread"}
      className="inline-flex max-w-full items-baseline gap-0.5 rounded-full border border-border bg-surface-raised/50 py-0.5 pl-1 pr-1.5 text-xs font-normal leading-4 text-foreground no-underline hover:bg-state-hover hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Icon
        name="UserRound"
        aria-hidden
        className="size-3.5 shrink-0 self-center text-muted-foreground"
      />
      <span className="min-w-0 truncate">
        {thread ? (
          <ThreadTitle threadId={threadId} />
        ) : (
          (fallback ?? "Unavailable thread")
        )}
      </span>
    </UrlLink>
  );
}
