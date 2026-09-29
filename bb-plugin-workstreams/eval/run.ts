/**
 * Live evaluation of the per-thread analysis prompt (SPEC §10). Opt-in and
 * never part of `npm test`: it calls models through Pi's AI Gateway.
 *
 *   node eval/run.ts [model ...]
 *
 * Every case goes through the production prompt (`analysisPrompt`) and parser.
 * Fixtures may carry a `project` field for provenance; it is never sent.
 * See README.md for fixtures, modes, and the pass bar.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  analysisPrompt,
  parseAnalysis,
  type AnalysisInput,
  type AnalysisOutput,
} from "../src/domain/analysis.ts";
import { parsePiJson, piArgs } from "../src/server/inference/pi.ts";

type Case = {
  id: string;
  title: string;
  project?: string;
  excerpts: string;
  expected: string[];
  expectedState?: AnalysisOutput["state"];
  drift?: { from: string[] } | null;
};
type Result = {
  set: string;
  mode: "cold" | "warm";
  id: string;
  expected: string[];
  project?: string;
  output: AnalysisOutput | null;
  error?: string;
  seconds: number;
  cost: number;
  expectedState?: string;
  driftExpected?: boolean;
};

const env = process.env;
const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["google/gemini-3.1-flash-lite", "openai/gpt-4.1-mini"];
const PUBLIC = ["cases", "holdout", "delegation", "state", "drift"];
const privateSet = env.EVAL_PRIVATE;
if (privateSet) {
  const root = env.EVAL_PRIVATE_ROOT;
  if (
    !root ||
    !env.EVAL_OUTPUT ||
    !resolve(env.EVAL_OUTPUT).startsWith(resolve(root) + "/")
  )
    throw new Error(
      "A private fixture needs EVAL_OUTPUT inside EVAL_PRIVATE_ROOT, so real thread content never leaves private storage.",
    );
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const NO_SUBJECT = new Set(["unclassified", "crossprojectcoordination"]);

/** Splits a fixture excerpt into requests and the last assistant message. */
export function toInput(
  c: Case,
  warm?: { own: string; others: string[] },
): AnalysisInput {
  const requests: AnalysisInput["requests"][number][] = [];
  let lastAssistantText: string | null = null;
  const sections = c.excerpts.split(
    /\n\n(?=Initial user request|Recent user request|Last assistant report)/,
  );
  if (sections.length > 1 || /^Initial user request/.test(c.excerpts)) {
    for (const section of sections) {
      const body = section.replace(/^[^\n]*:\n/, "").trim();
      if (section.startsWith("Initial user request"))
        requests.push({ text: body, initial: true });
      else if (section.startsWith("Recent user request"))
        requests.push({ text: body, initial: false });
      else if (section.startsWith("Last assistant report"))
        lastAssistantText = body;
    }
  } else if (c.excerpts.trim()) {
    const [user, ...rest] = c.excerpts.split(/\s+Assistant:\s+/);
    requests.push({ text: user!.replace(/^User:\s*/, ""), initial: false });
    lastAssistantText = rest.join(" Assistant: ") || null;
  }
  return {
    title: c.title,
    workstream: warm
      ? { name: warm.own, description: null, subjects: [] }
      : null,
    otherWorkstreams: warm ? warm.others : null,
    // Keep the most recent two requests, as production does.
    requests: [
      ...requests.filter((r) => r.initial).slice(0, 1),
      ...requests.filter((r) => !r.initial).slice(-2),
    ],
    lastAssistantText,
  };
}

function complete(model: string, prompt: string) {
  return new Promise<{ text: string; cost: number }>((done, fail) => {
    const child = execFile(
      "pi",
      piArgs(model),
      {
        cwd: tmpdir(),
        timeout: 90_000,
        maxBuffer: 4_000_000,
        env: { ...env, PI_OFFLINE: "1" },
      },
      (error, stdout) => {
        if (error) return fail(new Error(`Pi failed for ${model}`));
        try {
          const { text, usage } = parsePiJson(stdout);
          done({ text, cost: usage.cost });
        } catch (e) {
          fail(e as Error);
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  });
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const subjectOk = (r: Result) => {
  const subject = r.output?.subject ?? null;
  if (subject === null) return r.expected.some((e) => NO_SUBJECT.has(norm(e)));
  return r.expected.some((e) => norm(e) === norm(subject));
};
/** Only high-confidence drift is surfaced to the user (SPEC §10). */
const driftFlag = (r: Result) => r.output?.drift?.confidence === "high";
const pct = (n: number, d: number) => (d ? `${n}/${d}` : "–");

function score(results: Result[]) {
  const cold = results.filter((r) => r.mode === "cold");
  const warm = results.filter((r) => r.mode === "warm");
  const bySet = (set: string) => cold.filter((r) => r.set === set);
  const ok = (rs: Result[]) => rs.filter(subjectOk).length;
  const valid = results.filter((r) => r.output).length;
  let together = 0;
  let recovered = 0;
  let apart = 0;
  let merged = 0;
  for (const set of new Set(cold.map((r) => r.set)))
    for (const [i, a] of bySet(set).entries())
      for (const b of bySet(set).slice(i + 1)) {
        const same = a.expected.some((x) =>
          b.expected.some((y) => norm(x) === norm(y)),
        );
        const joined =
          !!a.output?.subject &&
          norm(a.output.subject) === norm(b.output?.subject ?? "");
        if (same) {
          together++;
          if (joined) recovered++;
        } else {
          apart++;
          if (joined) merged++;
        }
      }
  const anchored = cold.filter(
    (r) =>
      r.project &&
      r.output?.subject &&
      norm(r.output.subject) === norm(r.project) &&
      !r.expected.some((e) => norm(e) === norm(r.project!)),
  );
  const stated = cold.filter((r) => r.expectedState);
  const decisions = stated.filter((r) => r.expectedState === "needs_decision");
  const drifted = warm.filter((r) => r.driftExpected);
  const healthy = warm.filter((r) => !r.driftExpected);
  const seconds = results.map((r) => r.seconds).sort((a, b) => a - b);
  const q = (p: number) =>
    seconds[Math.min(seconds.length - 1, Math.floor(p * seconds.length))] ?? 0;
  return {
    valid: pct(valid, results.length),
    subject: Object.fromEntries(
      [...new Set(cold.map((r) => r.set))].map((set) => [
        set,
        pct(ok(bySet(set)), bySet(set).length),
      ]),
    ),
    pairs: `recovered ${pct(recovered, together)}, wrongly merged ${pct(merged, apart)}`,
    anchoredOnProject: anchored.map((r) => r.id),
    state: pct(
      stated.filter((r) => r.output?.state === r.expectedState).length,
      stated.length,
    ),
    needsDecisionRecall: pct(
      decisions.filter((r) => r.output?.state === "needs_decision").length,
      decisions.length,
    ),
    drift: {
      detected: pct(drifted.filter(driftFlag).length, drifted.length),
      falseAlarms: pct(healthy.filter(driftFlag).length, healthy.length),
      falseAlarmIds: healthy.filter(driftFlag).map((r) => `${r.set}:${r.id}`),
    },
    medianSeconds: q(0.5),
    p90Seconds: q(0.9),
    cost: Number(results.reduce((s, r) => s + r.cost, 0).toFixed(4)),
    misses: cold
      .filter((r) => !subjectOk(r))
      .map(
        (r) =>
          `${r.set}:${r.id} → ${r.output?.subject ?? "null"} (want ${r.expected[0]})`,
      ),
  };
}

const sets: [string, Case[]][] = [];
for (const name of PUBLIC)
  sets.push([
    name,
    JSON.parse(
      await readFile(new URL(`${name}.json`, import.meta.url), "utf8"),
    ),
  ]);
if (privateSet)
  sets.push(["private", JSON.parse(await readFile(privateSet, "utf8"))]);

// Warm mode files each case under a workstream and offers the others as
// drift targets: its original product for a side quest, its own otherwise.
const pool = [
  ...new Set(sets.flatMap(([, cs]) => cs.map((c) => c.expected[0]!))),
];
type Job = { set: string; mode: Result["mode"]; c: Case; input: AnalysisInput };
const jobs: Job[] = [];
for (const [set, cases] of sets)
  for (const c of cases) {
    if (set !== "drift") jobs.push({ set, mode: "cold", c, input: toInput(c) });
    if (set === "drift" || set === "private" || set === "cases") {
      const own = c.drift ? c.drift.from[0]! : c.expected[0]!;
      if (NO_SUBJECT.has(norm(own))) continue;
      // Aliases of the case's own product aren't "other" workstreams.
      const aliases = new Set([own, ...c.expected].map(norm));
      const others = pool.filter(
        (n) => !aliases.has(norm(n)) && !NO_SUBJECT.has(norm(n)),
      );
      jobs.push({ set, mode: "warm", c, input: toInput(c, { own, others }) });
    }
  }

const report: Record<string, unknown> = {};
for (const model of models) {
  const results = await mapLimit(jobs, 4, async (job): Promise<Result> => {
    const started = performance.now();
    const base = {
      set: job.set,
      mode: job.mode,
      id: job.c.id,
      expected: job.c.expected,
      project: job.c.project,
      expectedState: job.c.expectedState,
      driftExpected: job.mode === "warm" ? Boolean(job.c.drift) : undefined,
    };
    try {
      const { text, cost } = await complete(model, analysisPrompt(job.input));
      return {
        ...base,
        output: parseAnalysis(text, job.input),
        seconds: (performance.now() - started) / 1000,
        cost,
      };
    } catch (error) {
      return {
        ...base,
        output: null,
        error: String(error),
        seconds: (performance.now() - started) / 1000,
        cost: 0,
      };
    }
  });
  report[model] = { score: score(results), results };
  console.log(model, JSON.stringify(score(results), null, 2));
}
if (env.EVAL_OUTPUT)
  await writeFile(env.EVAL_OUTPUT, JSON.stringify(report, null, 2));
