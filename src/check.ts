import { readFile } from "node:fs/promises";
import { compareUtf8, type ManifestEntry } from "./identity/canonical.js";
import { walkSkill, type WalkFailure, type WalkOptions } from "./identity/walk.js";
import { validateApprovalRecord, type ApprovalRecord, type ValidationStep } from "./schema/validate.js";

export interface DriftFile {
  path: string;
  expected?: ManifestEntry;
  actual?: ManifestEntry;
}

export interface DriftReport {
  added: DriftFile[];
  removed: DriftFile[];
  modified: DriftFile[];
  mode_changed: DriftFile[];
  expected_root_digest: string;
  actual_root_digest: string;
}

export interface CheckOptions {
  skillRoot: string;
  lockPath: string;
  /** Test seam passed through to the two-pass walker. */
  walkOptions?: WalkOptions;
}

export type CheckResult =
  | { kind: "match"; record: ApprovalRecord }
  | { kind: "drift"; report: DriftReport; record: ApprovalRecord }
  | { kind: "tool_error"; message: string; failure?: WalkFailure }
  | { kind: "invalid_lock"; step: ValidationStep; message: string };

function sameSize(left: number | bigint, right: number | bigint): boolean {
  return BigInt(left) === BigInt(right);
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  let lockBytes: Buffer;
  try {
    lockBytes = await readFile(options.lockPath);
  } catch (error) {
    return { kind: "tool_error", message: `Cannot acquire lock: ${error instanceof Error ? error.message : String(error)}` };
  }

  const validation = validateApprovalRecord(lockBytes);
  if (!validation.ok) return { kind: "invalid_lock", step: validation.step, message: validation.message };

  const walked = await walkSkill(options.skillRoot, options.walkOptions);
  if (!walked.ok) return { kind: "tool_error", message: walked.message, failure: walked };

  const expected = new Map(validation.record.files.map((file) => [file.path, file]));
  const actual = new Map(walked.manifest.map((file) => [file.path, file]));
  const added: DriftFile[] = [];
  const removed: DriftFile[] = [];
  const modified: DriftFile[] = [];
  const modeChanged: DriftFile[] = [];
  for (const file of walked.manifest) {
    const locked = expected.get(file.path);
    if (locked === undefined) added.push({ path: file.path, actual: file });
    else {
      if (locked.sha256 !== file.sha256 || !sameSize(locked.size, file.size)) {
        modified.push({ path: file.path, expected: locked, actual: file });
      }
      if (locked.executable !== file.executable) {
        modeChanged.push({ path: file.path, expected: locked, actual: file });
      }
    }
  }
  for (const file of validation.record.files) {
    if (!actual.has(file.path)) removed.push({ path: file.path, expected: file });
  }
  for (const category of [added, removed, modified, modeChanged]) {
    category.sort((left, right) => compareUtf8(left.path, right.path));
  }
  const report: DriftReport = {
    added,
    removed,
    modified,
    mode_changed: modeChanged,
    expected_root_digest: validation.record.root_digest,
    actual_root_digest: walked.rootDigest,
  };
  const hasDrift = added.length > 0 || removed.length > 0 || modified.length > 0 || modeChanged.length > 0 ||
    validation.record.root_digest !== walked.rootDigest;
  return hasDrift
    ? { kind: "drift", report, record: validation.record }
    : { kind: "match", record: validation.record };
}
