import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import offshootExtension from "../extensions/offshoot.ts";

describe("offshoot extension registration", () => {
	it("registers one directional command and two directional shortcuts", () => {
		const commands: Array<{ name: string; options: any }> = [];
		const shortcuts: Array<{ key: string; options: any }> = [];
		const pi = {
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			registerCommand(name: string, options: any) { commands.push({ name, options }); },
			registerShortcut(key: string, options: any) { shortcuts.push({ key, options }); },
		} as unknown as ExtensionAPI;

		offshootExtension(pi);

		expect(commands.map(({ name }) => name)).toEqual(["offshoot"]);
		expect(commands[0]?.options.description).toMatch(/active Pi session.*Herdr pane/);
		expect(shortcuts.map(({ key }) => key)).toEqual(["ctrl+alt+right", "ctrl+alt+down"]);
	});
});
