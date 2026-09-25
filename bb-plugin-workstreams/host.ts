import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./host-contract";
import { MODEL } from "./model";
import { parsePiJson, piArgs } from "./pi";

export const inferenceArgs = piArgs(MODEL);

const FAILURE =
  "Gateway classification failed. Check Pi's AI Gateway authentication on the selected machine, then retry. No fallback model was used.";

/** The Gateway key Pi already uses on this machine; no new credentials are stored. */
async function gatewayKey(): Promise<string> {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  const auth = JSON.parse(
    await readFile(join(homedir(), ".pi", "agent", "auth.json"), "utf8"),
  ) as { "vercel-ai-gateway"?: { type?: string; key?: string } };
  const entry = auth["vercel-ai-gateway"];
  if (entry?.type === "api_key" && entry.key) return entry.key;
  throw new Error("No AI Gateway key found for Pi on this machine.");
}

/** Shrinks a generated PNG to a small JPEG with macOS sips when available. */
async function shrink(png: Buffer): Promise<{ data: Buffer; mime: string }> {
  const dir = await mkdtemp(join(tmpdir(), "workstreams-banner-"));
  try {
    await writeFile(join(dir, "in.png"), png);
    await promisify(execFile)("sips", [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "70",
      "-Z",
      "1200",
      join(dir, "in.png"),
      "--out",
      join(dir, "out.jpg"),
    ]);
    return { data: await readFile(join(dir, "out.jpg")), mime: "image/jpeg" };
  } catch {
    return { data: png, mime: "image/png" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    image: async ({ prompt, model }, ctx) => {
      const response = await fetch(
        "https://ai-gateway.vercel.sh/v1/images/generations",
        {
          method: "POST",
          signal: ctx.signal,
          headers: {
            authorization: `Bearer ${await gatewayKey()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            prompt,
            n: 1,
            size: "1536x1024",
            quality: "low",
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Image generation failed (HTTP ${response.status}).`);
      const body = (await response.json()) as {
        data: { b64_json: string }[];
        providerMetadata?: { gateway?: { cost?: string } };
      };
      const image = await shrink(Buffer.from(body.data[0].b64_json, "base64"));
      return {
        data: image.data.toString("base64"),
        mime: image.mime,
        cost: Number(body.providerMetadata?.gateway?.cost ?? 0),
      };
    },
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
