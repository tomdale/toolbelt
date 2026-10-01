/**
 * Per-thread instructions Workstreams contributes through `configure`
 * (SPEC §5). Short by design: command details live in `--help` and the
 * generated plugin-commands skill. Workstreams registers no agent tools.
 */

export type ProjectShape = "git" | "workforest" | "none" | "unknown";

export type ThreadRole =
  | {
      kind: "task";
      workstream: { name: string; description: string | null } | null;
      shape: ProjectShape;
    }
  | { kind: "delegate"; parentTitle: string | null };

const MAX = 4096;

/**
 * Names and descriptions come from sections and generated text anyone can
 * edit, so they are flattened and stripped of Markdown and shell syntax
 * before they go into instructions.
 */
export function quote(text: string, max = 120): string {
  const flat = text
    .replace(/[`$\\*_#<>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function shapeGuidance(shape: ProjectShape): string {
  switch (shape) {
    case "git":
      return '`--new-environment worktree` for code changes; `--environment "$BB_ENVIRONMENT_ID"` otherwise';
    case "workforest":
      return 'this project is a multi-repository Workforest workspace, and BB worktrees are unavailable. For isolated code changes, create a checkout with `wf task new <slug> --repo <repo>` (or `wf new <slug>` for a follow-up across the whole workspace), and attach it with `--environment <path>`. Otherwise use `--environment "$BB_ENVIRONMENT_ID"`';
    case "none":
      return '`--environment "$BB_ENVIRONMENT_ID"` to share this workspace, or `--new-environment personal`';
    default:
      return '`--environment "$BB_ENVIRONMENT_ID"` to share this environment, or a fresh one with `--new-environment`';
  }
}

export function instructionsFor(role: ThreadRole): string {
  if (role.kind === "delegate") {
    const parent = role.parentTitle
      ? `"${quote(role.parentTitle)}"`
      : "its parent thread";
    return `You are a delegated subtask of ${parent}. Report results to it. Hand off out-of-scope requests with \`bb workstreams handoff\`. Don't spawn further threads.`.slice(
      0,
      MAX,
    );
  }
  const where = role.workstream
    ? `You are a task thread in the "${quote(role.workstream.name, 80)}" workstream${
        role.workstream.description
          ? ` (${quote(role.workstream.description)})`
          : ""
      }.`
    : "You are a task thread.";
  return `${where} When the user requests or approves delegating separable subtasks to child threads, use \`bb thread spawn --parent-self --lifecycle-owner-thread "$BB_THREAD_ID"\`, always choosing the environment explicitly: ${shapeGuidance(role.shape)}. Then coordinate and integrate here. If the user asks for something outside this thread's task or workstream, don't do it here: pass their request verbatim to \`bb workstreams handoff --request-stdin\` and reply with the link it prints.`.slice(
    0,
    MAX,
  );
}
