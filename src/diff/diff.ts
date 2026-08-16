import { resolve } from "node:path";
import { compareUtf8, type ManifestEntry } from "../identity/canonical.js";
import type { FileClass } from "../identity/classify.js";
import { readSkillFrontmatter, type JsonValue, type SkillMetadata } from "../identity/frontmatter.js";
import { walkSkill, type WalkFailure, type WalkOptions, type WalkSuccess } from "../identity/walk.js";

/** The identity facts a report carries for one side of a `changed` entry. */
export interface DiffFileState {
  sha256: string;
  size: number;
  executable: boolean;
}

/** An `added` or `removed` entry: the file exists on exactly one side. */
export interface DiffPresentEntry extends DiffFileState {
  path: string;
  class: FileClass;
}

/** A `changed` entry: present on both sides with a content and/or mode difference. */
export interface DiffChangedEntry {
  path: string;
  class: FileClass;
  content_changed: boolean;
  mode_changed: boolean;
  base: DiffFileState;
  candidate: DiffFileState;
}

export interface DiffSide {
  root_digest: string;
  skill: SkillMetadata;
}

/**
 * The normative report structure. Key order is the serialization order of the
 * report contract: schema_version, base, candidate, added, removed, changed.
 */
export interface DiffReport {
  schema_version: 1;
  base: DiffSide;
  candidate: DiffSide;
  added: DiffPresentEntry[];
  removed: DiffPresentEntry[];
  changed: DiffChangedEntry[];
}

export interface DiffOptions {
  basePath: string;
  candidatePath: string;
  /** Test seam passed through to the two-pass walker for both trees. */
  walkOptions?: WalkOptions;
}

export type DiffTree = "base" | "candidate";

export type DiffResult =
  | { kind: "identical"; report: DiffReport }
  | { kind: "different"; report: DiffReport }
  | { kind: "tool_error"; side: DiffTree | "report"; message: string; failure?: WalkFailure };

interface WalkedSide {
  walk: WalkSuccess;
  skill: SkillMetadata;
}

function sameSize(left: number | bigint, right: number | bigint): boolean {
  return BigInt(left) === BigInt(right);
}

/**
 * Both sides of a `diff` are walked trees, and §11 caps a single file at
 * 64 MiB, so a reported size is always far inside the exactly-representable
 * range. A size that only a hand-written record can carry (§9.1 admits any
 * non-negative integer) never reaches here.
 */
function fileState(entry: ManifestEntry): DiffFileState {
  return { sha256: entry.sha256, size: Number(entry.size), executable: entry.executable };
}

function presentEntry(entry: ManifestEntry): DiffPresentEntry {
  return {
    path: entry.path,
    class: entry.class,
    sha256: entry.sha256,
    size: Number(entry.size),
    executable: entry.executable,
  };
}

/**
 * Recursively orders object keys byte-wise so the report is byte-reproducible.
 *
 * The mapping has a null prototype for two reasons. A `__proto__` key from an
 * artifact is then an ordinary data member rather than a write through the
 * legacy prototype setter, which would drop it from the report entirely — the
 * shape is carried verbatim (§12.1), and a key an attacker controls is exactly
 * the one a reader must still see. And a lookup for an absent key answers
 * "absent" instead of returning something inherited from `Object.prototype`.
 *
 * This settles the in-memory order only: an integer-like key is enumerated
 * ahead of its siblings whatever order it was inserted in, so the emitted byte
 * order is established again at serialization time.
 */
function orderJsonKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(orderJsonKeys);
  if (value === null || typeof value !== "object") return value;
  const ordered = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort(compareUtf8)) ordered[key] = orderJsonKeys(value[key]!);
  return ordered;
}

/** Carries the skill shape verbatim, with object keys in byte-wise sorted order. */
function orderedSkill(skill: SkillMetadata): SkillMetadata {
  return skill.frontmatter_status === "ok"
    ? { frontmatter: orderJsonKeys(skill.frontmatter) as Record<string, JsonValue>, frontmatter_status: "ok" }
    : { frontmatter: null, frontmatter_status: skill.frontmatter_status };
}

async function walkSide(
  path: string,
  side: DiffTree,
  walkOptions: WalkOptions | undefined,
): Promise<WalkedSide | Extract<DiffResult, { kind: "tool_error" }>> {
  const walked = await walkSkill(path, walkOptions);
  if (!walked.ok) {
    return { kind: "tool_error", side, message: `${side}: ${walked.message}`, failure: walked };
  }
  if (!walked.manifest.some((file) => file.path === "SKILL.md")) {
    return {
      kind: "tool_error",
      side,
      message: `${side}: SKILL.md is required as a regular file at the skill root`,
    };
  }
  const skill = await readSkillFrontmatter(resolve(walked.root, "SKILL.md"));
  return { walk: walked, skill };
}

function isToolError(value: unknown): value is Extract<DiffResult, { kind: "tool_error" }> {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "tool_error";
}

/**
 * Compares two local skill directories. Both trees are walked independently
 * under the full walker contract, in fixed order: the base tree completely,
 * then the candidate tree completely. Either walk failing yields a structured
 * tool error and no report — a partial report is never emitted. There is no
 * invalid-record outcome: `diff` involves no lock.
 */
export async function diff(options: DiffOptions): Promise<DiffResult> {
  const base = await walkSide(options.basePath, "base", options.walkOptions);
  if (isToolError(base)) return base;
  const candidate = await walkSide(options.candidatePath, "candidate", options.walkOptions);
  if (isToolError(candidate)) return candidate;

  const baseFiles = new Map(base.walk.manifest.map((file) => [file.path, file]));
  const candidateFiles = new Map(candidate.walk.manifest.map((file) => [file.path, file]));
  const added: DiffPresentEntry[] = [];
  const removed: DiffPresentEntry[] = [];
  const changed: DiffChangedEntry[] = [];

  for (const file of candidate.walk.manifest) {
    const before = baseFiles.get(file.path);
    if (before === undefined) {
      added.push(presentEntry(file));
      continue;
    }
    const contentChanged = before.sha256 !== file.sha256 || !sameSize(before.size, file.size);
    const modeChanged = before.executable !== file.executable;
    if (!contentChanged && !modeChanged) continue;
    changed.push({
      path: file.path,
      class: file.class,
      content_changed: contentChanged,
      mode_changed: modeChanged,
      base: fileState(before),
      candidate: fileState(file),
    });
  }
  for (const file of base.walk.manifest) {
    if (!candidateFiles.has(file.path)) removed.push(presentEntry(file));
  }
  for (const category of [added, removed, changed]) {
    category.sort((left, right) => compareUtf8(left.path, right.path));
  }

  const report: DiffReport = {
    schema_version: 1,
    base: { root_digest: base.walk.rootDigest, skill: orderedSkill(base.skill) },
    candidate: { root_digest: candidate.walk.rootDigest, skill: orderedSkill(candidate.skill) },
    added,
    removed,
    changed,
  };
  const identical = base.walk.rootDigest === candidate.walk.rootDigest;
  const empty = added.length === 0 && removed.length === 0 && changed.length === 0;
  if (identical !== empty) {
    return {
      kind: "tool_error",
      side: "report",
      message: "Internal inconsistency: root-digest equality disagrees with the per-file comparison",
    };
  }
  return identical ? { kind: "identical", report } : { kind: "different", report };
}
