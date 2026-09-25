// Opt-in live evaluation; never part of the unit test suite. See README.md.
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
  classifyBatch,
  normalizeGroups,
  applyDrift,
  mapConcurrent,
  BATCH_SIZE,
  UNCLASSIFIED,
  knownGroups,
} from "../model.ts";
import { parsePiJson, piArgs } from "../pi.ts";
import { judgePrompt, parseJudgment } from "./judge.ts";
import { detectDrift } from "../drift.ts";

const env = process.env;
const fixture = env.EVAL_CASES ?? "cases.json";
const privateFixture = fixture.startsWith("/");
const cases = JSON.parse(
  await readFile(
    privateFixture ? fixture : new URL(fixture, import.meta.url),
    "utf8",
  ),
);
if (
  privateFixture &&
  (!env.EVAL_OUTPUT ||
    !env.EVAL_PRIVATE_ROOT ||
    !resolve(env.EVAL_OUTPUT).startsWith(resolve(env.EVAL_PRIVATE_ROOT) + "/"))
)
  throw new Error(
    "Private fixtures require EVAL_OUTPUT inside EVAL_PRIVATE_ROOT.",
  );
if (env.EVAL_REVERSE === "1") cases.reverse();
const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["openai/gpt-4.1-mini"];
const runs = Number(env.EVAL_RUNS) || 1;
const seed = env.EVAL_SEED === "1";
const batchSize = Number(env.EVAL_BATCH) || BATCH_SIZE;
const judgeModel = env.EVAL_JUDGE; // e.g. openai/gpt-4.1-mini; unset skips recap scoring
const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const contexts = cases.map(({ expected, ...c }) => ({
  status: "idle",
  updatedAt: 1,
  path: null,
  repository: null,
  timeline: "",
  ...c,
}));
const byId = new Map(cases.map((c) => [c.id, c]));

function complete(model, prompt) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "pi",
      piArgs(model),
      {
        cwd: tmpdir(),
        timeout: 120_000,
        maxBuffer: 4_000_000,
        env: { ...env, PI_OFFLINE: "1" },
      },
      (error, stdout) => {
        if (error) return reject(new Error(`Inference failed for ${model}`));
        try {
          resolve(parsePiJson(stdout));
        } catch (e) {
          reject(e);
        }
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

function batches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

function score(results) {
  const pairs = { together: 0, recovered: 0, unrelated: 0, wronglyMerged: 0 };
  for (let i = 0; i < results.length; i++)
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i],
        b = results[j];
      const same = a.expected.some((x) =>
        b.expected.some((y) => normalize(x) === normalize(y)),
      );
      const merged = normalize(a.group) === normalize(b.group);
      if (same) {
        pairs.together++;
        if (merged) pairs.recovered++;
      } else {
        pairs.unrelated++;
        if (merged) pairs.wronglyMerged++;
      }
    }
  const expectedNames = new Set(
    results.flatMap((r) => r.expected.map(normalize)),
  );
  // Drift is scored only where a case declares it: an object is a side quest,
  // null is a healthy thread. Other detections are listed for manual review.
  const labeled = results.filter((r) => r.expectedDrift !== undefined);
  const drifted = labeled.filter((r) => r.expectedDrift);
  const healthy = labeled.filter((r) => r.expectedDrift === null);
  const drift = labeled.length
    ? {
        detected: `${drifted.filter((r) => r.drift).length}/${drifted.length}`,
        fromCorrect: drifted.filter(
          (r) =>
            r.drift &&
            r.expectedDrift.from.some((n) =>
              normalize(r.drift.from).startsWith(normalize(n)),
            ),
        ).length,
        seqCorrect: drifted.filter(
          (r) =>
            r.drift &&
            (r.expectedDrift.splitSeq === undefined ||
              r.drift.splitSeq === r.expectedDrift.splitSeq),
        ).length,
        highConfidence: drifted.filter((r) => r.drift?.confidence === "high")
          .length,
        // Detections on threads not labeled either way, by confidence.
        unlabeledHigh: results.filter(
          (r) =>
            r.expectedDrift === undefined && r.drift?.confidence === "high",
        ).length,
        falseSplits: `${healthy.filter((r) => r.drift && r.drift.confidence !== "low").length}/${healthy.length}`,
        unlabeledDetections: results.filter(
          (r) => r.expectedDrift === undefined && r.drift,
        ).length,
      }
    : undefined;
  return {
    drift,
    correct: results.filter((r) => r.correct).length,
    pairs,
    groups: new Set(results.map((r) => normalize(r.group))).size,
    unclassified: results.filter((r) => r.group === UNCLASSIFIED).length,
    // Labels like "BB Pi Provider" that split a product into sub-products.
    bbSplits: results.filter(
      (r) => /^bb\b./i.test(r.group) && !expectedNames.has(normalize(r.group)),
    ).length,
  };
}

async function judge(results, usage) {
  const scored = (
    await mapConcurrent(batches(results, 8), async (batch) => {
      const records = batch.map((r, i) => ({
        id: String(i + 1),
        excerpts: byId.get(r.id).excerpts,
        title: r.title,
        recap: r.recap,
      }));
      const { text, usage: u } = await complete(
        judgeModel,
        judgePrompt(records),
      );
      usage.tokens += u.input + u.output;
      usage.cost += u.cost;
      return parseJudgment(
        text,
        records.map((r) => r.id),
      ).map((j) => ({ ...j, id: batch[Number(j.id) - 1].id }));
    })
  ).flat();
  const n = scored.length;
  const flagged = scored.filter((j) => j.needsYou);
  const byThread = new Map(results.map((r) => [r.id, r]));
  return {
    what: Math.round((scored.reduce((s, j) => s + j.what, 0) / n) * 100) / 100,
    stop: Math.round((scored.reduce((s, j) => s + j.stop, 0) / n) * 100) / 100,
    drift: scored.filter((j) => j.drift).length,
    needsYouAgreement: scored.filter(
      (j) => j.needsYou === byThread.get(j.id).needsYou,
    ).length,
    needsYouFlagged: results.filter((r) => r.needsYou).length,
    needsYouRecall: `${flagged.filter((j) => byThread.get(j.id).needsYou).length}/${flagged.length}`,
    items: scored,
  };
}

const reports = [];
for (const model of models) {
  const report = {
    model,
    fixture,
    reversed: env.EVAL_REVERSE === "1",
    seeded: seed,
    cases: cases.length,
    runs: [],
  };
  let previous = null;
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    const usage = { calls: 0, tokens: 0, cost: 0 };
    const known =
      seed && previous
        ? knownGroups({
            items: previous.results.map((r) => ({ group: r.group })),
          })
        : [];
    const entry = { run, seededWith: known.length };
    try {
      const call = async (prompt) => {
        usage.calls++;
        const { text, usage: u } = await complete(model, prompt);
        usage.tokens += u.input + u.output;
        usage.cost += u.cost;
        return text;
      };
      const items = (
        await mapConcurrent(batches(contexts, batchSize), async (batch) => {
          const [classified, drifts] = await Promise.all([
            classifyBatch(batch, call, known),
            detectDrift(batch, call),
          ]);
          return classified.map((i) =>
            applyDrift({ ...i, drift: drifts.get(i.threadId) ?? null }),
          );
        })
      ).flat();
      entry.results = normalizeGroups(items).map((item) => {
        const c = byId.get(item.threadId);
        return {
          id: item.threadId,
          expected: c.expected,
          group: item.group,
          correct: c.expected.some(
            (name) => normalize(name) === normalize(item.group),
          ),
          title: item.title,
          recap: item.recap,
          needsYou: item.needsYou,
          state: item.state,
          drift: item.drift ?? null,
          expectedDrift: c.drift,
        };
      });
      Object.assign(entry, score(entry.results));
      if (previous) {
        const before = new Map(previous.results.map((r) => [r.id, r.group]));
        entry.stableWithPrevious = entry.results.filter(
          (r) => normalize(before.get(r.id) ?? "") === normalize(r.group),
        ).length;
      }
      entry.needsYou = entry.results.filter((r) => r.needsYou).length;
      if (judgeModel && run === runs - 1)
        entry.recap = await judge(entry.results, usage);
      previous = entry;
    } catch (error) {
      entry.error = String(error);
    }
    entry.seconds = Math.round((performance.now() - start) / 100) / 10;
    Object.assign(entry, usage);
    report.runs.push(entry);
    const { results, recap, ...summary } = entry;
    // Private fixtures print aggregates only; details go to EVAL_OUTPUT.
    console.log(
      JSON.stringify({
        model,
        ...summary,
        ...(recap ? { recap: { ...recap, items: undefined } } : {}),
        ...(privateFixture
          ? {}
          : {
              misses: results
                ?.filter((r) => !r.correct)
                .map((r) => `${r.id}: ${r.group}`),
            }),
      }),
    );
  }
  reports.push(report);
}
if (env.EVAL_OUTPUT)
  await writeFile(env.EVAL_OUTPUT, JSON.stringify(reports, null, 2));
