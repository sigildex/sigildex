import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { compareUtf8 } from "./identity/canonical.js";
import { readSkillFrontmatter } from "./identity/frontmatter.js";
import { validateRecordedPath, walkSkill, type WalkFailure, type WalkOptions } from "./identity/walk.js";
import {
  LIMITATIONS,
  validateApprovalRecord,
  type ApprovalRecord,
  type DeclaredSource,
} from "./schema/validate.js";

export const TOOL_VERSION = "0.1.2";

export interface LockOptions {
  skillRoot: string;
  /**
   * Where the record is written. It must sit outside the skill root (§3.3), and its
   * filename must be `<approvalId>.lock.json` (§9.3) — both are checked before the walk.
   */
  outputPath: string;
  approvalId: string;
  artifactPath: string;
  toolVersion?: string;
  createdAt?: string;
  declaredSource?: DeclaredSource;
  /** Test seam passed through to the two-pass walker. */
  walkOptions?: WalkOptions;
}

export type LockResult =
  | { kind: "locked"; record: ApprovalRecord; json: string; outputPath: string }
  | { kind: "tool_error"; message: string; failure?: WalkFailure };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * §3.3 compares the *resolved* output path against the resolved skill root, so the containing
 * directory is resolved with realpath semantics: a lexical `resolve` alone lets a symlinked
 * output directory that aliases into the tree slip past the self-inclusion guard. The final
 * component is never resolved — it is the file about to be created.
 */
async function resolveOutputPath(outputPath: string): Promise<string> {
  const absolute = resolve(outputPath);
  try {
    return join(await realpath(dirname(absolute)), basename(absolute));
  } catch {
    return absolute;
  }
}

function inside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function isRealUtcInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19);
}

function orderedDeclaredSource(source: DeclaredSource): DeclaredSource {
  return {
    ...(source.kind === undefined ? {} : { kind: source.kind }),
    ...(source.repository === undefined ? {} : { repository: source.repository }),
    ...(source.path === undefined ? {} : { path: source.path }),
    ...(source.approved_commit === undefined ? {} : { approved_commit: source.approved_commit }),
    ...(source.tracking_policy === undefined ? {} : { tracking_policy: source.tracking_policy }),
    verification: source.verification,
  };
}

const JSON_INDENT = "  ";

export interface JsonDocumentOptions {
  /**
   * Keys whose value is data captured from an artifact rather than
   * schema-controlled structure. Such a value — and everything beneath it — is
   * written with its object keys in byte-wise sorted order (§12.1). Every other
   * object keeps its declared key order (§9.1, §12.1).
   */
  readonly sortedSubtrees?: ReadonlySet<string>;
}

/** JSON text for a leaf, or null when the value is not a JSON leaf. */
function serializeLeaf(value: unknown): string | null {
  // A size may exceed 2^53 (§9.1), so it is carried as a bigint and written as
  // exact digits. Converting to a number here would lose the very bytes §8.2
  // hashes, and the platform serializer refuses bigints outright.
  if (typeof value === "bigint") return value.toString(10);
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string") return JSON.stringify(value);
  return null;
}

/** JSON text for a value, or null when a member of this type is omitted. */
function serializeJsonValue(
  value: unknown,
  depth: number,
  sorted: boolean,
  options: JsonDocumentOptions,
): string | null {
  const leaf = serializeLeaf(value);
  if (leaf !== null) return leaf;
  if (value === null || typeof value !== "object") return null;
  const inner = JSON_INDENT.repeat(depth + 1);
  const closing = JSON_INDENT.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${inner}${serializeJsonValue(item, depth + 1, sorted, options) ?? "null"}`);
    return `[\n${items.join(",\n")}\n${closing}]`;
  }
  const keys = Object.keys(value);
  if (sorted) keys.sort(compareUtf8);
  const members: string[] = [];
  for (const key of keys) {
    const nested = sorted || options.sortedSubtrees?.has(key) === true;
    const member = serializeJsonValue((value as Record<string, unknown>)[key], depth + 1, nested, options);
    if (member !== null) members.push(`${inner}${JSON.stringify(key)}: ${member}`);
  }
  return members.length === 0 ? "{}" : `{\n${members.join(",\n")}\n${closing}}`;
}

/**
 * Deterministic JSON text with 2-space indentation and LF separators, matching
 * the platform serializer byte for byte on every value it accepts. It exists
 * because two of our values fall outside what that serializer can express:
 * a bigint file size (which it throws on, turning a drift verdict into a tool
 * error) and an ordering requirement that object key insertion order cannot
 * carry, since integer-like keys are enumerated first whatever the order they
 * were added in. No trailing newline is added.
 */
export function serializeJsonDocument(value: unknown, options: JsonDocumentOptions = {}): string {
  return serializeJsonValue(value, 0, false, options) ?? "null";
}

export function serializeApprovalRecord(record: ApprovalRecord): string {
  return `${serializeJsonDocument(record)}\n`;
}

async function atomicWrite(outputPath: string, contents: string): Promise<void> {
  const tempPath = `${outputPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle;
  try {
    handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, outputPath);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Every precondition decidable without reading the tree, checked in this order so a
 * rejected lock never walks and never writes: the output must not land inside the tree
 * (§3.3), the approval id must be well formed, the output filename must be the one that
 * id implies (§9.3), and the remaining recorded fields must satisfy their grammars.
 * Returns the failure message, or null when the lock may proceed.
 */
function preWalkFailure(
  options: LockOptions,
  resolvedRoot: string,
  outputPath: string,
  toolVersion: string,
  createdAt: string,
): string | null {
  if (inside(resolvedRoot, outputPath)) return "Lock output path is equal to or beneath the skill root";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.approvalId)) return "approvalId has an invalid grammar";
  const expectedFilename = `${options.approvalId}.lock.json`;
  if (basename(outputPath) !== expectedFilename) {
    return `Lock output filename must be <approval_id>.lock.json (expected "${expectedFilename}").`;
  }
  if (validateRecordedPath(options.artifactPath, true) !== null) {
    return "artifactPath is not a valid project-relative POSIX path";
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(toolVersion)) return "toolVersion has an invalid grammar";
  if (!isRealUtcInstant(createdAt)) return "createdAt is not a real RFC 3339 UTC instant";
  return null;
}

export async function lock(options: LockOptions): Promise<LockResult> {
  try {
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(options.skillRoot);
    } catch (error) {
      return { kind: "tool_error", message: `Cannot resolve skill root: ${errorText(error)}` };
    }
    const outputPath = await resolveOutputPath(options.outputPath);
    const toolVersion = options.toolVersion ?? TOOL_VERSION;
    const createdAt = options.createdAt ?? new Date().toISOString();
    const rejected = preWalkFailure(options, resolvedRoot, outputPath, toolVersion, createdAt);
    if (rejected !== null) return { kind: "tool_error", message: rejected };

    const walked = await walkSkill(resolvedRoot, options.walkOptions);
    if (!walked.ok) return { kind: "tool_error", message: walked.message, failure: walked };
    if (!walked.manifest.some((file) => file.path === "SKILL.md")) {
      return { kind: "tool_error", message: "SKILL.md is required as a regular file at the skill root" };
    }
    const skill = await readSkillFrontmatter(resolve(resolvedRoot, "SKILL.md"));
    const record: ApprovalRecord = {
      schema_version: 1,
      spec_version: 1,
      tool_version: toolVersion,
      approval_id: options.approvalId,
      artifact_path: options.artifactPath,
      root_digest: walked.rootDigest,
      files: walked.manifest,
      skill,
      created_at: createdAt,
      ...(options.declaredSource === undefined ? {} : { declared_source: orderedDeclaredSource(options.declaredSource) }),
      limitations: LIMITATIONS,
    };
    const json = serializeApprovalRecord(record);
    const selfValidation = validateApprovalRecord(Buffer.from(json, "utf8"));
    if (!selfValidation.ok) {
      return { kind: "tool_error", message: `Refusing to write invalid approval record: ${selfValidation.message}` };
    }
    try {
      await atomicWrite(outputPath, json);
    } catch (error) {
      return { kind: "tool_error", message: `Cannot write lock output in ${dirname(outputPath)}: ${errorText(error)}` };
    }
    return { kind: "locked", record, json, outputPath };
  } catch (error) {
    return { kind: "tool_error", message: `Unexpected lock failure: ${errorText(error)}` };
  }
}
