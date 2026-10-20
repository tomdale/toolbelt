import { writeFile } from "node:fs/promises";
import {
  fullAnalysisPrompt,
  parseFullAnalysis,
  type FullAnalysisInput,
} from "../src/domain/analysis.ts";
import {
  settleIdentity,
  type ThreadObjective,
} from "../src/domain/identity.ts";
import {
  gatewayKey,
  gatewayComplete,
} from "../src/server/inference/gateway.ts";

/** Paid, synthetic multi-turn identity gate; no plugin facts are mutated. */
const apiKey = await gatewayKey();
if (!apiKey) throw new Error("AI Gateway authentication required");
const model = process.env.EVAL_MODEL ?? "openai/gpt-6-luna-fast";
const steps = [
  { request: "Help with the pipeline", expected: "establish" },
  {
    request:
      "Specifically, audit the release pipeline and propose a reliability plan; do not implement it",
    expected: "refine",
  },
  {
    request: "As part of that audit, diagnose why schema verification fails",
    expected: "keep",
  },
  {
    request:
      "Run the verification tests and include their results in the audit",
    expected: "keep",
  },
  {
    request:
      "Change direction: leave the release pipeline and implement the billing workflow",
    expected: "pivot",
  },
];
let objective: ThreadObjective | null = null;
const requests: FullAnalysisInput["requests"][number][] = [];
const results = [];
for (const [i, step] of steps.entries()) {
  requests.push({
    id: `request-${i + 1}`,
    text: step.request,
    initial: i === 0,
  });
  const input: FullAnalysisInput = {
    title: objective?.title ?? "Untitled",
    previousObjective: objective,
    previousGoal: objective?.title,
    requests,
    lastAssistantText: "Working on the requested step",
    report: { state: "waiting", headline: "Working", latest: [] },
    mode: "full",
  };
  const previous = objective;
  const completion = await gatewayComplete({
    apiKey,
    model,
    reasoningLevel: "none",
    prompt: fullAnalysisPrompt(input),
    signal: AbortSignal.timeout(60_000),
  });
  const parsed = parseFullAnalysis(completion.text, input);
  const settled = settleIdentity({
    previous,
    candidate: parsed.identity,
    requestIds: requests.map((r) => r.id!),
  });
  objective = settled.objective;
  const pass =
    objective !== null &&
    (step.expected === "keep"
      ? objective.title === previous?.title &&
        objective.summary === previous?.summary
      : step.expected === "pivot"
        ? settled.decision === "pivot"
        : step.expected === "refine"
          ? settled.decision === "refine"
          : settled.decision === "established");
  results.push({
    expected: step.expected,
    pass,
    decision: settled.decision,
    objective,
    response: completion.text,
    cost: completion.usage.cost,
  });
}
await writeFile(
  process.env.EVAL_OUTPUT ?? "/tmp/identity-eval.json",
  JSON.stringify({ model, results }, null, 2),
);
console.log(
  `${results.filter((r) => r.pass).length}/${results.length} identity transitions`,
);
if (results.some((r) => !r.pass)) process.exitCode = 1;
