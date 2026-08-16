import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readSkillFrontmatter } from "./identity/frontmatter.js";
import { validateRecordedPath, walkSkill, type WalkFailure, type WalkOptions } from "./identity/walk.js";
import {
  LIMITATIONS,
  validateApprovalRecord,
  type ApprovalRecord,
  type DeclaredSource,
} from "./schema/validate.js";

export const TOOL_VERSION = "0.1.0";

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

export function serializeApprovalRecord(record: ApprovalRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
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
