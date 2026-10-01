/**
 * Workstreams' `bb.host` entry: runs one isolated AI Gateway completion on
 * the machine, with the AI Gateway key Pi already has there. No new
 * credentials are stored, and no fallback model is tried.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./contract.ts";
import { gatewayComplete, gatewayKey } from "./gateway.ts";

const NO_KEY =
  "Analysis failed: no AI Gateway key on this machine. Sign Pi in to Vercel AI Gateway. No fallback model was used.";
const FAILURE =
  "Analysis failed. Check Pi's AI Gateway authentication on this machine. No fallback model was used.";
const TIMEOUT_MS = 90_000;

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    // Only looks for .git entries; never reads file contents.
    probe: async ({ path }) => {
      if (!(await isDir(path)))
        return { exists: false, rootRepo: false, childRepos: 0 };
      const names = async (dir: string): Promise<string[]> =>
        readdir(dir).catch(() => []);
      const entries = await names(path);
      let childRepos = 0;
      for (const name of entries.slice(0, 200))
        if (
          !name.startsWith(".") &&
          (await isDir(join(path, name))) &&
          (await names(join(path, name))).includes(".git")
        )
          childRepos++;
      return { exists: true, rootRepo: entries.includes(".git"), childRepos };
    },
    complete: async (
      { prompt, model, maxTokens, reasoningLevel, serviceTier },
      ctx,
    ) => {
      const apiKey = await gatewayKey();
      if (!apiKey) throw new Error(NO_KEY);
      // The server aborts a call whose answer no longer matters (the draft
      // changed); that closes the gateway request instead of waiting on it.
      const signal = AbortSignal.any([
        ctx.signal,
        AbortSignal.timeout(TIMEOUT_MS),
      ]);
      try {
        return await gatewayComplete({
          prompt,
          model,
          maxTokens,
          reasoningLevel,
          serviceTier,
          apiKey,
          signal,
        });
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        throw new Error(
          signal.aborted
            ? "Model request timed out after 90 seconds. No fallback model was used."
            : error instanceof Error
              ? error.message
              : FAILURE,
        );
      }
    },
  },
});
