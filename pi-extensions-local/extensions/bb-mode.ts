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

	function filterTools(): void {
		const current = pi.getActiveTools();
		if (current.some((t) => DISABLED_IN_BB.has(t))) {
			pi.setActiveTools(current.filter((t) => !DISABLED_IN_BB.has(t)));
		}
	}

	pi.on("session_start", async () => {
		filterTools();
	});

	pi.on("before_agent_start", async (event) => {
		filterTools();
		if (event.systemPromptOptions?.selectedTools) {
			event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(
				(t) => !DISABLED_IN_BB.has(t),
			);
		}
	});
}
