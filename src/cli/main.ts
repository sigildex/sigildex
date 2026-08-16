import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { check } from "../check.js";
import { diff } from "../diff/diff.js";
import { validateRecordedPath } from "../identity/walk.js";
import { lock, serializeJsonDocument, TOOL_VERSION } from "../lock.js";
import { DECLARED_SOURCE_FIELDS, validateDeclaredSource, type DeclaredSource } from "../schema/validate.js";
import { renderDiffReport, renderDriftReport, renderLockSummary, renderMatch } from "./render.js";
import { displayString, sanitizeForTerminal } from "./sanitize.js";

const EXIT_OK = 0;
const EXIT_TOOL_ERROR = 1;
const EXIT_DRIFT = 2;
const EXIT_INVALID_RECORD = 3;

const APPROVAL_ID_GRAMMAR = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL_VERSION_GRAMMAR = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * §12.1: each side's `skill` object carries the artifact's shape verbatim with
 * its object keys serialized in byte-wise sorted order. Everything else in a
 * report is schema-controlled structure and keeps its declared key order.
 */
const DIFF_SORTED_SUBTREES: ReadonlySet<string> = new Set(["skill"]);

/**
 * Choosing `--json` is a presentation choice and never a verdict: a report that
 * cannot be serialized would otherwise be reported as a tool error on a tree
 * that human mode calls drift.
 */
function jsonDocument(value: unknown, sortedSubtrees?: ReadonlySet<string>): string {
  return `${serializeJsonDocument(value, sortedSubtrees === undefined ? {} : { sortedSubtrees })}\n`;
}

const USAGE = `sigildex — record what you approved, detect when it changes.

Usage:
  sigildex lock <skill-path> --out <lock-path> [--approval-id <id>] [--artifact-path <path>]
                             [--source-kind <kind>] [--source-repository <url>] [--source-path <path>]
                             [--source-commit <hex>] [--source-tracking <policy>] [--json]
  sigildex check <skill-path> --against <lock-path> [--json]
  sigildex diff <base-path> <candidate-path> [--json]
  sigildex --help
  sigildex --version

Commands:
  lock    Walk a skill directory and write an approval record for it.
  check   Compare a skill directory against an approval record.
  diff    Compare two skill directories and report what changed.

Options:
  --out <path>            Where to write the approval record (required by lock).
                          It must not be inside the skill directory, and its
                          filename must be <approval-id>.lock.json.
  --approval-id <id>      Stable record id, matching [a-z0-9][a-z0-9-]{0,63}.
                          Defaults to the skill directory name.
  --artifact-path <path>  Project-relative POSIX path recorded in the record.
                          Defaults to the skill path relative to this directory.
  --against <path>        Approval record to check the skill directory against.
  --json                  Print the machine-readable record or report instead of
                          the human-readable summary.

Declared source (lock only, all optional, all recorded unverified):
  --source-kind <kind>        Source kind, 1-32 characters from [a-z0-9-].
  --source-repository <url>   Where the artifact came from, at most 512 bytes.
  --source-path <path>        Path within that source, or "." for its root.
  --source-commit <hex>       Approved revision, 7-64 lowercase hex characters.
  --source-tracking <policy>  How updates are tracked, at most 128 bytes.

Passing any --source-* flag records a declared_source; passing none omits it.
Its contents are user-supplied and never verified: they say where you believe
the artifact came from, not where it provably came from, and they sit outside
the root digest, so editing them is not drift.

Exit codes:
  0  success, match, or identical
  2  drift detected, or the two directories differ
  1  tool, input, filesystem, or walk error
  3  unsupported or invalid approval record

Identity covers file bytes, paths, and the executable bit. It does not attest
safety, provenance, or future content.
`;

function write(stream: NodeJS.WriteStream, text: string): void {
  stream.write(text);
}

function failWith(message: string): number {
  write(process.stderr, `Error: ${sanitizeForTerminal(message)}\n`);
  return EXIT_TOOL_ERROR;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the published package version; falls back to the compiled-in version. */
function toolVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    if (typeof version === "string" && TOOL_VERSION_GRAMMAR.test(version)) return version;
  } catch {
    // Fall through to the compiled-in version.
  }
  return TOOL_VERSION;
}

/** Derives an approval id from the skill directory name, or null if it cannot. */
function deriveApprovalId(skillPath: string): string | null {
  const candidate = basename(resolve(skillPath))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return APPROVAL_ID_GRAMMAR.test(candidate) ? candidate : null;
}

/** Derives the project-relative artifact path, or null if the root is outside cwd. */
function deriveArtifactPath(skillPath: string): string | null {
  const relativePath = relative(process.cwd(), resolve(skillPath));
  if (relativePath === "") return ".";
  if (isAbsolute(relativePath) || relativePath.split(sep).includes("..")) return null;
  const posixPath = relativePath.split(sep).join("/");
  return validateRecordedPath(posixPath, true) === null ? posixPath : null;
}

function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** The `--source-*` flags, paired with the `declared_source` member each one sets. */
const SOURCE_FLAGS = [
  ["source-kind", "kind"],
  ["source-repository", "repository"],
  ["source-path", "path"],
  ["source-commit", "approved_commit"],
  ["source-tracking", "tracking_policy"],
] as const;

const LOCK_OPTIONS = {
  out: { type: "string" },
  "approval-id": { type: "string" },
  "artifact-path": { type: "string" },
  "source-kind": { type: "string" },
  "source-repository": { type: "string" },
  "source-path": { type: "string" },
  "source-commit": { type: "string" },
  "source-tracking": { type: "string" },
  json: { type: "boolean", default: false },
} as const;

type DeclaredSourceResult =
  | { kind: "absent" }
  | { kind: "present"; declaredSource: DeclaredSource }
  | { kind: "error"; message: string };

/**
 * Builds `declared_source` from the `--source-*` flags. Every member is optional, so any
 * subset is a valid combination; giving none omits the field entirely. Values are checked
 * against the record grammars themselves, so a lock is never attempted with a source the
 * schema would reject.
 */
function declaredSourceFromFlags(values: Record<string, unknown>): DeclaredSourceResult {
  const source: Record<string, string> = {};
  for (const [flag, field] of SOURCE_FLAGS) {
    const value = values[flag];
    if (value === undefined) continue;
    const { rule, accepts } = DECLARED_SOURCE_FIELDS[field];
    if (typeof value !== "string" || !accepts(value)) {
      return { kind: "error", message: `--${flag} must be ${rule} (got "${displayString(String(value))}").` };
    }
    source[field] = value;
  }
  if (Object.keys(source).length === 0) return { kind: "absent" };
  const declaredSource = validateDeclaredSource({ ...source, verification: "user_supplied" });
  if (declaredSource === null) {
    return { kind: "error", message: "The --source-* values do not form a valid declared source." };
  }
  return { kind: "present", declaredSource };
}

async function runLock(args: readonly string[]): Promise<number> {
  if (wantsHelp(args)) {
    write(process.stdout, USAGE);
    return EXIT_OK;
  }
  const { values, positionals } = parseArgs({
    args: [...args],
    options: LOCK_OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1) return failWith("lock takes exactly one <skill-path>.");
  const skillPath = positionals[0]!;
  if (values.out === undefined || values.out === "") {
    return failWith("lock requires --out <lock-path> (outside the skill directory).");
  }
  const approvalId = values["approval-id"] ?? deriveApprovalId(skillPath);
  if (approvalId === null) {
    return failWith(
      "Cannot derive an approval id from the directory name. " +
        "Pass --approval-id <id> matching [a-z0-9][a-z0-9-]{0,63}.",
    );
  }
  const artifactPath = values["artifact-path"] ?? deriveArtifactPath(skillPath);
  if (artifactPath === null) {
    return failWith(
      "The skill directory is not inside the current directory. " +
        "Pass --artifact-path <project-relative-path> to record its project-relative location.",
    );
  }
  const source = declaredSourceFromFlags(values);
  if (source.kind === "error") return failWith(source.message);
  const result = await lock({
    skillRoot: skillPath,
    outputPath: values.out,
    approvalId,
    artifactPath,
    toolVersion: toolVersion(),
    ...(source.kind === "absent" ? {} : { declaredSource: source.declaredSource }),
  });
  if (result.kind === "tool_error") return failWith(result.message);
  write(process.stdout, values.json ? result.json : renderLockSummary(result.record, values.out));
  return EXIT_OK;
}

async function runCheck(args: readonly string[]): Promise<number> {
  if (wantsHelp(args)) {
    write(process.stdout, USAGE);
    return EXIT_OK;
  }
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      against: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1) return failWith("check takes exactly one <skill-path>.");
  if (values.against === undefined || values.against === "") {
    return failWith("check requires --against <lock-path>.");
  }
  const result = await check({ skillRoot: positionals[0]!, lockPath: values.against });
  switch (result.kind) {
    case "tool_error":
      return failWith(result.message);
    case "invalid_lock":
      write(
        process.stderr,
        `Invalid approval record (${result.step}): ${sanitizeForTerminal(result.message)}\n`,
      );
      return EXIT_INVALID_RECORD;
    case "match":
      write(process.stdout, values.json ? jsonDocument(result.record) : renderMatch(result.record));
      return EXIT_OK;
    case "drift":
      write(process.stdout, values.json ? jsonDocument(result.report) : renderDriftReport(result.report));
      return EXIT_DRIFT;
  }
}

async function runDiff(args: readonly string[]): Promise<number> {
  if (wantsHelp(args)) {
    write(process.stdout, USAGE);
    return EXIT_OK;
  }
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 2) return failWith("diff takes exactly two paths: <base-path> <candidate-path>.");
  const result = await diff({ basePath: positionals[0]!, candidatePath: positionals[1]! });
  if (result.kind === "tool_error") return failWith(result.message);
  const identical = result.kind === "identical";
  write(
    process.stdout,
    values.json
      ? jsonDocument(result.report, DIFF_SORTED_SUBTREES)
      : renderDiffReport(result.report, identical),
  );
  return identical ? EXIT_OK : EXIT_DRIFT;
}

export async function main(argv: readonly string[]): Promise<number> {
  // Windows is out of scope: path-separator translation, missing execute bits,
  // and case-insensitive semantics would silently change identity.
  if (process.platform === "win32") {
    write(
      process.stderr,
      "Error: sigildex does not support Windows. Supported platforms are macOS and Linux; " +
        "run it under WSL or on a Linux or macOS host.\n",
    );
    return EXIT_TOOL_ERROR;
  }
  const [command, ...rest] = argv;
  if (command === undefined) {
    write(process.stderr, USAGE);
    return EXIT_TOOL_ERROR;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    write(process.stdout, USAGE);
    return EXIT_OK;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    write(process.stdout, `sigildex ${toolVersion()}\n`);
    return EXIT_OK;
  }
  try {
    switch (command) {
      case "lock":
        return await runLock(rest);
      case "check":
        return await runCheck(rest);
      case "diff":
        return await runDiff(rest);
      default:
        return failWith(`Unknown command "${command}". Run "sigildex --help" for usage.`);
    }
  } catch (error) {
    return failWith(errorText(error));
  }
}
