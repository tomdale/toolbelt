/**
 * Workstreams' `bb.host` entry: runs one isolated Pi completion on the
 * machine, through the AI Gateway credentials Pi already has there. No new
 * credentials are stored, and no fallback model is tried.
 */
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./contract.ts";
import { parsePiJson, piArgs } from "./pi.ts";

const FAILURE =
  "Analysis failed. Check Pi's AI Gateway authentication on this machine. No fallback model was used.";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    complete: async ({ prompt, model }, ctx) =>
      new Promise((resolve, reject) => {
        // The prompt goes over stdin so thread excerpts never appear in
        // process arguments.
        const child = execFile(
          "pi",
          piArgs(model),
          {
            cwd: tmpdir(),
            signal: ctx.signal,
            timeout: 90_000,
            maxBuffer: 4_000_000,
            encoding: "utf8",
            env: { ...process.env, PI_OFFLINE: "1" },
          },
          (error, stdout) => {
            if (error) return reject(new Error(FAILURE));
            try {
              resolve(parsePiJson(stdout));
            } catch {
              reject(new Error(FAILURE));
            }
          },
        );
        child.stdin?.on("error", () => {
          /* execFile reports process failures. */
        });
        child.stdin?.end(prompt);
      }),
  },
});
