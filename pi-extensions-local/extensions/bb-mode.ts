import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED_IN_BB = new Set([
	"Agent",
	"get_subagent_result",
	"steer_subagent",
	"workflow",
	"workflow_control",
]);

/**
 * When running inside BB, defer subtask delegation and workflow orchestration
 * to native BB threads and BB workflows.
 */
export default function bbMode(pi: ExtensionAPI): void {
	if (!process.env.BB_THREAD_ID) return;

	function filterActiveTools(): void {
		const current = pi.getActiveTools();
		if (current.some((t) => DISABLED_IN_BB.has(t))) {
			pi.setActiveTools(current.filter((t) => !DISABLED_IN_BB.has(t)));
		}
	}

	pi.on("session_start", async () => {
		filterActiveTools();
	});

	pi.on("before_agent_start", async (event) => {
		filterActiveTools();
		if (event.systemPromptOptions?.selectedTools) {
			const tools = event.systemPromptOptions.selectedTools;
			for (let i = tools.length - 1; i >= 0; i--) {
				if (DISABLED_IN_BB.has(tools[i]!)) {
					tools.splice(i, 1);
				}
			}
		}
	});
}
