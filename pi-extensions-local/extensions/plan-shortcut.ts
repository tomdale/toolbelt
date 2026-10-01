import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

/** Reuse the plan package's command without duplicating its mode state. */
export default function planShortcut(pi: ExtensionAPI): void {
	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Open plan mode",
		handler: async () => {
			pi.sendUserMessage("/plan", { deliverAs: "followUp", expandPromptTemplates: true });
		},
	});
}
