import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

import { loaderHome } from "./registry.ts";

/**
 * pi names a skill from its `SKILL.md` frontmatter and offers no per-source
 * prefix, so two plugins (or a plugin and a global skill) that both define
 * `refactoring` would collide and one would be deduped away.
 *
 * Skill names may only contain lowercase letters, numbers, and hyphens. We
 * namespace by copying each skill into a per-plugin staging tree and rewriting
 * only its frontmatter `name` to `<plugin>-<name>`. pi then loads the staged
 * copies as ordinary skills, invocable as `/skill:<plugin>-<name>`, with
 * no collisions against the originals.
 *
 * We stage copies rather than editing the clone so the fetched repo stays
 * pristine and re-fetchable.
 */

interface DiscoveredSkill {
  /** Original skill name (frontmatter `name`, falling back to the file/dir name). */
  name: string;
  kind: "dir" | "file";
  /** Absolute path to the skill directory (kind "dir") or `.md` file (kind "file"). */
  path: string;
}

// Bump when the namespace transform or snapshot layout changes.
const STAGE_FORMAT_VERSION = 1;

interface SnapshotFile {
  path: string;
  bytes: Buffer;
  mode: number;
}

/**
 * Publish a complete, content-addressed skill snapshot. The returned directory
 * is never rewritten or removed: running sessions may read its files lazily.
 * Source bytes are captured once so the digest and staged output cannot diverge
 * when a source file changes during the build.
 */
export function stageNamespacedSkills(
  pluginName: string,
  pluginRoot: string,
  skillDirs: string[],
  manifestInputs: string[] = [],
): string | null {
  const namespace = skillNameSegment(pluginName, "plugin");
  const used = new Set<string>();
  const files: SnapshotFile[] = [];
  const directories: { path: string; mode: number }[] = [];
  const rewrites: { path: string; name: string }[] = [];

  for (const dir of skillDirs) {
    for (const skill of discoverSkills(dir, true)) {
      const destName = uniqueName(used, baseNameFor(skill));
      const skillFile = skill.kind === "dir" ? join(skill.path, "SKILL.md") : skill.path;
      const bytes = readFileSync(skillFile);
      const block = frontmatter(bytes.toString("utf8"));
      if (!block || !/^description\s*:/m.test(block)) continue;
      const name = readName(block) ?? skill.name;
      const path = skill.kind === "dir" ? join(destName, "SKILL.md") : `${destName}.md`;
      rewrites.push({ path, name: `${namespace}-${skillNameSegment(name, "skill")}` });

      if (skill.kind === "dir" && skill.path !== pluginRoot) {
        captureDirectory(skill.path, destName, files, directories, new Set(), bytes);
      } else {
        // Root skills copy only SKILL.md, not the entire source repository.
        files.push({ path, bytes, mode: statSync(skillFile).mode & 0o777 });
      }
    }
  }
  if (rewrites.length === 0) return null;

  const hash = createHash("sha256");
  hash.update(JSON.stringify([STAGE_FORMAT_VERSION, pluginName, pluginRoot, skillDirs, manifestInputs, rewrites]));
  hash.update(JSON.stringify(directories));
  for (const file of files) {
    hash.update(JSON.stringify([file.path, file.mode, file.bytes.length]));
    hash.update(file.bytes);
  }
  const digest = hash.digest("hex");
  const versions = join(loaderHome(), "skills", ".versions");
  const stageRoot = join(versions, `${namespace}-${digest}`);
  if (existsSync(join(stageRoot, ".complete"))) return stageRoot;

  mkdirSync(versions, { recursive: true });
  const temporary = mkdtempSync(join(versions, `.${namespace}-`));
  try {
    for (const directory of directories) {
      mkdirSync(join(temporary, directory.path), { recursive: true });
    }
    for (const file of files) {
      const destination = join(temporary, file.path);
      mkdirSync(join(destination, ".."), { recursive: true });
      writeFileSync(destination, file.bytes);
    }
    for (const rewrite of rewrites) {
      rewriteName(join(temporary, rewrite.path), rewrite.name, pluginName, namespace);
    }
    for (const file of files) {
      chmodSync(join(temporary, file.path), file.mode);
    }
    for (const directory of directories.reverse()) {
      chmodSync(join(temporary, directory.path), directory.mode);
    }
    writeFileSync(join(temporary, ".complete"), digest + "\n");
    try {
      renameSync(temporary, stageRoot);
    } catch (error) {
      // Another builder may have published the same immutable generation.
      if (!existsSync(join(stageRoot, ".complete"))) throw error;
    }
    return stageRoot;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function captureDirectory(
  source: string,
  destination: string,
  files: SnapshotFile[],
  directories: { path: string; mode: number }[],
  ancestors: Set<string>,
  skillBytes?: Buffer,
): void {
  const canonical = realpathSync(source);
  if (ancestors.has(canonical)) throw new Error(`Cyclic skill resource directory: ${source}`);
  const next = new Set(ancestors).add(canonical);
  directories.push({ path: destination, mode: statSync(source).mode & 0o777 });
  for (const entry of readdirSync(source).sort()) {
    const path = join(source, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      captureDirectory(path, join(destination, entry), files, directories, next);
    } else if (stat.isFile()) {
      files.push({
        path: join(destination, entry),
        bytes: entry === "SKILL.md" && skillBytes ? skillBytes : readFileSync(path),
        mode: stat.mode & 0o777,
      });
    } else {
      throw new Error(`Unsupported skill resource: ${path}`);
    }
  }
}

/**
 * Find skills under a directory using the same rules pi's loader applies:
 * a directory with SKILL.md is a single skill root (no recursion past it);
 * otherwise top-level `.md` children are skills and subdirectories are searched
 * for SKILL.md roots.
 */
function discoverSkills(dir: string, topLevel: boolean, ancestors = new Set<string>()): DiscoveredSkill[] {
  if (!isDir(dir)) return [];
  const canonical = realpathSync(dir);
  if (ancestors.has(canonical)) throw new Error(`Cyclic skill resource directory: ${dir}`);
  const next = new Set(ancestors).add(canonical);

  const skillMd = join(dir, "SKILL.md");
  if (existsSync(skillMd)) {
    if (!hasSkillDescription(skillMd)) return [];
    return [{ name: readSkillName(skillMd) ?? basename(dir), kind: "dir", path: dir }];
  }

  const results: DiscoveredSkill[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (isDir(full)) {
      results.push(...discoverSkills(full, false, next));
    } else if (topLevel && entry.toLowerCase().endsWith(".md") && hasSkillDescription(full)) {
      results.push({ name: readSkillName(full) ?? entry.replace(/\.md$/i, ""), kind: "file", path: full });
    }
  }
  return results;
}

function baseNameFor(skill: DiscoveredSkill): string {
  return skill.kind === "dir" ? basename(skill.path) : basename(skill.path).replace(/\.md$/i, "");
}

function uniqueName(used: Set<string>, name: string): string {
  let candidate = name;
  let n = 2;
  while (used.has(candidate)) candidate = `${name}-${n++}`;
  used.add(candidate);
  return candidate;
}

/** Read the frontmatter `name` of a SKILL.md-style file, if present. */
function readSkillName(file: string): string | null {
  const match = frontmatter(readFileSafe(file));
  if (!match) return null;
  return readName(match);
}

function readName(block: string): string | null {
  const nameLine = block.match(/^name\s*:\s*(.+?)\s*$/m);
  if (!nameLine) return null;
  return nameLine[1].replace(/^["']|["']$/g, "").trim() || null;
}

/**
 * Rewrite (or insert) the frontmatter `name` field of a skill markdown file.
 * Every other field is left untouched.
 */
function rewriteName(file: string, name: string, pluginName: string, namespace: string): void {
  if (!existsSync(file)) return;
  const text = rewriteSkillReferences(readFileSafe(file), pluginName, namespace);
  const block = frontmatter(text);

  if (block === null) {
    writeFileSync(file, `---\nname: ${name}\n---\n\n${text}`, "utf8");
    return;
  }

  let body = block;
  body = /^name\s*:.*$/m.test(body)
    ? body.replace(/^name\s*:.*$/m, `name: ${name}`)
    : `name: ${name}\n${body}`;

  // Function replacement avoids `$`-pattern interpretation in skill bodies.
  const updated = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, () => `---\n${body}\n---`);
  writeFileSync(file, updated, "utf8");
}

/** Return the frontmatter body (between the leading `---` fences), or null. */
function frontmatter(text: string): string | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

function hasSkillDescription(file: string): boolean {
  const block = frontmatter(readFileSafe(file));
  return block !== null && /^description\s*:/m.test(block);
}

function rewriteSkillReferences(text: string, pluginName: string, namespace: string): string {
  return text.replace(new RegExp(`\\$${escapeRegExp(pluginName)}:`, "g"), `$${namespace}-`);
}

function readFileSafe(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function skillNameSegment(name: string, fallback: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
