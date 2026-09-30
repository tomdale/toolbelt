/**
 * The one-time organizing flow (SPEC §8), offered again later as
 * "Reorganize…": propose a map, review it, file threads, review the moves,
 * apply. The server persists each step, so a reload resumes where it stopped.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useBbNavigate,
  useRealtime,
  type useRpc,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../server/contract.ts";
import type { BootstrapMove, BootstrapState } from "../../server/bootstrap.ts";
import { InspectButton } from "../debug/InspectButton.tsx";
import { WorkingMark } from "../sidebar/StatusMark.tsx";
import { ghostButton, primaryButton, secondaryButton } from "./controls.ts";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;
type Call = (input: { action: string } & Record<string, unknown>) => void;
type Preview = NonNullable<BootstrapState["preview"]>;
type Change = BootstrapState["changes"][number] & {
  workstream?: string;
  into?: string;
  name?: string;
  reason?: string;
};

const WORKING: Partial<Record<BootstrapState["status"], string>> = {
  proposing: "Drafting a map…",
  assigning: "Filing threads…",
  applying: "Moving threads…",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function Organize({
  rpc,
  bootstrapped,
}: {
  rpc: Rpc;
  bootstrapped: boolean;
}) {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const call = useCallback(
    async (input: { action: string } & Record<string, unknown>) => {
      const generation = ++requestGeneration.current;
      setError(null);
      try {
        const result = await rpc.call("bootstrap", input as never);
        if (generation !== requestGeneration.current) return;
        setState(result.state as BootstrapState | null);
      } catch (cause) {
        if (generation !== requestGeneration.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (generation === requestGeneration.current) setLoaded(true);
      }
    },
    [rpc],
  );
  const send: Call = (input) => void call(input);
  useEffect(() => {
    void call({ action: "get" });
  }, [call]);
  useRealtime("changed", () => void call({ action: "get" }));
  // Model steps report progress through realtime "changed"; poll lightly too.
  const working = state ? state.status in WORKING : false;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void call({ action: "get" }), 1000);
    return () => clearInterval(timer);
  }, [call, working]);

  // Nothing until the first read, so a run in progress never flashes the
  // intro first.
  if (!loaded) return null;

  // Each run keys its steps, so choices from an earlier run never carry over.
  const step =
    !state || state.status === "applied" ? (
      <Intro state={state} bootstrapped={bootstrapped} send={send} />
    ) : working ? (
      <Working status={state.status} />
    ) : state.status === "failed" ? (
      <Failed state={state} send={send} />
    ) : state.status === "review" ? (
      <ReviewMap key={state.startedAt} state={state} send={send} />
    ) : (
      <ReviewMoves key={state.startedAt} state={state} send={send} />
    );
  return (
    <section
      aria-label="Organize"
      className="overflow-hidden rounded-lg border border-border text-sm"
    >
      {step}
      {error ? (
        <p role="alert" className="px-4 pb-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Intro({
  state,
  bootstrapped,
  send,
}: {
  state: BootstrapState | null;
  bootstrapped: boolean;
  send: Call;
}) {
  const navigate = useBbNavigate();
  const applied = state?.status === "applied";
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
      <div className="min-w-0 flex-1">
        <h2 className="font-medium">
          {applied
            ? "Workstreams organized"
            : bootstrapped
              ? "Reorganize workstreams"
              : "Organize your workstreams"}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {applied ? (
            <>
              {state?.error ? `${state.error} ` : ""}
              Undo anytime from{" "}
              <button
                type="button"
                className="text-foreground underline-offset-2 hover:underline"
                onClick={() =>
                  navigate.toPluginPanel("home", { subPath: "activity" })
                }
              >
                Activity
              </button>
              .
            </>
          ) : bootstrapped ? (
            "Re-file the threads Workstreams filed. Threads you filed stay put."
          ) : (
            "Propose a map and file your threads. Nothing moves until you approve."
          )}
        </p>
      </div>
      <div className="flex gap-2">
        {!bootstrapped && !applied ? (
          <button
            type="button"
            className={ghostButton}
            onClick={() => send({ action: "skip" })}
          >
            Skip
          </button>
        ) : null}
        <button
          type="button"
          className={applied ? secondaryButton : primaryButton}
          onClick={() => send({ action: "start" })}
        >
          {bootstrapped || applied ? "Reorganize…" : "Organize…"}
        </button>
      </div>
    </div>
  );
}

function Working({ status }: { status: BootstrapState["status"] }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-3.5">
      <WorkingMark />
      <p role="status">{WORKING[status]}</p>
    </div>
  );
}

function Failed({ state, send }: { state: BootstrapState; send: Call }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-1 font-medium">
          Organizing stopped
          <RunInspect state={state} />
        </h2>
        <p className="mt-0.5 text-xs text-destructive">
          {state.error ?? "Something went wrong."}
        </p>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className={ghostButton}
          onClick={() => send({ action: "cancel" })}
        >
          Cancel
        </button>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => send({ action: "start" })}
        >
          Start over
        </button>
      </div>
    </div>
  );
}

/** Step 3: accept or reject each proposed map change. */
function ReviewMap({ state, send }: { state: BootstrapState; send: Call }) {
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const changes = state.changes as Change[];
  const descriptions = Object.entries(state.descriptions);
  const toFile = state.roots.filter((r) => r.provenance !== "user").length;
  const accepted = (change: Change) => decisions[change.id] ?? change.accepted;
  return (
    <>
      <Heading title="Review the map" state={state} />
      <div className="px-2 pb-2">
        {changes.length === 0 ? (
          <p className="px-2 py-1.5 text-muted-foreground">
            No changes to the map.
          </p>
        ) : (
          <ul>
            {changes.map((change) => (
              <li key={change.id}>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-state-hover">
                  <input
                    type="checkbox"
                    className="ws-check mt-[3px]"
                    checked={accepted(change)}
                    onChange={(event) =>
                      setDecisions({
                        ...decisions,
                        [change.id]: event.target.checked,
                      })
                    }
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1",
                      !accepted(change) && "opacity-60",
                    )}
                  >
                    <ChangeSummary change={change} />
                    {change.reason ? (
                      <span className="block text-xs text-muted-foreground">
                        {change.reason}
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {descriptions.length ? (
          <details className="group text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden
                className="inline-block transition-transform group-open:rotate-90"
              >
                ›
              </span>
              {plural(descriptions.length, "description")}
            </summary>
            <dl className="grid grid-cols-[minmax(0,12rem)_1fr] gap-x-4 gap-y-1 px-2 pb-1.5 pt-0.5">
              {descriptions.map(([name, text]) => (
                <div key={name} className="contents">
                  <dt className="truncate font-medium">{name}</dt>
                  <dd className="text-muted-foreground">{text}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </div>
      <Footer send={send}>
        <button
          type="button"
          className={primaryButton}
          onClick={() =>
            send({
              action: "assign",
              decisions: changes.map((c) => ({
                id: c.id,
                accepted: accepted(c),
              })),
            })
          }
        >
          {toFile ? `File ${plural(toFile, "thread")}` : "Continue"}
        </button>
      </Footer>
    </>
  );
}

function ChangeSummary({ change }: { change: Change }) {
  const quiet = (text: string) => (
    <span className="text-muted-foreground">{text}</span>
  );
  if (change.kind === "rename")
    return (
      <span>
        {quiet("Rename")} {change.workstream} {quiet("to")} {change.name}
      </span>
    );
  if (change.kind === "merge")
    return (
      <span>
        {quiet("Merge")} {change.workstream} {quiet("into")} {change.into}
      </span>
    );
  return (
    <span>
      {quiet("New workstream")} {change.name}
    </span>
  );
}

/** Threads moving between the same two workstreams, shown under one header. */
type Lane = {
  key: string;
  from: string;
  to: string;
  created: boolean;
  moves: BootstrapMove[];
};

function lanesOf(preview: Preview): Lane[] {
  const created = new Set(preview.creates.map((c) => c.name));
  const lanes = new Map<string, Lane>();
  for (const move of preview.moves) {
    const key = `${move.from ?? ""}\u0000${move.to}`;
    const lane = lanes.get(key) ?? {
      key,
      from: move.fromName,
      to: move.toName,
      created: created.has(move.toName),
      moves: [],
    };
    lane.moves.push(move);
    lanes.set(key, lane);
  }
  return [...lanes.values()].sort(
    (a, b) => a.to.localeCompare(b.to) || a.from.localeCompare(b.from),
  );
}

/** The one fact worth a second look; routine moves carry none. */
function noteOf(move: BootstrapMove, filedByUser: boolean): string | null {
  if (filedByUser) return "Filed by you";
  if (move.confidence === "medium") return "Medium confidence";
  if (move.confidence === "low") return "Low confidence";
  return null;
}

/** Step 5: the diff, one checkbox per thread, before anything moves. */
function ReviewMoves({ state, send }: { state: BootstrapState; send: Call }) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const preview = state.preview!;
  const filedByUser = new Set(
    state.roots.filter((r) => r.provenance === "user").map((r) => r.id),
  );
  const accepted = (move: BootstrapMove) =>
    overrides[move.threadId] ?? move.accepted;
  const count = preview.moves.filter(accepted).length;
  const lanes = lanesOf(preview);
  return (
    <>
      <Heading title="Review moves" state={state} />
      <div className="px-2 pb-2">
        {lanes.length === 0 &&
        preview.unsure.length === 0 &&
        preview.renames.length === 0 ? (
          <p className="px-2 py-1.5 text-muted-foreground">
            Every thread is already in place.
          </p>
        ) : null}
        {preview.renames.length ? (
          <Group heading="Renames">
            {preview.renames.map((rename) => (
              <StaticRow key={rename.sectionId}>
                <span className="inline-flex items-center gap-1.5">
                  {rename.from} <span aria-hidden>→</span>
                  <span className="sr-only">to</span>{" "}
                  <span className="text-foreground">{rename.to}</span>
                </span>
              </StaticRow>
            ))}
          </Group>
        ) : null}
        {lanes.map((lane) => (
          <Group
            key={lane.key}
            heading={
              <>
                <span className="truncate">{lane.from}</span>{" "}
                <span aria-hidden>→</span>
                <span className="sr-only">to</span>{" "}
                <span className="truncate font-medium text-foreground">
                  {lane.to}
                </span>{" "}
                {lane.created ? (
                  <span className="rounded bg-primary/15 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-primary">
                    New
                  </span>
                ) : null}
              </>
            }
          >
            {lane.moves.map((move) => {
              const on = accepted(move);
              const note = noteOf(move, filedByUser.has(move.threadId));
              return (
                <li key={move.threadId}>
                  <label className="flex h-7 cursor-pointer items-center gap-2.5 rounded-md px-2 hover:bg-state-hover">
                    <input
                      type="checkbox"
                      className="ws-check"
                      checked={on}
                      onChange={(event) =>
                        setOverrides({
                          ...overrides,
                          [move.threadId]: event.target.checked,
                        })
                      }
                    />
                    <span
                      title={move.title}
                      className={cn(
                        "min-w-0 flex-1 truncate transition-colors",
                        !on && "text-muted-foreground",
                      )}
                    >
                      {move.title}
                    </span>{" "}
                    {note ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {note}
                      </span>
                    ) : null}
                    {move.traceId ? (
                      <InspectButton
                        target={{ traceIds: [move.traceId] }}
                        title={`Why ${move.title} goes to ${move.toName}`}
                        label="Inspect the filing call"
                        className="text-muted-foreground"
                      />
                    ) : null}
                  </label>
                </li>
              );
            })}
          </Group>
        ))}
        {preview.unsure.length ? (
          <Group heading="Unsure — staying put">
            {preview.unsure.map((thread) => (
              <StaticRow key={thread.threadId} title={thread.title}>
                {thread.title}
              </StaticRow>
            ))}
          </Group>
        ) : null}
      </div>
      <Footer send={send}>
        <button
          type="button"
          className={primaryButton}
          disabled={count === 0 && preview.renames.length === 0}
          onClick={() =>
            send({
              action: "apply",
              overrides: Object.entries(overrides).map(([threadId, value]) => ({
                threadId,
                accepted: value,
              })),
            })
          }
        >
          {count ? `Move ${plural(count, "thread")}` : "Apply"}
        </button>
      </Footer>
    </>
  );
}

function Heading({ title, state }: { title: string; state: BootstrapState }) {
  return (
    <header className="flex items-center gap-1 px-4 pb-2 pt-3.5">
      <h2 className="font-medium">{title}</h2>
      <RunInspect state={state} />
    </header>
  );
}

/** Debug mode: every model call this organizing run made. */
function RunInspect({ state }: { state: BootstrapState }) {
  if (!state.traceIds?.length) return null;
  return (
    <InspectButton
      // By link, so a large run's calls aren't capped by an id list.
      target={{ link: { kind: "organize", ref: String(state.startedAt) } }}
      title="Model calls for this organizing run"
      label="Inspect this run's model calls"
      className="text-muted-foreground"
    />
  );
}

function Group({
  heading,
  children,
}: {
  heading: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="mt-3 first:mt-0">
      <h3
        id={id}
        className="flex min-w-0 items-center gap-1.5 px-2 pb-0.5 text-xs text-muted-foreground"
      >
        {heading}
      </h3>
      <ul>{children}</ul>
    </div>
  );
}

/** A row with nothing to decide, indented to line up with checkbox rows. */
function StaticRow({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <li className="flex h-7 items-center gap-2.5 px-2 text-muted-foreground">
      <span aria-hidden className="size-3.5 shrink-0" />
      <span title={title} className="min-w-0 truncate">
        {children}
      </span>
    </li>
  );
}

/** Cancel ends the whole run, not just the current step. */
function Footer({ send, children }: { send: Call; children: ReactNode }) {
  return (
    <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">
      <button
        type="button"
        className={ghostButton}
        onClick={() => send({ action: "cancel" })}
      >
        Cancel
      </button>
      {children}
    </footer>
  );
}
