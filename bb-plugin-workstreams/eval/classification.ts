import { writeFile, readFile } from "node:fs/promises";
import { classifyPrompt, parseClassification } from "../src/domain/classify.ts";
import {
  gatewayKey,
  gatewayComplete,
} from "../src/server/inference/gateway.ts";
import { cases } from "./classification-cases.ts";
const apiKey = await gatewayKey();
if (!apiKey) throw new Error("AI Gateway authentication required");
const model = process.env.EVAL_MODEL ?? "google/gemini-3.8-flash";
const baseline = process.env.EVAL_BASELINE
  ? await readFile(process.env.EVAL_BASELINE, "utf8")
  : null;
const results = [];
const controller = new AbortController();
setTimeout(() => controller.abort(), 240_000).unref();
for (const original of cases) {
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
      pass: process.env.EVAL_COLD
        ? test.expected === null
          ? !value.subjectId && !value.proposed
          : [
              ...(value.proposed?.ancestors ?? []).map((a) => a.name),
              value.proposed?.name,
            ]
              .filter(Boolean)
              .join("/")
              .toLowerCase() ===
            (() => {
              const path: string[] = [];
              let id: string | null = test.expected;
              while (id) {
                const e = original.input.entities.find((e) => e.id === id)!;
                path.unshift(e.name);
                id = e.parentId;
              }
              return path.join("/").toLowerCase();
            })()
        : value.subjectId === test.expected && !value.proposed,
      cost: result.usage?.cost,
    });
  } catch (error) {
    results.push({ id: test.id, pass: false, error: String(error) });
  }
}
await writeFile(
  process.env.EVAL_OUTPUT ?? "/tmp/classification-eval.json",
  JSON.stringify(
    {
      model,
      passed: results.filter((r) => r.pass).length,
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
