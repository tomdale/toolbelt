import { writeFile } from "node:fs/promises";
import {
  fullAnalysisPrompt,
  parseFullAnalysis,
  quickAnalysisPrompt,
  parseQuickAnalysis,
  quickAnalysisSchema,
  type FullAnalysisInput,
} from "../src/domain/analysis.ts";
import type { TopicAnswer } from "../src/domain/classify.ts";
import {
  gatewayKey,
  gatewayComplete,
} from "../src/server/inference/gateway.ts";
import { scoreClassification } from "./classification-score.ts";
import { cases } from "./classification-cases.ts";

/** Paid contract evaluation; it never applies model results to the plugin. */
const apiKey = await gatewayKey();
if (!apiKey) throw new Error("AI Gateway authentication required");
const model = process.env.EVAL_MODEL ?? "google/gemini-3.8-flash";
const kind = process.env.EVAL_KIND ?? "full";
const reasoningLevel =
  process.env.EVAL_REASONING_LEVEL ?? (kind === "quick" ? "none" : undefined);
if (kind !== "quick" && kind !== "full")
  throw new Error("EVAL_KIND must be quick or full");
const repetitions = Number(process.env.EVAL_REPETITIONS ?? 1);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
  throw new Error("EVAL_REPETITIONS must be between 1 and 20");
const cold = process.env.EVAL_COLD === "1";
const holdout = process.env.EVAL_HOLDOUT === "1";
const only = process.env.EVAL_ONLY ? new RegExp(process.env.EVAL_ONLY) : null;
const queue = Array.from({ length: repetitions }, () =>
  cases.filter((c) =>
    only
      ? only.test(c.id)
      : c.id.startsWith("holdout-") === holdout && !(cold && c.warmOnly),
  ),
).flat();
const results: Record<string, unknown>[] = [];
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 240_000);
let cursor = 0;
try {
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (cursor < queue.length) {
        const test = queue[cursor++]!;
        const entities = cold ? [] : test.input.entities;
        const requests = (test.input.requests ?? [test.input.prompt]).map(
          (text, i) => ({ text, initial: i === 0, id: `request-${i + 1}` }),
        );
        const full: FullAnalysisInput = {
          title: test.input.prompt,
          requests,
          lastAssistantText: null,
          report: null,
          mode: "full",
          topic: {
            entities,
            project: test.input.project ?? null,
            current: null,
          },
        };
        const quick = {
          request: requests.map((r) => r.text).join("\n\n"),
          entities,
          project: test.input.project,
        };
        const prompt =
          kind === "quick"
            ? quickAnalysisPrompt(quick)
            : fullAnalysisPrompt(full);
        const started = Date.now();
        let response: string | null = null;
        let cost: number | undefined;
        const expectedPath: string[] = [];
        let ancestor = test.expected;
        while (ancestor) {
          const e = test.input.entities.find((e) => e.id === ancestor)!;
          expectedPath.unshift(e.name);
          ancestor = e.parentId;
        }
        try {
          const completion = await gatewayComplete({
            apiKey,
            signal: controller.signal,
            model,
            prompt,
            maxTokens: 4096,
            reasoningLevel,
            outputSchema:
              kind === "quick" ? quickAnalysisSchema(quick) : undefined,
          });
          response = completion.text;
          cost = completion.usage.cost;
          let retried = false;
          if (kind === "quick" && process.env.EVAL_RETRY === "1") {
            // EXPERIMENT: one retry when the named owner and the chosen topic disagree.
            const norm = (x: string) =>
              x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
            const first = JSON.parse(response) as {
              owner?: string | null;
              subjectId?: string | null;
              proposed?: { parentId?: string | null } | null;
            };
            const owner = first.owner ? norm(first.owner) : null;
            const owners = owner
              ? entities.filter(
                  (e) =>
                    norm(e.name) === owner ||
                    e.aliases.some((a) => norm(a) === owner),
                )
              : [];
            const chosen = first.subjectId ?? first.proposed?.parentId ?? null;
            const inside = (id: string | null, root: string): boolean => {
              while (id) {
                if (id === root) return true;
                id = entities.find((e) => e.id === id)?.parentId ?? null;
              }
              return false;
            };
            if (
              owners.length &&
              chosen &&
              !owners.some((o) => inside(chosen, o.id))
            ) {
              retried = true;
              const second = await gatewayComplete({
                apiKey,
                signal: controller.signal,
                model,
                prompt: `${prompt}\n\nYour previous answer was ${response}\nIts topic is not at or beneath ${first.owner}, the owner you named from the request. Answer again with a topic at or beneath that owner, or propose a new topic under it.`,
                maxTokens: 4096,
                reasoningLevel,
                outputSchema: quickAnalysisSchema(quick),
              });
              cost = (cost ?? 0) + (second.usage.cost ?? 0);
              response = second.text;
            }
          }
          const parsed =
            kind === "quick"
              ? parseQuickAnalysis(response, quick)
              : parseFullAnalysis(response, full);
          if (parsed.topicError) throw new Error(parsed.topicError);
          const topic =
            kind === "quick"
              ? (parsed as TopicAnswer)
              : (parsed as ReturnType<typeof parseFullAnalysis>).topic;
          const value: TopicAnswer = {
            subjectId: topic?.subjectId ?? null,
            proposed: topic?.proposed ?? null,
          };
          results.push({
            id: test.id,
            expected: test.expected,
            expectedPath,
            value,
            response,
            retried,
            cost,
            durationMs: Date.now() - started,
            ...scoreClassification(
              value,
              test.input,
              test.expected,
              cold,
              test.expectNew,
            ),
          });
        } catch (error) {
          results.push({
            id: test.id,
            expected: test.expected,
            expectedPath,
            pass: false,
            response,
            cost,
            durationMs: Date.now() - started,
            error: String(error),
          });
        }
      }
    }),
  );
} finally {
  clearTimeout(timer);
}
const accepted = results.filter((r) => r.pass).length;
const durations = results
  .map((r) => r.durationMs as number)
  .sort((a, b) => a - b);
await writeFile(
  process.env.EVAL_OUTPUT ?? "/tmp/classification-eval.json",
  JSON.stringify(
    {
      model,
      kind,
      reasoningLevel: reasoningLevel ?? "provider-default",
      mode: cold ? "cold" : "warm",
      split: holdout ? "holdout" : "main",
      repetitions,
      acceptedHierarchy: accepted,
      exactMatches: results.filter((r) => r.exact).length,
      total: results.length,
      p95Ms: durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)],
      cost: results.reduce((sum, r) => sum + Number(r.cost ?? 0), 0),
      results,
    },
    null,
    2,
  ),
);
console.log(`${accepted}/${results.length} ${kind} ${model}`);
if (accepted !== results.length) process.exitCode = 1;
