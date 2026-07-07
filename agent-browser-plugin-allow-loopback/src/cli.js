#!/usr/bin/env node
import { stdin, stdout, stderr } from "node:process";
import { handlePluginRequest } from "./plugin.js";

async function readStdin() {
  let input = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) {
    input += chunk;
  }
  return input;
}

async function main() {
  const input = await readStdin();
  const payload = input.trim() ? JSON.parse(input) : {};
  stdout.write(`${JSON.stringify(handlePluginRequest(payload))}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`agent-browser-plugin-allow-loopback: ${message}\n`);
  process.exitCode = 1;
});
