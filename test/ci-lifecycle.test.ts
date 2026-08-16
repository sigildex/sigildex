/**
 * Lifecycle tests for the consumer CI snippet in `docs/ci/approval-check.yml`.
 *
 * The shell under test is extracted from the committed workflow at run time, so
 * these tests can never drift from a copy. Each scenario builds a real bare
 * "origin", a base commit and a pull-request head, then clones the head
 * *shallow* — the base commit is genuinely absent until the workflow's own
 * `git fetch --no-tags --depth=1 origin "$BASE_SHA"` brings it in.
 *
 * The tool call is redirected without touching the snippet's semantics: a `npx`
 * shim earlier on PATH drops the `--yes sigildex@<version>` arguments and execs
 * the local build, and every scenario asserts the shim is what ran.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repositoryRoot, "dist", "cli", "index.js");
const workflowPath = join(repositoryRoot, "docs", "ci", "approval-check.yml");
const workflowText = readFileSync(workflowPath, "utf8");
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const TIMEOUT = 120_000;

const skip = ["git", SHELL].some((command) => {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
});

// ---------------------------------------------------------------- extraction

/** Reads a workflow-level `env:` value, so the tests use the committed defaults. */
function workflowEnv(key: string): string {
  const match = new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, "m").exec(workflowText);
  if (match === null) throw new Error(`workflow has no env value for ${key}`);
  return match[1]!;
}

/** Extracts a step's `run: |` block scalar by step name, indentation-aware. */
function extractRunScript(stepName: string): string {
  const lines = workflowText.split("\n");
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s+name:\\s+${escaped}\\s*$`).test(line));
  if (start < 0) throw new Error(`no step named ${stepName}`);
  const stepIndent = lines[start]!.search(/\S/);
  const outdented = (index: number, level: number): boolean =>
    lines[index]!.trim() !== "" && lines[index]!.search(/\S/) <= level;
  let end = start + 1;
  while (end < lines.length && !outdented(end, stepIndent)) end += 1;
  let runLine = start + 1;
  while (runLine < end && !/^\s*run:\s*\|\s*$/.test(lines[runLine]!)) runLine += 1;
  if (runLine >= end) throw new Error(`step ${stepName} has no "run: |" block`);
  const runIndent = lines[runLine]!.search(/\S/);
  const body: string[] = [];
  for (let index = runLine + 1; index < end && !outdented(index, runIndent); index += 1) {
    body.push(lines[index]!.trim() === "" ? "" : lines[index]!);
  }
  const indent = Math.min(...body.filter((line) => line !== "").map((line) => line.search(/\S/)));
  return `${body.map((line) => line.slice(indent)).join("\n")}\n`;
}

const MATERIALIZE = extractRunScript("Materialize the base revision");
const CHECK = extractRunScript("Check approval consistency");
const SKILL_DIR = workflowEnv("SKILL_DIR");
const APPROVAL = workflowEnv("APPROVAL");
const SIGILDEX_VERSION = workflowEnv("SIGILDEX_VERSION");

// ------------------------------------------------------------------ fixtures

type FileSpec = string | { content: string; exec?: boolean };
type Files = Record<string, FileSpec>;

interface Side {
  /** Absent means the skill directory does not exist on this side. */
  files?: Files;
  /** Defaults to the workflow's SKILL_DIR / APPROVAL. */
  skillDir?: string;
  approval?: string;
  /** "yes" (default when `files` is set), "no", or "base" to copy the base bytes. */
  lock?: "yes" | "no" | "base";
  /** Lock a different tree than the one written — produces a mismatched record. */
  lockOf?: Files;
  /** Mutates the generated record before it is written. */
  lockEdit?: (record: Record<string, unknown>) => void;
}

const skillFile = (body: string, frontmatter = "name: demo"): string =>
  `---\n${frontmatter}\n---\n${body}\n`;
const V1: Files = { "SKILL.md": skillFile("version one"), "reference/notes.md": "notes\n" };
const V2: Files = {
  "SKILL.md": skillFile("version two"),
  "reference/notes.md": "notes\n",
  "scripts/run.sh": { content: "#!/bin/sh\necho hi\n", exec: true },
};

const IDENTITY = "test@example.invalid";
/** The same skill under a renamed path, for the rename-as-removal-plus-adoption row. */
const MOVED: Side = { files: V1, skillDir: "skills/renamed", approval: "approvals/renamed.lock.json" };

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: IDENTITY,
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: IDENTITY,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
};

function git(args: readonly string[], cwd: string): string {
  const config = ["-c", "user.name=Test", "-c", `user.email=${IDENTITY}`, "-c", "commit.gpgsign=false"];
  return execFileSync("git", [...config, ...args], { cwd, env: GIT_ENV, encoding: "utf8", stdio: "pipe" });
}

function writeTree(root: string, files: Files): void {
  for (const [relative, spec] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof spec === "string" ? spec : spec.content);
    if (typeof spec !== "string" && spec.exec === true) chmodSync(target, 0o755);
  }
}

/** Runs the local build, standing in for the pinned registry install. */
function sigildexLock(cwd: string, skillDir: string, out: string): void {
  execFileSync(process.execPath, [cliPath, "lock", skillDir, "--out", out], { cwd, stdio: "pipe" });
}

/** Writes one side of the pull request into the seed work tree; returns the lock bytes. */
function writeSide(seed: string, scratch: string, side: Side, baseLock: string | null): string | null {
  for (const top of [".claude", ".sigildex"]) rmSync(join(seed, top), { recursive: true, force: true });
  writeFileSync(join(seed, "README.md"), "repository\n");
  const skillDir = side.skillDir ?? SKILL_DIR;
  const approval = side.approval ?? APPROVAL;
  if (side.files !== undefined) writeTree(join(seed, skillDir), side.files);
  const mode = side.lock ?? (side.files === undefined ? "no" : "yes");
  if (mode === "no") return null;
  mkdirSync(dirname(join(seed, approval)), { recursive: true });
  let bytes: string;
  if (mode === "base") {
    if (baseLock === null) throw new Error("no base lock to copy");
    bytes = baseLock;
  } else if (side.lockOf !== undefined) {
    const alternate = mkdtempSync(join(scratch, "alt-"));
    writeTree(join(alternate, skillDir), side.lockOf);
    // §9.3: the output filename must be `<approval_id>.lock.json`, and the id
    // defaults to the skill directory's own name.
    const alternateLock = `${basename(skillDir)}.lock.json`;
    sigildexLock(alternate, skillDir, alternateLock);
    bytes = readFileSync(join(alternate, alternateLock), "utf8");
  } else {
    sigildexLock(seed, skillDir, approval);
    bytes = readFileSync(join(seed, approval), "utf8");
  }
  if (side.lockEdit !== undefined) {
    const record = JSON.parse(bytes) as Record<string, unknown>;
    side.lockEdit(record);
    bytes = `${JSON.stringify(record, null, 2)}\n`;
  }
  writeFileSync(join(seed, approval), bytes);
  return bytes;
}

interface Scenario {
  root: string;
  work: string;
  runner: string;
  baseSha: string;
  summaryPath: string;
  npxLog: string;
  binDir: string;
}

/** Builds origin + base commit + PR head, then a SHALLOW clone of the head. */
function setup(base: Side, head: Side): Scenario {
  const root = mkdtempSync(join(tmpdir(), "sigildex-ci-"));
  const [bare, seed, scratch, runner, binDir, work] = ["origin.git", "seed", "scratch", "runner", "bin", "work"].map(
    (name) => join(root, name),
  ) as [string, string, string, string, string, string];
  for (const dir of [seed, scratch, runner, binDir]) mkdirSync(dir, { recursive: true });

  git(["init", "--bare", "-b", "main", bare], root);
  // GitHub serves arbitrary commits to `git fetch <sha>`; a bare repo must be told to.
  git(["config", "uploadpack.allowAnySHA1InWant", "true"], bare);
  git(["init", "-b", "main", "."], seed);

  const baseLock = writeSide(seed, scratch, base, null);
  git(["add", "-A"], seed);
  git(["commit", "--allow-empty", "-m", "base"], seed);
  const baseSha = git(["rev-parse", "HEAD"], seed).trim();
  git(["push", bare, "main"], seed);

  git(["checkout", "-b", "pr"], seed);
  writeSide(seed, scratch, head, baseLock);
  git(["add", "-A"], seed);
  git(["commit", "--allow-empty", "-m", "head"], seed);
  git(["push", bare, "pr"], seed);
  git(["clone", "--depth=1", "--branch", "pr", `file://${bare}`, work], root);

  const npxLog = join(root, "npx.log");
  const quoted = [npxLog, process.execPath, cliPath].map((value) => JSON.stringify(value));
  writeFileSync(
    join(binDir, "npx"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quoted[0]}\nshift 2\nexec ${quoted[1]} ${quoted[2]} "$@"\n`,
  );
  chmodSync(join(binDir, "npx"), 0o755);
  const summaryPath = join(root, "summary.md");
  writeFileSync(summaryPath, "");
  return { root, work, runner, baseSha, summaryPath, npxLog, binDir };
}

interface Run { code: number; stdout: string; stderr: string }

function runStep(scenario: Scenario, script: string, overrides: Record<string, string | null> = {}): Run {
  const scriptPath = join(scenario.root, `step-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(scriptPath, script);
  const env: Record<string, string> = {
    ...GIT_ENV,
    PATH: `${scenario.binDir}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    SKILL_DIR,
    APPROVAL,
    SIGILDEX_VERSION,
    BASE_SHA: scenario.baseSha,
    RUNNER_TEMP: scenario.runner,
    GITHUB_STEP_SUMMARY: scenario.summaryPath,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  } as Record<string, string>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  try {
    const stdout = execFileSync(SHELL, [scriptPath], { cwd: scenario.work, env, encoding: "utf8", stdio: "pipe" });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

interface JobResult { materialize: Run; check: Run; summary: string; delta: string }

/** Runs both steps in order, exactly as the job does, and returns the outcome. */
function runJob(scenario: Scenario, overrides: Record<string, string | null> = {}): JobResult {
  const materialize = runStep(scenario, MATERIALIZE, overrides);
  const check = runStep(scenario, CHECK, overrides);
  const summary = readFileSync(scenario.summaryPath, "utf8");
  return { materialize, check, summary, delta: join(scenario.runner, "delta.json") };
}

function job(base: Side, head: Side, overrides: Record<string, string | null> = {}): JobResult & { scenario: Scenario } {
  const scenario = setup(base, head);
  return { ...runJob(scenario, overrides), scenario };
}

const SUMMARY_LINES = [
  /^### Skill approval check$/,
  /^\| category \| files \|$/,
  /^\| --- \| --- \|$/,
  /^\| (?:added|removed|changed) \| \d+ \|$/,
  /^\*\*Failed:\*\* \S.*$/,
  /^(?:Skill and approval record|The approval record|Neither the skill|No skill and no)\S*.*$/,
];

/** Every summary line is one of the shapes the snippet is allowed to emit. */
function expectWellFormedSummary(summary: string): void {
  for (const line of summary.split("\n")) {
    if (line === "") continue;
    expect(SUMMARY_LINES.some((pattern) => pattern.test(line)), `unexpected summary line: ${line}`).toBe(true);
  }
  expect(summary).not.toMatch(/[<>]/);
}

/** Asserts the job's exit code, its summary note, and that the summary stayed clean. */
function expectOutcome(result: JobResult, code: number, note: string): void {
  expect(result.check.code).toBe(code);
  expect(result.summary).toContain(note);
  expectWellFormedSummary(result.summary);
}

function counts(summary: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const match of summary.matchAll(/^\| (added|removed|changed) \| (\d+) \|$/gm)) {
    found[match[1]!] = Number(match[2]);
  }
  return found;
}

// --------------------------------------------------------------------- tests

describe("ci snippet harness", () => {
  it("extracts the committed run block rather than a copy", () => {
    expect(CHECK.split("\n").length).toBeGreaterThanOrEqual(50);
    expect(CHECK).toContain('SIGILDEX="npx --yes sigildex@${SIGILDEX_VERSION}"');
    expect(MATERIALIZE).toContain('git fetch --no-tags --depth=1 origin "$BASE_SHA"');
  });

  it("uses no bash-4-only construct, so it runs on the macOS system bash 3.2", () => {
    for (const construct of [/\bdeclare\s+-A\b/, /\bmapfile\b/, /\breadarray\b/, /\$\{[A-Za-z_]+\^\^/, /\$\{[A-Za-z_]+,,/, /\|&/, /&>>/]) {
      expect(CHECK, `bash 4+ construct ${construct}`).not.toMatch(construct);
      expect(MATERIALIZE).not.toMatch(construct);
    }
    for (const script of [CHECK, MATERIALIZE]) {
      const path = join(mkdtempSync(join(tmpdir(), "sigildex-syn-")), "s.sh");
      writeFileSync(path, script);
      expect(() => execFileSync(SHELL, ["-n", path], { stdio: "pipe" })).not.toThrow();
    }
  });

  it.skipIf(skip)("proves the base commit is absent from the shallow clone until the job fetches it", () => {
    const scenario = setup({ files: V1 }, { files: V2 });
    expect(() => git(["cat-file", "-e", scenario.baseSha], scenario.work)).toThrow();
    expect(runStep(scenario, MATERIALIZE).code).toBe(0);
    expect(() => git(["cat-file", "-e", scenario.baseSha], scenario.work)).not.toThrow();
    expect(existsSync(join(scenario.runner, "base", "README.md"))).toBe(true);
  }, TIMEOUT);
});

describe("lifecycle matrix", () => {
  it.skipIf(skip)("row: neither exists -> skill + matching lock (new adoption) passes and defers to a human", () => {
    const result = job({}, { files: V1 });
    expectOutcome(result, 0, "Approval is a human decision, not this result.");
    expect(readFileSync(result.scenario.npxLog, "utf8")).toContain(`--yes sigildex@${SIGILDEX_VERSION}`);
    // No base tree to diff against, so the summary carries no delta table here.
    expect(existsSync(result.delta)).toBe(false);
    expect(counts(result.summary)).toEqual({});
  }, TIMEOUT);

  it.skipIf(skip)("row: skill + valid lock -> skill changed with lock regenerated (update) passes with a delta", () => {
    const result = job({ files: V1 }, { files: V2 });
    expectOutcome(result, 0, "Skill and approval record changed consistently.");
    const report = JSON.parse(readFileSync(result.delta, "utf8")) as Record<string, unknown[]>;
    expect(counts(result.summary)).toEqual({ added: 1, removed: 0, changed: 1 });
    expect(counts(result.summary)).toEqual({
      added: report.added!.length, removed: report.removed!.length, changed: report.changed!.length,
    });
  }, TIMEOUT);

  it.skipIf(skip)("row: skill + valid lock -> neither exists (removal) passes with the removed-together note", () => {
    expectOutcome(job({ files: V1 }, {}), 0, "Skill and approval record removed together.");
  }, TIMEOUT);

  it.skipIf(skip)("row: skill unchanged, lock metadata edited passes as a lock-only change", () => {
    // Same skill bytes on both sides; only the record's `created_at` moves, so
    // the record still matches and identity is untouched.
    const edit = (record: Record<string, unknown>): void => { record.created_at = "2020-01-02T03:04:05Z"; };
    const result = job({ files: V1 }, { files: V1, lock: "base", lockEdit: edit });
    expectOutcome(result, 0, "The approval record changed on its own.");
  }, TIMEOUT);

  it.skipIf(skip)("row: only the skill exists on the head (partial) fails closed", () => {
    expectOutcome(job({ files: V1 }, { files: V2, lock: "no" }), 1, "has no approval record at");
  }, TIMEOUT);

  it.skipIf(skip)("row: only the lock exists on the head (partial) fails closed", () => {
    expectOutcome(job({ files: V1 }, { lock: "base" }), 1, "has no artifact at");
  }, TIMEOUT);

  it.skipIf(skip)("row: base is already partial and the head has neither (partial) fails closed", () => {
    expectOutcome(job({ files: V1, lock: "no" }, {}), 1, "The base revision is already in a partial state");
  }, TIMEOUT);

  it.skipIf(skip)("row: neither side has a skill or a lock is a no-op pass", () => {
    expectOutcome(job({}, {}), 0, "nothing to check");
  }, TIMEOUT);

  it.skipIf(skip)("row: path renamed, OLD path env -> removal pass", () => {
    expectOutcome(job({ files: V1 }, MOVED), 0, "Skill and approval record removed together.");
  }, TIMEOUT);

  it.skipIf(skip)("row: path renamed, NEW path env -> adoption pass", () => {
    const scenario = setup({ files: V1 }, MOVED);
    const result = runJob(scenario, { SKILL_DIR: MOVED.skillDir, APPROVAL: MOVED.approval });
    expectOutcome(result, 0, "Approval is a human decision, not this result.");
  }, TIMEOUT);

  it.skipIf(skip)("row: base skill does not match its base lock fails immediately", () => {
    const result = job({ files: V1, lockOf: V2 }, { files: V1, lock: "base" });
    expectOutcome(result, 1, "The base revision's skill does not match its own approval record.");
    expect(existsSync(result.delta)).toBe(false);
  }, TIMEOUT);
});

describe("gate cases", () => {
  it.skipIf(skip)("gate: skill changed, lock unchanged -> check exit 2 -> job exit 1", () => {
    expectOutcome(job({ files: V1 }, { files: V2, lock: "base" }), 1, "Re-review the skill, then re-run sigildex lock.");
  }, TIMEOUT);

  it.skipIf(skip)("gate: lock changed, skill left mismatched -> job exit 1", () => {
    expectOutcome(job({ files: V1 }, { files: V1, lockOf: V2 }), 1, "does not match");
  }, TIMEOUT);

  it.skipIf(skip)("gate: neither changed -> pass with the neither-changed note", () => {
    expectOutcome(job({ files: V1 }, { files: V1, lock: "base" }), 0, "Neither the skill nor its approval record changed.");
  }, TIMEOUT);

  it.skipIf(skip)("gate: base lock is schema-invalid -> base check exit 3 -> job exit 1", () => {
    const edit = (record: Record<string, unknown>): void => { record.schema_version = 99; };
    const result = job({ files: V1, lockEdit: edit }, { files: V1, lock: "base" });
    expectOutcome(result, 1, "The base revision's skill does not match its own approval record.");
  }, TIMEOUT);
});

describe("identity rules the single-pair snippet does not reach", () => {
  it.skipIf(skip)("passes a record whose approval_id and artifact_path disagree with where it lives", () => {
    // The snippet checks one configured pair. Neither the filename-equals-id
    // rule nor the recorded artifact_path is compared against the real layout.
    const edit = (record: Record<string, unknown>): void => {
      record.approval_id = "not-the-filename";
      record.artifact_path = "somewhere/else";
    };
    expectOutcome(job({ files: V1 }, { files: V2, lockEdit: edit }), 0, "changed consistently");
  }, TIMEOUT);
});

describe("BASE_SHA guard", () => {
  it.skipIf(skip)("fails closed when BASE_SHA is empty (a copy-paste onto push)", () => {
    const result = job({ files: V1 }, { files: V2 }, { BASE_SHA: "" });
    expect(result.materialize.code).not.toBe(0);
    expectOutcome(result, 1, "This workflow requires the pull_request trigger.");
  }, TIMEOUT);

  it.skipIf(skip)("fails closed with a readable message when BASE_SHA is unset", () => {
    const result = job({ files: V1 }, { files: V2 }, { BASE_SHA: null });
    expect(result.check.code).toBe(1);
    expect(result.summary).toContain("BASE_SHA is not a commit in this checkout.");
  }, TIMEOUT);
});

describe("summary and stdout injection", () => {
  const HOSTILE_NAMES: Files = {
    "SKILL.md": skillFile(
      "body EVILMARKER-BODY ::error::pwned ::set-output name=x::y",
      'name: demo\ndescription: "EVILMARKER-FM </table> [link](https://evil.invalid/x) <img src=x onerror=alert(1)>"',
    ),
    "](evil-link).md": "EVILMARKER-FILE\n",
    "pipe|name.md": "EVILMARKER-FILE\n",
    "<img src=x onerror=alert(1)>.md": "EVILMARKER-FILE\n",
    "::error::pwned.md": "EVILMARKER-FILE\n",
    "scripts/run.sh": { content: "#!/bin/sh\n# EVILMARKER-SCRIPT ::error::pwned\n", exec: true },
  };
  const PAYLOADS = [
    "EVILMARKER",
    "](evil-link)",
    "pipe|name",
    "<img src=x",
    "::set-output",
    "onerror=",
    "</table>",
  ];

  it.skipIf(skip)("writes no candidate path, frontmatter, or script text into the job summary", () => {
    const result = job({ files: V1 }, { files: HOSTILE_NAMES });
    expect(result.check.code).toBe(0);
    for (const payload of PAYLOADS) expect(result.summary).not.toContain(payload);
    expectWellFormedSummary(result.summary);
    expect(counts(result.summary).added).toBe(5);
  }, TIMEOUT);

  it.skipIf(skip)("emits no workflow command from candidate content on a passing run", () => {
    const result = job({ files: V1 }, { files: HOSTILE_NAMES });
    for (const line of result.check.stdout.split("\n")) {
      expect(line.trimStart().startsWith("::"), `workflow command on stdout: ${line}`).toBe(false);
    }
    expect(result.check.stdout).not.toContain("EVILMARKER");
  }, TIMEOUT);

  it.skipIf(skip)("echoes candidate paths on the failing drift path but never as a workflow command", () => {
    // `check` for the candidate is intentionally unredirected, so its drift
    // report — which names paths — reaches the log. Every such line is indented
    // behind a marker, so no attacker-chosen path can start a `::` command.
    const scenario = setup({ files: V1 }, { files: HOSTILE_NAMES, lock: "base" });
    const result = runJob(scenario);
    expect(result.check.code).toBe(1);
    expect(result.check.stdout).toContain("::error::");
    const commands = result.check.stdout
      .split("\n")
      .filter((line) => line.trimStart().startsWith("::"));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("does not match");
    for (const payload of PAYLOADS) expect(result.summary).not.toContain(payload);
  }, TIMEOUT);

  it.skipIf(skip)("counts correctly when the candidate frontmatter forges report keys", () => {
    // The JSON delta embeds the candidate's frontmatter verbatim. Frontmatter
    // keys named `added`/`removed` and values holding `class` must not move the
    // numbers the reviewer reads.
    const forged: Files = {
      "SKILL.md": skillFile(
        "version two",
        'name: demo\nadded:\n  - class: pad\n  - class: pad\n  - class: pad\nchanged:\n  - class: pad\nremoved: []',
      ),
      "reference/notes.md": "notes\n",
      "scripts/run.sh": { content: "#!/bin/sh\necho hi\n", exec: true },
    };
    const result = job({ files: V1 }, { files: forged });
    expect(result.check.code).toBe(0);
    const report = JSON.parse(readFileSync(result.delta, "utf8")) as Record<string, unknown[]>;
    expect(counts(result.summary)).toEqual({
      added: report.added!.length,
      removed: report.removed!.length,
      changed: report.changed!.length,
    });
    expect(counts(result.summary)).toEqual({ added: 1, removed: 0, changed: 1 });
  }, TIMEOUT);
});
