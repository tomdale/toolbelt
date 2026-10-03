import { writeFile, readFile } from "node:fs/promises";
import { classifyPrompt, parseClassification } from "../src/domain/classify.ts";
import {
  gatewayKey,
  gatewayComplete,
} from "../src/server/inference/gateway.ts";
import { scoreClassification } from "./classification-score.ts";
import { cases } from "./classification-cases.ts";
const apiKey = await gatewayKey();
if (!apiKey) throw new Error("AI Gateway authentication required");
const model = process.env.EVAL_MODEL ?? "google/gemini-3.8-flash";
const baseline = process.env.EVAL_BASELINE
  ? await readFile(process.env.EVAL_BASELINE, "utf8")
  : null;
const results: {
  id: string;
  pass: boolean;
  exact?: boolean;
  owner?: boolean;
  capability?: boolean;
  hierarchy?: boolean;
  expected?: string | null;
  value?: ReturnType<typeof parseClassification>;
  response?: string;
  expectedPath?: string[];
  cost?: number;
  error?: string;
}[] = [];
const repetitions = Number(process.env.EVAL_REPETITIONS ?? 1);
const controller = new AbortController();
setTimeout(() => controller.abort(), 240_000).unref();
const selectedCases = process.env.EVAL_HOLDOUT
  ? cases.filter((c) => c.id.startsWith("holdout-"))
  : cases.filter((c) => !c.id.startsWith("holdout-"));
const queue = Array.from({ length: repetitions }, () => selectedCases).flat();
let cursor = 0;
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (cursor < queue.length) {
      const original = queue[cursor++]!;
      const test = process.env.EVAL_COLD
        ? { ...original, input: { ...original.input, entities: [] } }
        : original;
      const prompt = baseline
        ? baseline.replace(
            "__EVIDENCE__",
            classifyPrompt(test.input).split(
              "Catalog indentation expresses parentage; bracketed IDs identify existing entries.",
            )[1]!,
          )
        : classifyPrompt(test.input);
      try {
        const result = await gatewayComplete({
          apiKey,
          signal: controller.signal,
          model,
          prompt,
          maxTokens: 4096,
        });
        const value = parseClassification(result.text, test.input);
        results.push({
          id: test.id,
          expected: test.expected,
          value,
          response: result.text,
          expectedPath: (() => {
            const path: string[] = [];
            let id: string | null = test.expected;
            while (id) {
              const e = original.input.entities.find((e) => e.id === id)!;
              path.unshift(e.name);
              id = e.parentId;
            }
            return path;
          })(),
          ...scoreClassification(
            value,
            original.input,
            test.expected,
            !!process.env.EVAL_COLD,
          ),
          cost: result.usage?.cost,
        });
      } catch (error) {
        results.push({ id: test.id, pass: false, error: String(error) });
      }
    }
  }),
);
await writeFile(
  process.env.EVAL_OUTPUT ?? "/tmp/classification-eval.json",
  JSON.stringify(
    {
      model,
      mode: process.env.EVAL_COLD ? "cold" : "warm",
      split: process.env.EVAL_HOLDOUT ? "holdout" : "main",
      repetitions,
      acceptedHierarchy: results.filter((r) => r.pass).length,
      exactMatches: results.filter((r) => "exact" in r && r.exact).length,
      total: results.length,
      results,
    },
    null,
    2,
  ),
);
console.log(
  `${results.filter((r) => r.pass).length}/${results.length} ${model}`,
);
