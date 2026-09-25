// Opt-in live evaluation; never part of the unit test suite.
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
  classifyBatch,
  normalizeGroups,
  mapConcurrent,
  BATCH_SIZE,
} from "../model.ts";
import { parsePiJson, piArgs } from "../pi.ts";

const fixture = process.env.EVAL_CASES ?? "cases.json";
const cases = JSON.parse(
  await readFile(
    fixture.startsWith("/") ? fixture : new URL(fixture, import.meta.url),
    "utf8",
  ),
);
if (
  fixture.startsWith("/") &&
  (!process.env.EVAL_OUTPUT ||
    !process.env.EVAL_PRIVATE_ROOT ||
    !resolve(process.env.EVAL_OUTPUT).startsWith(
      resolve(process.env.EVAL_PRIVATE_ROOT) + "/",
    ))
)
  throw new Error(
    "Private fixtures require EVAL_OUTPUT inside EVAL_PRIVATE_ROOT.",
  );
if (process.env.EVAL_REVERSE === "1") cases.reverse();
const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["openai/gpt-4.1-mini", "openai/gpt-4o-mini", "openai/gpt-4.1-nano"];
const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const accepted = (c, group) =>
  c.expected.some((name) => normalize(name) === normalize(group));
const contexts = cases.map(({ expected, ...c }) => ({
  ...c,
  updatedAt: 1,
  status: "idle",
}));

function complete(model, prompt) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "pi",
      piArgs(model),
      {
        cwd: tmpdir(),
        timeout: 120_000,
        maxBuffer: 4_000_000,
        env: { ...process.env, PI_OFFLINE: "1" },
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
const reports = [];
// Serial model trials keep total concurrent requests within the product limit.
for (const model of models) {
  const start = performance.now();
  const report = {
    model,
    fixture,
    reversed: process.env.EVAL_REVERSE === "1",
    cases: cases.length,
    calls: 0,
    tokens: 0,
    cost: 0,
    responses: [],
  };
  try {
    const batches = [];
    const size = Number(process.env.EVAL_BATCH) || BATCH_SIZE;
    for (let i = 0; i < contexts.length; i += size)
      batches.push(contexts.slice(i, i + size));
    const items = (
      await mapConcurrent(batches, async (batch) => {
        report.calls++;
        return classifyBatch(batch, async (prompt) => {
          const { text, usage } = await complete(model, prompt);
          report.tokens += usage.input + usage.output;
          report.cost += usage.cost;
          report.responses.push({ ids: batch.map((t) => t.id), text });
          return text;
        });
      })
    ).flat();
    const normalized = normalizeGroups(items);
    report.results = items.map((item, i) => {
      const fixture = cases.find((c) => c.id === item.threadId);
      const group = normalized[i].group;
      return {
        id: item.threadId,
        expected: fixture.expected,
        first: item.group,
        final: group,
        firstCorrect: accepted(fixture, item.group),
        finalCorrect: accepted(fixture, group),
        title: item.title,
        recap: item.recap,
      };
    });
    report.firstCorrect = report.results.filter((r) => r.firstCorrect).length;
    report.finalCorrect = report.results.filter((r) => r.finalCorrect).length;
    const pairs = { together: 0, recovered: 0, unrelated: 0, wronglyMerged: 0 };
    for (let i = 0; i < report.results.length; i++) {
      for (let j = i + 1; j < report.results.length; j++) {
        const a = report.results[i],
          b = report.results[j];
        const sameExpected = a.expected.some((name) =>
          b.expected.some((other) => normalize(name) === normalize(other)),
        );
        const sameActual = normalize(a.final) === normalize(b.final);
        if (sameExpected) {
          pairs.together++;
          if (sameActual) pairs.recovered++;
        } else {
          pairs.unrelated++;
          if (sameActual) pairs.wronglyMerged++;
        }
      }
    }
    report.pairs = pairs;
  } catch (error) {
    report.error = String(error);
  }
  report.seconds = Math.round((performance.now() - start) / 100) / 10;
  reports.push(report);
  console.log(
    JSON.stringify(
      fixture.startsWith("/")
        ? {
            model,
            cases: report.cases,
            firstCorrect: report.firstCorrect,
            finalCorrect: report.finalCorrect,
            seconds: report.seconds,
            tokens: report.tokens,
            cost: report.cost,
            pairs: report.pairs,
            error: report.error,
          }
        : report,
    ),
  );
}
if (process.env.EVAL_OUTPUT)
  await writeFile(process.env.EVAL_OUTPUT, JSON.stringify(reports, null, 2));
