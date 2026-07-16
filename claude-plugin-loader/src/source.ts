import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { reposDir } from "./registry.ts";

/** A source resolved to something we can turn into a directory on disk. */
export type ResolvedSource =
  | { kind: "local"; path: string; label: string }
  | { kind: "git"; url: string; ref?: string; cacheKey: string; label: string };

/**
 * Parse a user-supplied source into either a local directory or a git clone
 * target. We accept the same shorthands as `pi install` so the two feel
 * consistent:
 *
 *   git:github.com/user/repo@ref
 *   https://github.com/user/repo@ref
 *   ssh://git@github.com/user/repo
 *   github.com/user/repo
 *   user/repo                (assumed GitHub)
 *   ./path or /abs/path      (local directory)
 */
export function parseSource(spec: string): ResolvedSource {
  const trimmed = spec.trim();

  if (trimmed.startsWith("./") || trimmed.startsWith("../") || isAbsolute(trimmed)) {
    return { kind: "local", path: resolve(trimmed), label: trimmed };
  }

  let rest = trimmed;
  if (rest.startsWith("git:")) rest = rest.slice(4);

  // Split off a trailing @ref, but not the user@host in ssh/scp URLs.
  let ref: string | undefined;
  const protocolMatch = /^(https?|ssh|git):\/\//.test(rest) || rest.includes("@github.com:") || /^git@/.test(rest);
  const atIndex = rest.lastIndexOf("@");
  if (atIndex > 0) {
    const candidate = rest.slice(atIndex + 1);
    // Treat as a ref only when it doesn't look like a host (no dots/slashes
    // that would indicate we split a scp-style URL).
    const looksLikeRef = !candidate.includes("/") && !candidate.includes(":");
    const isScpUserHost = protocolMatch && rest.slice(0, atIndex).endsWith("git");
    if (looksLikeRef && !isScpUserHost) {
      ref = candidate;
      rest = rest.slice(0, atIndex);
    }
  }

  let url: string;
  if (/^(https?|ssh|git):\/\//.test(rest) || /^git@/.test(rest)) {
    url = rest;
  } else if (/^[^/]+\.[^/]+\//.test(rest)) {
    // host/owner/repo shorthand
    url = `https://${rest}`;
  } else if (/^[^/]+\/[^/]+$/.test(rest)) {
    // owner/repo shorthand -> GitHub
    url = `https://github.com/${rest}`;
  } else {
    throw new Error(`Unrecognized plugin source: ${spec}`);
  }

  const cacheKey = url
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^git@/, "")
    .replace(/:/g, "/")
    .replace(/\.git$/, "")
    .replace(/[^a-zA-Z0-9._/-]/g, "_");

  return { kind: "git", url, ref, cacheKey, label: trimmed };
}

/**
 * Materialize a source into a local directory and return its absolute path.
 * Git sources are cloned (or refreshed) into the loader's repo cache; local
 * sources are used in place.
 */
export function fetchSource(source: ResolvedSource): string {
  if (source.kind === "local") {
    if (!existsSync(source.path)) {
      throw new Error(`Local plugin source does not exist: ${source.path}`);
    }
    return source.path;
  }

  const target = join(reposDir(), source.cacheKey);
  mkdirSync(reposDir(), { recursive: true });

  if (existsSync(join(target, ".git"))) {
    // Refresh an existing clone to the requested ref.
    git(["-C", target, "fetch", "--depth", "1", "origin", source.ref ?? "HEAD"]);
    git(["-C", target, "reset", "--hard", "FETCH_HEAD"]);
    git(["-C", target, "clean", "-fd"]);
  } else {
    rmSync(target, { recursive: true, force: true });
    const args = ["clone", "--depth", "1"];
    if (source.ref) args.push("--branch", source.ref);
    args.push(source.url, target);
    git(args);
  }

  return target;
}

function git(args: string[]): void {
  execFileSync("git", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}
