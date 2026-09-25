import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./host-contract";
import { MODEL } from "./model";
import { parsePiJson, piArgs } from "./pi";

export const inferenceArgs = piArgs(MODEL);

const FAILURE =
  "Gateway classification failed. Check Pi's AI Gateway authentication on the selected machine, then retry. No fallback model was used.";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    complete: async ({ prompt }, ctx) =>
      new Promise((resolve, reject) => {
        // stdin keeps private thread excerpts out of command-line arguments.
        const child = execFile(
          "pi",
          inferenceArgs,
          {
            cwd: tmpdir(),
            signal: ctx.signal,
            timeout: 120_000,
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
