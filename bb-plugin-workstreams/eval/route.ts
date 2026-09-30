/**
 * Live evaluation of the intake router prompt (SPEC §6). Opt-in; calls models.
 *
 *   node eval/route.ts [model[:disabled] ...]
 *   EVAL_ROUTE=<private replay.json> EVAL_PRIVATE_ROOT=<dir> EVAL_OUTPUT=<dir>/out.json node eval/route.ts
 *
 * A fixture holds the workstreams, the active threads, and cases with the
 * expected outcome. Each case runs through the production prompt and parser
 * (`src/domain/router.ts`), with `@thread`/`@section` mentions short-circuited
 * as the server does. Threads listed in a case's `exclude` are hidden from
 * it (a replayed prompt can't continue a thread that didn't exist yet).
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  mentionedTarget,
  parseRoute,
  routePrompt,
  type RawRoute,
  type RouteInput,
} from "../src/domain/router.ts";
import {
  gatewayComplete,
  gatewayKey,
} from "../src/server/inference/gateway.ts";

type Expect = {
  outcome: string | string[];
  threadId?: string;
  workstream?: string;
  code?: boolean;
};
type Fixture = {
  workstreams: RouteInput["workstreams"];
  threads: RouteInput["threads"];
  cases: { id: string; prompt: string; expect: Expect; exclude?: string[] }[];
};

const env = process.env;
const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["google/gemini-3.1-flash-lite"];
const privateFile = env.EVAL_ROUTE;
if (
  privateFile &&
  (!env.EVAL_PRIVATE_ROOT ||
    !env.EVAL_OUTPUT ||
    !resolve(env.EVAL_OUTPUT).startsWith(resolve(env.EVAL_PRIVATE_ROOT) + "/"))
)
  throw new Error(
    "A private replay needs EVAL_OUTPUT inside EVAL_PRIVATE_ROOT.",
  );
const fixture: Fixture = JSON.parse(
  await readFile(privateFile ?? new URL("route.json", import.meta.url), "utf8"),
);

// The production transport (`src/server/inference/gateway.ts`).
const key = await gatewayKey();
if (!key)
  throw new Error("No AI Gateway key: sign Pi in to Vercel AI Gateway.");
const apiKey: string = key;

/** `<model>:disabled` sends `thinking: disabled` (see `gatewayComplete`). */
async function complete(spec: string, prompt: string) {
  const [model, flag] = spec.split(":");
  const { text, usage } = await gatewayComplete({
    prompt,
    model: model!,
    apiKey,
    disableThinking: flag === "disabled",
  });
  return { text, cost: usage.cost };
}

const workstreamOf = new Map(fixture.threads.map((t) => [t.id, t.workstream]));
function judge(route: RawRoute | null, expect: Expect) {
  if (!route) return { outcome: false, target: false, workstream: false };
  const outcomes = [expect.outcome].flat();
  const outcome = outcomes.includes(route.outcome);
  const target =
    outcome &&
    (route.outcome === "continue"
      ? !expect.threadId || route.threadId === expect.threadId
      : route.outcome === "new-thread"
        ? !expect.workstream || route.workstream === expect.workstream
        : route.outcome === "new-workstream"
          ? expect.code === undefined || route.code === expect.code
          : true);
  // Workstream-level: the work landed with the right workstream either way.
  const landed =
    route.outcome === "continue"
      ? workstreamOf.get(route.threadId)
      : route.outcome === "new-thread"
        ? route.workstream
        : null;
  const wanted =
    expect.workstream ??
    (expect.threadId ? workstreamOf.get(expect.threadId) : undefined);
  return {
    outcome,
    target,
    workstream: wanted ? landed === wanted : outcome,
  };
}

const report: Record<string, unknown> = {};
for (const model of models) {
  const results = [];
  let next = 0;
  const cases = fixture.cases;
  const out: unknown[] = new Array(cases.length);
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < cases.length) {
        const i = next++;
        const c = cases[i]!;
        const hidden = new Set(c.exclude ?? []);
        const input: RouteInput = {
          prompt: c.prompt,
          workstreams: fixture.workstreams,
          threads: fixture.threads.filter((t) => !hidden.has(t.id)),
          pickedProjectHosts: null,
        };
        const started = performance.now();
        let route: RawRoute | null = null;
        let cost = 0;
        let error: string | undefined;
        const mention = mentionedTarget(c.prompt);
        if (mention && "threadId" in mention)
          route = {
            outcome: "continue",
            threadId: mention.threadId,
            confidence: "high",
            reason: "mention",
            subject: null,
          };
        else
          try {
            const answer = await complete(model, routePrompt(input));
            cost = answer.cost;
            route = parseRoute(answer.text, input);
          } catch (e) {
            error = String(e);
          }
        out[i] = {
          id: c.id,
          expect: c.expect,
          route,
          error,
          seconds: (performance.now() - started) / 1000,
          cost,
          ...judge(route, c.expect),
        };
      }
    }),
  );
  results.push(...out);
  const rs = results as {
    id: string;
    outcome: boolean;
    target: boolean;
    workstream: boolean;
    seconds: number;
    cost: number;
    route: RawRoute | null;
  }[];
  const seconds = rs.map((r) => r.seconds).sort((a, b) => a - b);
  const summary = {
    cases: rs.length,
    outcome: `${rs.filter((r) => r.outcome).length}/${rs.length}`,
    target: `${rs.filter((r) => r.target).length}/${rs.length}`,
    workstream: `${rs.filter((r) => r.workstream).length}/${rs.length}`,
    newWorkstreams: rs.filter((r) => r.route?.outcome === "new-workstream")
      .length,
    unsure: rs.filter((r) => r.route?.outcome === "unsure").length,
    medianSeconds: seconds[Math.floor(seconds.length / 2)] ?? 0,
    cost: Number(rs.reduce((s, r) => s + r.cost, 0).toFixed(4)),
    misses: privateFile
      ? rs.filter((r) => !r.target).length
      : rs
          .filter((r) => !r.target)
          .map((r) => `${r.id} → ${JSON.stringify(r.route)}`),
  };
  report[model] = { summary, results };
  console.log(model, JSON.stringify(summary, null, 2));
}
if (env.EVAL_OUTPUT)
  await writeFile(env.EVAL_OUTPUT, JSON.stringify(report, null, 2));
