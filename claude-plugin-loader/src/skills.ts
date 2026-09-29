import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Stage namespaced copies of every skill reachable from `skillDirs` and return
 * the staging root to hand pi. Returns null when no skills are found.
 */
export function stageNamespacedSkills(
  pluginName: string,
  pluginRoot: string,
  skillDirs: string[],
): string | null {
  const namespace = skillNameSegment(pluginName, "plugin");
  const stageRoot = join(loaderHome(), "skills", namespace);
  rmSync(stageRoot, { recursive: true, force: true });

  const used = new Set<string>();
  let staged = 0;

  for (const dir of skillDirs) {
    for (const skill of discoverSkills(dir, true)) {
      const namespaced = `${namespace}-${skillNameSegment(skill.name, "skill")}`;
      const destName = uniqueName(used, baseNameFor(skill));

      if (skill.kind === "dir") {
        const dest = join(stageRoot, destName);
        if (skill.path === pluginRoot) {
          // A skill rooted at the plugin root: copy only SKILL.md so we don't
          // duplicate the entire repository. Root skills that lean on sibling
          // repo files are not supported.
          mkdirSync(dest, { recursive: true });
          cpSync(join(skill.path, "SKILL.md"), join(dest, "SKILL.md"));
        } else {
          cpSync(skill.path, dest, { recursive: true });
        }
        rewriteName(join(dest, "SKILL.md"), namespaced, pluginName, namespace);
      } else {
        mkdirSync(stageRoot, { recursive: true });
        const dest = join(stageRoot, `${destName}.md`);
        cpSync(skill.path, dest);
        rewriteName(dest, namespaced, pluginName, namespace);
      }
      staged += 1;
    }
  }

  return staged > 0 ? stageRoot : null;
}

/**
 * Find skills under a directory using the same rules pi's loader applies:
 * a directory with SKILL.md is a single skill root (no recursion past it);
 * otherwise top-level `.md` children are skills and subdirectories are searched
 * for SKILL.md roots.
 */
function discoverSkills(dir: string, topLevel: boolean): DiscoveredSkill[] {
  if (!isDir(dir)) return [];

  const skillMd = join(dir, "SKILL.md");
  if (existsSync(skillMd)) {
    if (!hasSkillDescription(skillMd)) return [];
    return [{ name: readSkillName(skillMd) ?? basename(dir), kind: "dir", path: dir }];
  }

  const results: DiscoveredSkill[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (isDir(full)) {
      results.push(...discoverSkills(full, false));
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
  const nameLine = match.match(/^name\s*:\s*(.+?)\s*$/m);
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
