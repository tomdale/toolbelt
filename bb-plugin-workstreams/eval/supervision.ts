import { writeFile } from "node:fs/promises";
import {
  gatewayComplete,
  gatewayKey,
} from "../src/server/inference/gateway.ts";
import {
  buildSupervisionPrompt,
  parseSupervision,
  type SupervisionInput,
} from "../src/domain/supervision.ts";

// Synthetic same-product workload verifies the supervisor can see useful effort
// boundaries rather than requiring a second product subject label.
const key = await gatewayKey();
if (!key) throw new Error("AI Gateway key unavailable.");
const input: SupervisionInput = {
  sensitivity: "responsive",
  context:
    "Workstreams is a busy product. Recap and New work each have distinct recurring development. The user wants navigable ongoing efforts, not one-off task buckets.",
  workstreams: [
    {
      id: "ws",
      name: "Workstreams",
      description: "Workstreams architecture and implementation",
      descriptionSource: "generated",
      roots: [
        ...["cardlayout", "recapgeneration", "recappreferences"].map((id) => ({
          id,
          title: `Recap ${id}`,
          recap: "Ongoing recap feature development",
          revision: 1,
          notebook:
            "Recap is a Workstreams capability: card rendering, summary generation, user preferences, and returning-developer experience recur as one area.",
          notebookUpdatedAt: 1,
          eligible: true,
        })),
        ...["composer", "routing", "environmentselection"].map((id) => ({
          id,
          title: `New work ${id}`,
          recap: "Ongoing intake composer and routing development",
          revision: 1,
          notebook:
            "New work intake is a recurring effort covering composer interactions, routing previews, and project/environment placement.",
          notebookUpdatedAt: 1,
          eligible: true,
        })),
        {
          id: "core",
          title: "Workstreams coordination",
          recap: "General organization",
          revision: 1,
          notebook:
            "Core infrastructure and cross-cutting coordination stay in Workstreams.",
          notebookUpdatedAt: 1,
          eligible: true,
        },
      ],
    },
  ],
};
const answer = await gatewayComplete({
  prompt: buildSupervisionPrompt(input),
  model: process.argv[2] ?? "google/gemini-3.1-flash-lite",
  apiKey: key,
});
const actions = parseSupervision(answer.text, input);
const passed = actions.some(
  (a) => a.kind === "spin-out" && a.threadIds.length >= 2,
);
const report = { passed, actions, response: answer.text, usage: answer.usage };
if (process.env.EVAL_OUTPUT)
  await writeFile(process.env.EVAL_OUTPUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
