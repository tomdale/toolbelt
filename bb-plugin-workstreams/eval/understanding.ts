import { writeFile } from "node:fs/promises";
import {
  extractionPrompt,
  parseExtraction,
  synthesisPrompt,
  parseSynthesis,
} from "../src/domain/understanding.ts";
import { routePrompt, parseRoute } from "../src/domain/router.ts";
import { analysisPrompt, parseAnalysis } from "../src/domain/analysis.ts";
import {
  gatewayComplete,
  gatewayKey,
} from "../src/server/inference/gateway.ts";
import {
  observationId,
  type Observation,
} from "../src/domain/understanding.ts";

// Synthetic conversations exercise cross-thread scope changes without indexing
// private user history. This is an opt-in live-model evaluation, not a unit test.
const model = process.argv[2] ?? "google/gemini-3.1-flash-lite";
const key = await gatewayKey();
if (!key) throw new Error("AI Gateway credentials are unavailable.");
const observations: Observation[] = [];
const calls: {
  stage: string;
  value: unknown;
  cost: number;
  latencyMs: number;
}[] = [];
const cases = [
  {
    threadId: "synthetic-recap",
    entries: [
      {
        id: "old-user",
        speaker: "user" as const,
        text: "Recap is a separate plugin that summarizes returning developers' threads. Keep it independently developed for now.",
        at: 1_700_000_000_000,
      },
      {
        id: "old-assistant",
        speaker: "assistant" as const,
        text: "I implemented the Recap card in bb-plugin-recap. Tests passed.",
        at: 1_700_000_001_000,
      },
    ],
  },
  {
    threadId: "synthetic-workstreams",
    entries: [
      {
        id: "new-user",
        speaker: "user" as const,
        text: "We have integrated Recap's interface and implementation into Workstreams. Recap card improvements belong to Workstreams work. Recap is still the name of the summary capability, not a separate product.",
        at: 1_710_000_000_000,
      },
      {
        id: "new-assistant",
        speaker: "assistant" as const,
        text: "The Recap interface is in bb-plugin-workstreams. I have not verified whether the old package is still published independently.",
        at: 1_710_000_001_000,
      },
    ],
  },
];
for (const c of cases) {
  const input = { entries: c.entries };
  const start = Date.now();
  const answer = await gatewayComplete({
    prompt: extractionPrompt(input),
    model,
    apiKey: key,
  });
  const value = parseExtraction(answer.text, input.entries);
  observations.push(
    ...value.map((o) => ({
      ...o,
      id: observationId(c.threadId, o.entryId, o.observation),
      threadId: c.threadId,
      sourceAt: c.entries.find((e) => e.id === o.entryId)?.at ?? null,
    })),
  );
  calls.push({
    stage: `extract ${c.threadId}`,
    value,
    cost: answer.usage.cost,
    latencyMs: Date.now() - start,
  });
}
if (!observations.some((o) => o.entryId === "new-user"))
  throw new Error("Extraction lost the explicit integration evidence.");
const synthesisInput = { observations, previous: [] };
let start = Date.now();
const synthesized = await gatewayComplete({
  prompt: synthesisPrompt(synthesisInput),
  model,
  apiKey: key,
});
const synthesis = {
  accounts: parseSynthesis(
    synthesized.text,
    new Set(observations.map((o) => o.id)),
  ),
};
calls.push({
  stage: "synthesis",
  value: synthesis,
  cost: synthesized.usage.cost,
  latencyMs: Date.now() - start,
});
if (!synthesis.accounts.length)
  throw new Error("No grounded account was synthesized.");
const routeInput = {
  prompt: "Improve the spacing in the recap summary cards",
  workstreams: [
    {
      name: "BB Recap",
      description: "Standalone thread recap plugin",
      subjects: ["Recap"],
    },
    {
      name: "Workstreams",
      description: "Thread organization and overview",
      subjects: ["Workstreams"],
    },
  ],
  threads: [],
  pickedProjectHosts: null,
  understanding: JSON.stringify({ accounts: synthesis.accounts, observations }),
};
start = Date.now();
const routed = await gatewayComplete({
  prompt: routePrompt(routeInput),
  model,
  apiKey: key,
});
const route = parseRoute(routed.text, routeInput);
calls.push({
  stage: "route",
  value: route,
  cost: routed.usage.cost,
  latencyMs: Date.now() - start,
});
const analysisInput = {
  title: "Improve recap cards",
  workstream: {
    name: "Workstreams",
    description: "Thread organization",
    subjects: ["Workstreams"],
  },
  otherWorkstreams: ["BB Recap"],
  requests: [
    { text: "Improve recap-card spacing in Workstreams.", initial: false },
  ],
  lastAssistantText:
    "The spacing fix is complete and verified. Tests pass; there is no remaining work in this request.",
  understanding: `${routeInput.understanding}\nHistorical unrelated task: blocked awaiting credentials; user needs to approve deployment. This is not the current thread's state.`,
};
start = Date.now();
const analyzed = await gatewayComplete({
  prompt: analysisPrompt(analysisInput),
  model,
  apiKey: key,
});
const analysis = parseAnalysis(analyzed.text, analysisInput);
calls.push({
  stage: "analysis precedence",
  value: analysis,
  cost: analyzed.usage.cost,
  latencyMs: Date.now() - start,
});
const passed =
  route.outcome === "new-thread" &&
  route.workstream === "Workstreams" &&
  analysis.subject === "Workstreams" &&
  analysis.drift === null &&
  analysis.state === "done" &&
  analysis.needsYou === null;
const report = {
  model,
  passed,
  calls,
  cost: calls.reduce((sum, c) => sum + c.cost, 0),
};
if (process.env.EVAL_OUTPUT)
  await writeFile(process.env.EVAL_OUTPUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
