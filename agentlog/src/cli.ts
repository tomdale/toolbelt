#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { formatTable, serializeRecords } from "./format.js";
import { scanSessions } from "./scanner.js";

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const records = await scanSessions(options);

  if (options.json) {
    console.log(JSON.stringify(serializeRecords(records), null, 2));
  } else {
    console.log(formatTable(records));
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`agentlog: ${message}`);
  process.exitCode = 1;
});
