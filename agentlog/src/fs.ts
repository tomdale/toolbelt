import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function walkFiles(root: string, predicate: (path: string) => boolean): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const output: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const child = join(root, entry.name);
      if (entry.isDirectory()) {
        output.push(...(await walkFiles(child, predicate)));
      } else if (entry.isFile() && predicate(child)) {
        output.push(child);
      }
    }),
  );

  return output;
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
